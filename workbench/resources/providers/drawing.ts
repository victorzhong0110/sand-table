import type {
  ResourceProvider,
  ResourceRef,
  ResourceRead,
  Unavailable,
} from "../types.ts";

type Session = { id: string; createdAt: number; cwd?: string };
type Scene = {
  elements: {
    type: string;
    text?: string;
    originalText?: string | null;
    rawText?: string;
    isDeleted?: boolean;
  }[];
  appState: Record<string, unknown>;
  files: Record<string, unknown>;
};
type Drawing = {
  id: string;
  sessionId: string;
  sessionFingerprint: { createdAt: number; cwd?: string };
  title: string;
  revision: string;
  sourceSpec: { nodes: { label: string }[] };
  scene?: Scene;
};
type DrawingOutcome =
  | { ok: true; value: { diagram: Drawing } }
  | { ok: false; error: { code: string; current?: Drawing } };
type Lookup = (
  request: { sessionId: string; id: string },
  signal: AbortSignal,
) => Promise<DrawingOutcome>;
type Save = (
  request: {
    sessionId: string;
    id: string;
    expectedRevision: string;
    scene: Scene;
  },
  signal: AbortSignal,
) => Promise<DrawingOutcome>;
type Load = (
  session: Session,
  document: unknown,
  signal: AbortSignal,
) => Promise<Drawing>;

const providerId = "dsh-diagram";
const diagramIdentity =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const capabilities = { read: true, open: true, export: true } as const;
const mediaType = "application/vnd.sand-table.dsh-diagram+json";
const maxDocumentBytes = 8 * 1024 * 1024;

function unavailable(
  ref: ResourceRef,
  status: Unavailable["status"],
  reason: string,
): Unavailable {
  return { ref, status, reason };
}

function key(sessionId: string, createdAt: number, id: string) {
  return Buffer.from(JSON.stringify([sessionId, createdAt, id])).toString(
    "base64url",
  );
}

function parse(ref: ResourceRef) {
  try {
    const value: unknown = JSON.parse(
      Buffer.from(ref.resourceId, "base64url").toString(),
    );
    if (!Array.isArray(value) || value.length !== 3) return;
    const [sessionId, createdAt, id] = value;
    if (
      typeof sessionId === "string" &&
      sessionId &&
      Number.isSafeInteger(createdAt) &&
      createdAt >= 0 &&
      typeof id === "string" &&
      diagramIdentity.test(id) &&
      key(sessionId, createdAt, id) === ref.resourceId
    )
      return { sessionId, createdAt: createdAt as number, id };
  } catch {
    // Resource IDs from imported workspaces are untrusted.
  }
}

export function createDrawingProvider(options: {
  namespace: string;
  get: Lookup;
  getOrigin(): string;
  save: Save;
  load?: Load;
  remove?(
    session: Session,
    id: string,
    expectedRevision: string,
    signal: AbortSignal,
  ): Promise<{ ok: boolean }>;
}) {
  async function importDiagram(
    session: Session,
    text: string,
    signal: AbortSignal,
  ) {
    if (!options.load)
      throw Error("当前绘图插件不支持可编辑导入，请安装兼容包。");
    if (key(session.id, session.createdAt, "0".repeat(36)).length > 512)
      throw Error("当前绘图会话标识过长。");
    if (Buffer.byteLength(text) > maxDocumentBytes)
      throw Error("图稿文件超过 8 MiB。");
    let document;
    try {
      document = JSON.parse(text);
    } catch {
      throw Error("图稿 JSON 格式无效。");
    }
    if (document?.format !== "sand-table.dsh-diagram" || document.version !== 1)
      throw Error("请使用白板导出的 DSH 图稿文件。");
    return options.load(session, document, signal);
  }
  function refFor(diagram: Drawing) {
    const resourceId = key(
      diagram.sessionId,
      diagram.sessionFingerprint.createdAt,
      diagram.id,
    );
    if (resourceId.length > 512) throw Error("当前绘图会话标识过长。");
    return {
      providerId,
      namespace: options.namespace,
      resourceId,
      revision: diagram.revision,
    };
  }

  function readDrawing(diagram: Drawing): ResourceRead {
    const labels = diagram.scene
      ? diagram.scene.elements.flatMap((part) =>
          part.type === "text" && !part.isDeleted && part.text
            ? [part.text]
            : [],
        )
      : diagram.sourceSpec.nodes.map(({ label }) => label);
    return {
      status: "available",
      ref: refFor(diagram),
      revision: diagram.revision,
      title: diagram.title,
      summary: labels.join(" · ").slice(0, 1000) || diagram.title,
      capabilities,
    };
  }

  async function lookup(
    ref: ResourceRef,
    signal = new AbortController().signal,
  ) {
    const id = parse(ref);
    if (
      ref.providerId !== providerId ||
      ref.namespace !== options.namespace ||
      !id
    ) {
      return unavailable(ref, "forbidden", "绘图引用不属于此 DSH 配置。");
    }
    if (ref.anchor)
      return unavailable(ref, "unsupported", "绘图提供者只支持整份图稿。");
    signal.throwIfAborted();
    const result = await options.get(
      { sessionId: id.sessionId, id: id.id },
      signal,
    );
    signal.throwIfAborted();
    if (!result.ok)
      return unavailable(ref, "not_found", "找不到原会话内的图稿。");
    const { diagram } = result.value;
    if (
      diagram.id !== id.id ||
      diagram.sessionId !== id.sessionId ||
      diagram.sessionFingerprint.createdAt !== id.createdAt
    )
      return unavailable(
        ref,
        "forbidden",
        "原绘图会话已换代，无法读取此图稿。",
      );
    if (ref.revision !== undefined && diagram.revision !== ref.revision)
      return unavailable(
        ref,
        "version_unavailable",
        "绘图提供者无法读取固定的旧版本。",
      );
    return {
      status: "available" as const,
      ref: { ...ref, revision: diagram.revision },
      diagram,
    };
  }

  const provider: ResourceProvider = {
    describe: () => ({
      providerId,
      namespace: options.namespace,
      title: "DSH 绘图",
      capabilities,
      idempotency: "none",
    }),
    async read(ref, signal): Promise<ResourceRead> {
      const result = await lookup(ref, signal);
      return result.status === "available"
        ? readDrawing(result.diagram)
        : result;
    },
    async open(ref, signal) {
      const result = await lookup(ref, signal);
      if (result.status !== "available") return result;
      let origin: URL | undefined;
      try {
        origin = new URL(options.getOrigin());
      } catch {
        /* The web host may be stopping. */
      }
      if (
        !origin ||
        origin.hostname !== "127.0.0.1" ||
        origin.username ||
        origin.password ||
        !["http:", "https:"].includes(origin.protocol)
      )
        return unavailable(
          ref,
          "unsupported",
          "绘图编辑器需要通过 DSH 本地 Web 宿主打开。",
        );
      const url = new URL("/diagram-assets/index.html", origin);
      url.searchParams.set("sessionId", result.diagram.sessionId);
      url.searchParams.set("diagramId", result.diagram.id);
      return {
        status: "available",
        ref: result.ref,
        revision: result.diagram.revision,
        route: { kind: "url", url: url.href },
      };
    },
    async export(ref) {
      const result = await lookup(ref);
      if (result.status !== "available") return result;
      if (!result.diagram.scene)
        return unavailable(
          ref,
          "unsupported",
          "请先在绘图编辑器保存场景，再导出可编辑图稿。",
        );
      return {
        status: "available",
        ref: result.ref,
        revision: result.diagram.revision,
        mediaType,
        text: JSON.stringify({
          format: "sand-table.dsh-diagram",
          version: 1,
          sourceSpec: result.diagram.sourceSpec,
          scene: result.diagram.scene,
        }),
      };
    },
    ...(options.load && options.remove
      ? {
          async restore(file, session, signal) {
            if (file.mediaType !== mediaType)
              throw Error("组合里的图稿文件格式不受支持。");
            const diagram = await importDiagram(session, file.text, signal);
            return {
              ref: refFor(diagram),
              async discard() {
                const removed = await options.remove!(
                  session,
                  diagram.id,
                  diagram.revision,
                  AbortSignal.timeout(5000),
                );
                if (!removed.ok) throw Error("未能清理导入的图稿副本。");
              },
            };
          },
        }
      : {}),
  };

  async function reference(
    session: Session,
    diagramId: string,
    signal?: AbortSignal,
  ) {
    if (!diagramIdentity.test(diagramId))
      throw Error("请传入有效的 DSH 图稿 ID。");
    const resourceId = key(session.id, session.createdAt, diagramId);
    if (resourceId.length > 512) throw Error("当前绘图会话标识过长。");
    const result = await lookup(
      { providerId, namespace: options.namespace, resourceId },
      signal,
    );
    if (result.status !== "available") throw Error(result.reason);
    if (result.diagram.sessionFingerprint.cwd !== session.cwd)
      throw Error("当前会话的工作目录与原图不一致。");
    return result;
  }

  return {
    provider,
    async reference(session: Session, diagramId: string, signal: AbortSignal) {
      const result = await reference(session, diagramId, signal);
      return {
        ref: result.ref,
        revision: result.diagram.revision,
        title: result.diagram.title,
      };
    },
    async replaceLabel(
      session: Session,
      input: {
        diagramId: string;
        expectedRevision: string;
        before: string;
        after: string;
      },
      signal: AbortSignal,
    ) {
      if (
        !input.before ||
        !input.after ||
        input.before.length > 1000 ||
        input.after.length > 1000
      )
        throw Error("请输入有效的原标签和新标签，最长为 1000 字符。");
      const { diagram, ref } = await reference(
        session,
        input.diagramId,
        signal,
      );
      const conflict = (current?: Drawing) => ({
        status: "conflict" as const,
        current: current ? readDrawing(current) : null,
        candidate: { before: input.before, after: input.after },
      });
      if (diagram.revision !== input.expectedRevision) return conflict(diagram);
      if (!diagram.scene) throw Error("请先在绘图编辑器保存图稿。");
      const elements = diagram.scene.elements;
      const target = elements.filter(
        (part) =>
          part.type === "text" &&
          !part.isDeleted &&
          (part.originalText ?? part.text) === input.before,
      );
      if (target.length !== 1)
        throw Error("找不到唯一匹配的标签，请在绘图编辑器确认。");
      const scene = {
        ...diagram.scene,
        elements: elements.map((part) =>
          part !== target[0]
            ? part
            : {
                ...part,
                text: input.after,
                originalText: input.after,
                ...(part.rawText === undefined ? {} : { rawText: input.after }),
              },
        ),
      };
      const result = await options.save(
        {
          id: diagram.id,
          sessionId: diagram.sessionId,
          expectedRevision: input.expectedRevision,
          scene,
        },
        signal,
      );
      if (result.ok) return readDrawing(result.value.diagram);
      if (result.error.code === "version-conflict") {
        if (result.error.current) return conflict(result.error.current);
        const latest = await lookup({ ...ref, revision: undefined }, signal);
        return conflict(
          latest.status === "available" ? latest.diagram : undefined,
        );
      }
      throw Error(
        `绘图插件保存失败（${result.error.code}），请检查原图后继续。`,
      );
    },
    async importDocument(session: Session, text: string, signal: AbortSignal) {
      return readDrawing(await importDiagram(session, text, signal));
    },
  };
}
