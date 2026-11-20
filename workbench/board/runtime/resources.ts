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
  const cache = new Map<ComponentResource, Promise<void>>();
  const globals = globalThis as typeof globalThis & {
    pdfjsWorker?: { WorkerMessageHandler?: unknown };
    sandTablePdf?: { getDocument: typeof getDocument };
  };

  function loadComponentResource(name: ComponentResource): Promise<void> {
    workspace.signal.throwIfAborted();
    const uri = componentResourceUri(name);
    const key = COMPONENT_RESOURCES[name].global;
    if (globals[key]) return Promise.resolve();
    const pending = cache.get(name);
    if (pending) return pending;
    const ready = read(uri, workspace.signal)
      .then(({ contents }) => {
        workspace.signal.throwIfAborted();
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
      .catch((error) => {
        cache.delete(name);
        throw error;
      });
    cache.set(name, ready);
    return ready;
  }

  const tasks = new Set<PDFDocumentLoadingTask>();
  const release = async (task: PDFDocumentLoadingTask) => {
    if (tasks.delete(task)) await task.destroy();
  };
  async function createPdfWorker() {
    await loadComponentResource("pdf-worker");
    await loadComponentResource("pdf-api");
    workspace.signal.throwIfAborted();
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
