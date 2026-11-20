import { createHash } from "node:crypto";
import {
  isResourceRef,
  MAX_BUNDLE_JSON_BYTES,
  WORKSPACE_BUNDLE_FORMAT,
  WORKSPACE_BUNDLE_VERSION,
  type ResourceRef,
} from "../../kernel/index.ts";
import type { ResourceRegistry } from "../../resources/registry.ts";
import type { ResourceRestoreOwner } from "../../resources/types.ts";

type CompositionMode = "full" | "references";

function referenceKey(ref: ResourceRef) {
  return JSON.stringify([
    ref.providerId,
    ref.namespace,
    ref.resourceId,
    ref.revision,
    ref.anchor,
  ]);
}

const format = "sand-table-workspace-composition";
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
function workspaceParts(board: any) {
  if (
    board?.format !== WORKSPACE_BUNDLE_FORMAT ||
    board.formatVersion !== WORKSPACE_BUNDLE_VERSION ||
    !Array.isArray(board.objects) ||
    !Array.isArray(board.external)
  )
    throw Error("需要工作台当前导出的工作空间快照。");
  const found = new Map<string, { ref: ResourceRef; objectIds: string[] }>();
  const ids = new Set<string>();
  for (const object of board.objects) {
    if (typeof object?.id !== "string" || ids.has(object.id))
      throw Error("工作空间有无效或重复的对象编号。");
    ids.add(object.id);
    const source = object.source?.resource;
    if (source == null) continue;
    if (!isResourceRef(source))
      throw Error("工作空间内有无效资源引用，请先修正引用。");
    const key = referenceKey(source);
    const previous = found.get(key);
    if (previous) previous.objectIds.push(object.id);
    else found.set(key, { ref: source, objectIds: [object.id] });
  }
  return found;
}

export async function exportComposition(
  raw: string,
  resources: Pick<ResourceRegistry, "read" | "export">,
  mode: CompositionMode,
  signal?: AbortSignal,
) {
  if (mode !== "full" && mode !== "references")
    throw Error("请选择完整组合或仅引用清单。");
  if (Buffer.byteLength(raw) > MAX_BUNDLE_JSON_BYTES)
    throw Error("白板内容超过 300 MiB，无法创建组合。");
  const board = JSON.parse(raw);
  const found = workspaceParts(board);
  const header = {
    format,
    version: 1,
    sourceWorkspace: board.workspace,
    mode,
  };
  const references = [...found.values()];
  if (mode === "references")
    return JSON.stringify({
      ...header,
      references,
      external: board.external,
    });
  if (board.external.length)
    throw Error(
      "工作空间含有未经资源插件管理的外部来源，无法取得完整字节。可以另行导出引用清单。",
    );

  const payload = [];
  let total = Buffer.byteLength(raw);
  for (const entry of references) {
    signal?.throwIfAborted();
    const current = await resources.read(entry.ref, signal);
    if (current.status !== "available")
      throw Error(
        `资源 ${entry.ref.providerId} 无法读取，完整组合没有生成。原因：${current.reason}`,
      );
    const exact = { ...entry.ref, revision: current.revision };
    if (!exact.revision || !isResourceRef(exact))
      throw Error("原插件没有返回可固定的资源版本。");
    const file = await resources.export(exact);
    signal?.throwIfAborted();
    if (file.status !== "available")
      throw Error(
        `资源 ${entry.ref.providerId} 无法导出指定版本。原因：${file.reason}`,
      );
    if (
      file.revision !== exact.revision ||
      typeof file.text !== "string" ||
      !file.text.length ||
      typeof file.mediaType !== "string" ||
      !file.mediaType.length
    )
      throw Error("原插件没有返回指定版本的文件字节，完整组合没有生成。");
    total += Buffer.byteLength(file.text);
    if (total > MAX_BUNDLE_JSON_BYTES) throw Error("完整组合超过 300 MiB。");
    payload.push({
      ...entry,
      exact,
      mediaType: file.mediaType,
      sha256: digest(file.text),
      text: file.text,
    });
  }
  const output = JSON.stringify({
    ...header,
    workspace: board,
    resources: payload,
  });
  if (Buffer.byteLength(output) > MAX_BUNDLE_JSON_BYTES)
    throw Error("完整组合超过 300 MiB。");
  return output;
}

export async function importComposition<T>(
  raw: string,
  resources: Pick<ResourceRegistry, "restorer">,
  resolveOwner: () => Promise<ResourceRestoreOwner>,
  writeWorkspace: (json: string) => T,
  signal: AbortSignal,
): Promise<T> {
  if (Buffer.byteLength(raw) > MAX_BUNDLE_JSON_BYTES)
    throw Error("完整组合超过 300 MiB。");
  const archive = JSON.parse(raw);
  if (
    archive?.format !== format ||
    archive.version !== 1 ||
    archive.mode !== "full" ||
    !Array.isArray(archive.resources)
  )
    throw Error("请选择完整的 Sand Table 组合包。引用清单不能恢复资源正文。");
  const board = archive.workspace;
  const expected = workspaceParts(board);
  if (board.external.length || expected.size !== archive.resources.length)
    throw Error("组合包的资源清单与工作空间不一致。");
  const hashes = new Map<string, string>();
  const serializedEntries: unknown[] = archive.resources;
  const entries = serializedEntries.map((value) => {
    if (typeof value !== "object" || value === null)
      throw Error("组合包包含无效的资源条目。");
    const entry = value as Record<string, unknown>;
    if (
      !isResourceRef(entry?.ref) ||
      !isResourceRef(entry.exact) ||
      !entry.exact.revision ||
      referenceKey({ ...entry.ref, revision: entry.exact.revision }) !==
        referenceKey(entry.exact) ||
      (entry.ref.revision && entry.ref.revision !== entry.exact.revision) ||
      typeof entry.mediaType !== "string" ||
      !entry.mediaType ||
      typeof entry.text !== "string" ||
      !entry.text ||
      digest(entry.text) !== entry.sha256
    )
      throw Error("组合包包含无效的资源版本或文件校验值。");
    const key = referenceKey(entry.ref);
    const original = expected.get(key);
    if (
      !original ||
      JSON.stringify(entry.objectIds) !== JSON.stringify(original.objectIds)
    )
      throw Error("组合包的资源清单与白板引用不一致。");
    expected.delete(key);
    const exactKey = referenceKey(entry.exact);
    const fingerprint = JSON.stringify([entry.sha256, entry.mediaType]);
    if (hashes.has(exactKey) && hashes.get(exactKey) !== fingerprint)
      throw Error("组合包为同一资源版本提供了不同文件。");
    hashes.set(exactKey, fingerprint);
    const restore = resources.restorer(entry.exact);
    if (!restore)
      throw Error(`当前没有可导入 ${entry.exact.providerId} 的资源插件。`);
    return {
      original,
      exactKey,
      restore,
      file: {
        text: entry.text,
        mediaType: entry.mediaType,
      },
    };
  });
  const created: Array<{ ref: ResourceRef; discard(): Promise<void> }> = [];
  try {
    const copies = new Map<string, ResourceRef>();
    const restored = new Map<string, ResourceRef>();
    const owner = entries.length ? await resolveOwner() : undefined;
    for (const entry of entries) {
      signal.throwIfAborted();
      let ref = restored.get(entry.exactKey);
      if (!ref) {
        const copy = await entry.restore(entry.file, owner!, signal);
        created.push(copy);
        ref = copy.ref;
        restored.set(entry.exactKey, ref);
      }
      for (const id of entry.original.objectIds) copies.set(id, ref);
    }
    for (const object of board.objects) {
      const copy = copies.get(object.id);
      if (copy) object.source.resource = copy;
    }
    signal.throwIfAborted();
    return writeWorkspace(JSON.stringify(board));
  } catch (error) {
    const reverts = await Promise.allSettled(
      created.map((entry) => entry.discard()),
    );
    const failures = reverts.filter(
      (revert) => revert.status === "rejected",
    ).length;
    if (failures)
      throw Error(`导入失败，另有 ${failures} 份已创建的资源副本需要清理。`, {
        cause: error,
      });
    throw error;
  }
}
