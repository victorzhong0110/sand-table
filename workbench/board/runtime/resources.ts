import { createContext, useContext } from "react";
import {
  COMPONENT_RESOURCES,
  COMPONENT_RESOURCE_MIME,
  componentResourceUri,
  type ComponentResource,
} from "../../core/component-resources.ts";
import type { getDocument, PDFDocumentLoadingTask } from "pdfjs-dist";

type ChunkRead = (
  uri: string,
  signal: AbortSignal,
) => Promise<{
  contents: Array<{ uri: string; mimeType?: string; text?: string }>;
}>;

export function createComponentRuntime(read: ChunkRead) {
  const workspace = new AbortController();
  const cache = new Map<
    ComponentResource,
    {
      controller: AbortController;
      consumers: number;
      ready: Promise<void>;
    }
  >();
  const globals = globalThis as typeof globalThis & {
    pdfjsWorker?: { WorkerMessageHandler?: unknown };
    sandTableGraphLayout?: typeof import("@dagrejs/dagre");
    sandTablePdf?: { getDocument: typeof getDocument };
    sandTableChart?: unknown;
    sandTableCompare?: unknown;
  };

  function startLoad(name: ComponentResource, uri: string) {
    const key = COMPONENT_RESOURCES[name].global;
    const controller = new AbortController();
    const active = AbortSignal.any([workspace.signal, controller.signal]);
    const ready = read(uri, active)
      .then(({ contents }) => {
        active.throwIfAborted();
        const item = contents.find(
          (value) =>
            value.uri === uri && value.mimeType === COMPONENT_RESOURCE_MIME,
        );
        if (!item?.text) throw Error("宿主暂时不能提供组件资源，请稍后重试。");
        if (!globals[key]) {
          const script = document.createElement("script");
          script.textContent = item.text;
          document.head.append(script);
          script.remove();
        }
        if (!globals[key])
          throw Error("组件资源未能注册，请检查宿主的加载能力。");
      })
      .finally(() => {
        if (cache.get(name) === entry) cache.delete(name);
      });
    const entry = { controller, consumers: 0, ready };
    cache.set(name, entry);
    return entry;
  }

  function loadComponentResource(
    name: ComponentResource,
    signal?: AbortSignal,
  ): Promise<void> {
    workspace.signal.throwIfAborted();
    signal?.throwIfAborted();
    const uri = componentResourceUri(name);
    if (globals[COMPONENT_RESOURCES[name].global]) return Promise.resolve();
    const entry = cache.get(name) ?? startLoad(name, uri);
    entry.consumers++;
    if (!signal) return entry.ready;
    return new Promise((resolve, reject) => {
      const finish = () => {
        signal.removeEventListener("abort", abort);
        entry.consumers--;
      };
      const abort = () => {
        finish();
        if (entry.consumers === 0 && cache.get(name) === entry) {
          cache.delete(name);
          entry.controller.abort(signal.reason);
        }
        reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      void entry.ready.then(
        () => {
          if (!signal.aborted) {
            finish();
            resolve();
          }
        },
        (error) => {
          if (!signal.aborted) {
            finish();
            reject(error);
          }
        },
      );
    });
  }

  const tasks = new Set<PDFDocumentLoadingTask>();
  const release = async (task: PDFDocumentLoadingTask) => {
    if (tasks.delete(task)) await task.destroy();
  };
  async function createPdfWorker(signal?: AbortSignal) {
    await loadComponentResource("pdf-worker", signal);
    await loadComponentResource("pdf-api", signal);
    workspace.signal.throwIfAborted();
    signal?.throwIfAborted();
    const api = globals.sandTablePdf!;
    const owned = new Set<PDFDocumentLoadingTask>();
    let closed = false;
    return {
      open(data: Uint8Array) {
        workspace.signal.throwIfAborted();
        if (closed) throw Error("PDF 阅读器已关闭。");
        const options = {
          data,
          disableFontFace: true,
          isEvalSupported: false,
          useSystemFonts: false,
          useWasm: false,
        };
        const task = api.getDocument(options);
        owned.add(task);
        tasks.add(task);
        return {
          document: task.promise,
          destroy: async () => {
            owned.delete(task);
            await release(task);
          },
        };
      },
      async destroy() {
        closed = true;
        const pending = [...owned];
        owned.clear();
        await Promise.all(pending.map(release));
      },
    };
  }
  return {
    loadComponentResource,
    createPdfWorker,
    dispose() {
      workspace.abort();
      cache.clear();
      void Promise.allSettled([...tasks].map(release));
    },
  };
}

export const ComponentRuntimeContext = createContext<ReturnType<
  typeof createComponentRuntime
> | null>(null);

export function useComponentRuntime() {
  return useContext(ComponentRuntimeContext);
}
