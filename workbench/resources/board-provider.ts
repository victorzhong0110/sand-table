import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import {
  applyCommands,
  readObjects,
  summarize,
  type CommandResult,
  type Db,
  type Registry,
} from "../kernel/index.ts";
import type {
  ResourceProvider,
  ResourceRef,
  ResourceRead,
  ResourceEdit,
} from "./types.ts";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}

export const BOARD_PROVIDER_ID = "sand-table.board";
export function boardNamespace(root: string, workspaceId: string) {
  return `workspace:${createHash("sha256").update(realpathSync(root)).digest("hex")}:${workspaceId}`;
}

export function createBoardProvider(options: {
  db: Db;
  registry: Registry;
  namespace: string;
  workspaceId: string;
  afterWrite?: (result: CommandResult) => void;
}): ResourceProvider {
  const { db, registry, namespace, workspaceId } = options;
  const capabilities = { read: true as const, open: true, edit: true };
  const receipts = new Map<
    string,
    { fingerprint: string; value: ResourceRead }
  >();
  const description = {
    providerId: BOARD_PROVIDER_ID,
    namespace,
    title: "白板原生文档",
    capabilities,
    idempotency: "process" as const,
  };
  const unavailable = (
    ref: ResourceRef,
    status: "forbidden" | "not_found" | "version_unavailable" | "unsupported",
    reason: string,
  ) => ({ ref, status, reason });
  const load = (ref: ResourceRef) => {
    if (ref.providerId !== BOARD_PROVIDER_ID || ref.namespace !== namespace)
      return unavailable(
        ref,
        "forbidden",
        "资源不属于这个工作空间，请回到原工作空间读取。",
      );
    const row = readObjects(db, registry, [ref.resourceId], {
      textLimit: 1,
      include: ["presentations"],
    }).objects[0];
    if (!row)
      return unavailable(
        ref,
        "not_found",
        "原生对象已删除或不存在；引用仍保留。",
      );
    if (ref.revision !== undefined && ref.revision !== String(row.version))
      return unavailable(
        ref,
        "version_unavailable",
        "无法读取指定历史版本；请保留固定版本，或明确改为跟随当前版本。",
      );
    if (ref.anchor !== undefined)
      return unavailable(
        ref,
        "unsupported",
        "白板提供者还不支持片段定位，请引用整个对象。",
      );
    return row;
  };
  const read = (ref: ResourceRef): ResourceRead => {
    const row = load(ref);
    if ("status" in row) return row;
    // 摘要读取有独立预算，不携带全文、附件或关系扩展。
    const content = readObjects(db, registry, [ref.resourceId], {
      textLimit: 1000,
      include: [],
    }).objects[0];
    return {
      status: "available",
      ref,
      revision: String(row.version),
      title: row.title.slice(0, 200),
      summary: summarize(
        registry.getType(row.type),
        content.data,
        row.title,
      ).slice(0, 1000),
      capabilities,
    };
  };
  return {
    describe: () => description,
    read,
    open(ref) {
      const row = load(ref);
      if ("status" in row) return row;
      const place = row.presentations[0];
      if (!place)
        return unavailable(
          ref,
          "unsupported",
          "对象尚未摆在白板上，请先添加展示。",
        );
      return {
        status: "available",
        ref,
        revision: String(row.version),
        route: {
          kind: "board-object",
          workspaceId,
          boardId: place.boardId,
          objectId: row.id,
          presentationId: place.id,
        },
      };
    },
    edit(ref, request: ResourceEdit) {
      if (!request.operationId.trim() || request.operationId.length > 200)
        throw Error("请提供不超过 200 字符的操作编号。");
      if (
        !request.operation ||
        typeof request.operation !== "object" ||
        Object.keys(request.operation).some(
          (key) => !["title", "set", "unset"].includes(key),
        )
      )
        throw Error("资源修改只能包含标题、字段赋值和字段删除。");
      const key = JSON.stringify([ref.resourceId, request.operationId]);
      const fingerprint = JSON.stringify(
        canonical([
          ref,
          request.expectedRevision,
          request.actor,
          request.operation,
        ]),
      );
      const previous = receipts.get(key);
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw Error("同一操作编号不能用于不同修改，请生成新编号。");
        return structuredClone(previous.value);
      }
      if (receipts.size >= 5000)
        throw Error(
          "本次提供者实例的修改记录已满，请重新连接后再创建新操作；不要重试结果未知的旧操作。",
        );
      const row = load(ref);
      if ("status" in row) return row;
      if (request.expectedRevision !== String(row.version))
        return unavailable(
          ref,
          "version_unavailable",
          "对象已变化，请重新读取并确认修改。",
        );
      const result = applyCommands(db, registry, {
        actor: request.actor,
        label: "资源修改",
        commands: [
          {
            op: "object.update",
            id: row.id,
            expectedVersion: row.version,
            ...request.operation,
          },
        ],
      });
      const value = read({
        ...ref,
        ...(ref.revision === undefined
          ? {}
          : { revision: String(row.version + 1) }),
      });
      receipts.set(key, { fingerprint, value: structuredClone(value) });
      options.afterWrite?.(result);
      return value;
    },
  };
}
