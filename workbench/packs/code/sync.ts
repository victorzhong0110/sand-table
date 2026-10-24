// 把一次索引写成派生对象。写入走内部 upsert，不进撤销历史。
//
// 对象编号：新文件是 code:<仓库编号>:<相对路径>，新符号再加 #<名字>:<起始行>。
// 已经存在的旧编号优先复用，避免断开引用。

import {
  applyCommands,
  applySystemCommands,
  CommandError,
  getMeta,
  isPackEnabled,
  toObjectRow,
  toRelationRow,
  type Actor,
  type Command,
  type Db,
  type ObjectRow,
  type ObjectSource,
  type Registry,
  type SystemCommand,
} from "../../kernel/index.ts";
import type { Binding, CodeIndex, CodeItem } from "./indexer.ts";
import { readFile, scan, sourceFor } from "./indexer.ts";
import { digest, openRepo } from "./git.ts";

const BATCH = 200;
const CODE_PACK = "code";
const CALL_BASIS = "源码里的调用表达式。这是索引时的推测，没有运行确认。";

export type SyncResult = {
  repositoryId: string;
  label: string;
  head: string;
  branch: string;
  files: number;
  omitted: string[];
  revision: number;
};

function revisionOf(db: Db): number {
  return Number(getMeta(db, "revision") ?? "0");
}

function clip(value: string, max: number): string {
  const chars = Array.from(value);
  return chars.length <= max ? value : chars.slice(0, max).join("");
}

function runSystem(
  db: Db,
  registry: Registry,
  actor: Actor,
  commands: SystemCommand[],
) {
  for (let index = 0; index < commands.length; index += BATCH)
    applySystemCommands(db, registry, {
      actor,
      commands: commands.slice(index, index + BATCH),
    });
}

function runPublic(
  db: Db,
  registry: Registry,
  actor: Actor,
  commands: Command[],
) {
  for (let index = 0; index < commands.length; index += BATCH)
    applyCommands(db, registry, {
      actor,
      commands: commands.slice(index, index + BATCH),
    });
}

function ensureCodePack(db: Db, registry: Registry, actor: Actor) {
  if (isPackEnabled(db, CODE_PACK)) return;
  applyCommands(db, registry, {
    actor,
    record: false,
    commands: [{ op: "pack.enable", id: CODE_PACK }],
  });
}

function loadCodeRows(db: Db): ObjectRow[] {
  return (
    db
      .prepare(
        `SELECT * FROM objects
         WHERE type IN ('code.repository', 'code.file', 'code.symbol')`,
      )
      .all() as Record<string, unknown>[]
  ).map(toObjectRow);
}

function freshFileId(bindingId: string, filePath: string) {
  return `code:${bindingId}:${filePath}`;
}

function legacyFileId(bindingId: string, filePath: string) {
  return `${bindingId}:${filePath}`;
}

function freshSymbolId(
  bindingId: string,
  filePath: string,
  name: string,
  startLine: number,
) {
  return `code:${bindingId}:${filePath}#${name}:${startLine}`;
}

function legacySymbolId(bindingId: string, filePath: string, name: string) {
  return `${bindingId}:${filePath}#${name}`;
}

function canReuse(row: ObjectRow) {
  return row.id.startsWith("code:") || Boolean(row.source?.external?.uri);
}

function prefer(rows: ObjectRow[]): ObjectRow | undefined {
  return rows.filter(canReuse).sort((left, right) => {
    const leftNew = left.id.startsWith("code:") ? 1 : 0;
    const rightNew = right.id.startsWith("code:") ? 1 : 0;
    if (leftNew !== rightNew) return leftNew - rightNew;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  })[0];
}

function fileMatches(row: ObjectRow, bindingId: string, filePath: string) {
  if (row.type !== "code.file") return false;
  if (
    row.id === freshFileId(bindingId, filePath) ||
    row.id === legacyFileId(bindingId, filePath)
  )
    return true;
  const external = row.source?.external;
  if (
    external?.uri === `sand-code:${bindingId}` &&
    external.fragment === filePath
  )
    return true;
  if (
    external?.uri === `v2-code-entry:${row.id}` &&
    (external.fragment === filePath || row.data.path === filePath) &&
    (row.id === legacyFileId(bindingId, filePath) ||
      row.id.startsWith(`${bindingId}:`))
  )
    return true;
  return false;
}

function symbolMatches(
  row: ObjectRow,
  bindingId: string,
  filePath: string,
  name: string,
  startLine: number,
) {
  if (row.type !== "code.symbol") return false;
  if (
    row.id === freshSymbolId(bindingId, filePath, name, startLine) ||
    row.id === legacySymbolId(bindingId, filePath, name)
  )
    return true;
  const external = row.source?.external;
  const fragment = `${filePath}#${name}:${startLine}`;
  if (
    external?.uri === `sand-code:${bindingId}` &&
    external.fragment === fragment
  )
    return true;
  if (
    external?.uri === `v2-code-entry:${row.id}` &&
    (row.data.name === name || external.fragment === name) &&
    row.id.startsWith(`${bindingId}:${filePath}#`)
  )
    return true;
  return false;
}

function repoMatches(row: ObjectRow, binding: Binding) {
  if (row.type !== "code.repository") return false;
  if (row.id === `code:${binding.id}` || row.id === binding.id) return true;
  return row.source?.external?.uri === binding.root;
}

function inRepo(row: ObjectRow, binding: Binding) {
  if (row.type === "code.repository") return repoMatches(row, binding);
  if (row.type !== "code.file" && row.type !== "code.symbol") return false;
  if (
    row.id === `code:${binding.id}` ||
    row.id.startsWith(`code:${binding.id}:`)
  )
    return true;
  if (row.id === binding.id || row.id.startsWith(`${binding.id}:`)) return true;
  return row.source?.external?.uri === `sand-code:${binding.id}`;
}

function withFingerprint(
  existing: ObjectRow | undefined,
  fresh: ObjectSource,
): ObjectSource {
  const external = existing?.source?.external;
  if (!external?.uri) return fresh;
  return {
    origin: "derived",
    external: {
      ...external,
      ...(fresh.external?.version ? { version: fresh.external.version } : {}),
      ...(fresh.external?.fingerprint
        ? { fingerprint: fresh.external.fingerprint }
        : {}),
    },
  };
}

function aliveRepos(rows: ObjectRow[]) {
  return rows.filter((row) => row.type === "code.repository" && !row.deleted);
}

export function syncBinding(
  db: Db,
  registry: Registry,
  actor: Actor,
  binding: Binding,
  index: CodeIndex,
): SyncResult {
  ensureCodePack(db, registry, actor);
  const rows = loadCodeRows(db);
  const workspace = index.workspaces.find((item) => item.id === binding.id);
  if (!workspace)
    throw new CommandError(
      "INTERNAL",
      "索引结果里没有这个仓库。请重新导入后再试。",
      null,
    );
  const repo = prefer(rows.filter((row) => repoMatches(row, binding)));
  const repositoryId = repo?.id ?? `code:${binding.id}`;
  const files = index.objects.filter(
    (item): item is CodeItem & { source: NonNullable<CodeItem["source"]> } =>
      item.kind === "file" &&
      item.workspaceId === binding.id &&
      item.source !== undefined,
  );
  const symbols = index.objects.filter(
    (item): item is CodeItem & { source: NonNullable<CodeItem["source"]> } =>
      item.kind === "symbol" &&
      item.workspaceId === binding.id &&
      item.source !== undefined,
  );
  const fileIds = new Map<string, string>();
  const symbolIds = new Map<string, string>();
  const keep = new Set<string>([repositoryId]);
  const taken = new Set<string>();
  const commands: SystemCommand[] = [
    {
      op: "object.upsert_derived",
      packId: CODE_PACK,
      id: repositoryId,
      type: "code.repository",
      title: clip(binding.label, 300),
      data: {
        label: clip(binding.label, 200),
        head: clip(workspace.head, 200),
        branch: clip(workspace.branch, 200),
      },
      source: withFingerprint(repo, {
        origin: "derived",
        external: {
          kind: "git",
          uri: binding.root,
          version: workspace.head,
          fingerprint: workspace.snapshot,
        },
      }),
    },
  ];
  for (const file of files) {
    const filePath = file.source.path;
    if (filePath.length > 500) {
      workspace.omitted.push(`${filePath}: path too long`);
      continue;
    }
    const existing = prefer(
      rows.filter((row) => fileMatches(row, binding.id, filePath)),
    );
    let id = existing?.id ?? freshFileId(binding.id, filePath);
    if (taken.has(id)) id = freshFileId(binding.id, filePath);
    taken.add(id);
    keep.add(id);
    fileIds.set(file.id, id);
    commands.push({
      op: "object.upsert_derived",
      packId: CODE_PACK,
      id,
      type: "code.file",
      title: clip(filePath, 300),
      data: { path: filePath, hash: file.source.hash },
      source: withFingerprint(existing, {
        origin: "derived",
        external: {
          kind: "file",
          uri: `sand-code:${binding.id}`,
          fragment: filePath,
          version: workspace.head,
          fingerprint: file.source.hash,
        },
      }),
    });
  }
  for (const symbol of symbols) {
    const filePath = symbol.source.path;
    const name = symbol.title;
    if (
      !name ||
      name.length > 200 ||
      !Number.isInteger(symbol.source.startLine) ||
      symbol.source.startLine < 1
    )
      continue;
    const endLine =
      Number.isInteger(symbol.source.endLine) &&
      symbol.source.endLine >= symbol.source.startLine
        ? symbol.source.endLine
        : symbol.source.startLine;
    const existing = prefer(
      rows.filter((row) =>
        symbolMatches(row, binding.id, filePath, name, symbol.source.startLine),
      ),
    );
    let id =
      existing?.id ??
      freshSymbolId(binding.id, filePath, name, symbol.source.startLine);
    if (taken.has(id))
      id = freshSymbolId(binding.id, filePath, name, symbol.source.startLine);
    if (taken.has(id)) continue;
    taken.add(id);
    keep.add(id);
    symbolIds.set(symbol.id, id);
    commands.push({
      op: "object.upsert_derived",
      packId: CODE_PACK,
      id,
      type: "code.symbol",
      title: clip(name, 300),
      data: {
        name,
        startLine: symbol.source.startLine,
        endLine,
      },
      source: withFingerprint(existing, {
        origin: "derived",
        external: {
          kind: "symbol",
          uri: `sand-code:${binding.id}`,
          fragment: `${filePath}#${name}:${symbol.source.startLine}`,
          version: workspace.head,
          fingerprint: symbol.source.hash,
        },
      }),
    });
  }
  runSystem(db, registry, actor, commands);

  const stale = rows.filter(
    (row) => inRepo(row, binding) && !keep.has(row.id) && !row.deleted,
  );
  runPublic(
    db,
    registry,
    actor,
    stale.map((row) => ({ op: "object.delete" as const, id: row.id })),
  );

  const byId = new Map(loadCodeRows(db).map((row) => [row.id, row]));
  const desired = new Map<
    string,
    {
      kind: string;
      sourceId: string;
      targetId: string;
      status: "confirmed" | "inferred";
      basis?: string;
    }
  >();
  const addEdge = (
    kind: string,
    sourceId: string | undefined,
    targetId: string | undefined,
    status: "confirmed" | "inferred",
    basis?: string,
  ) => {
    if (!sourceId || !targetId || sourceId === targetId) return;
    if (!byId.get(sourceId) || !byId.get(targetId)) return;
    desired.set(`${kind}\0${sourceId}\0${targetId}`, {
      kind,
      sourceId,
      targetId,
      status,
      ...(basis ? { basis } : {}),
    });
  };
  for (const file of files) {
    const target = fileIds.get(file.id);
    addEdge("code.contains", repositoryId, target, "confirmed");
  }
  for (const link of index.relations) {
    if (link.source !== binding.id && !link.source.startsWith(`${binding.id}:`))
      continue;
    if (link.kind === "contains")
      addEdge(
        "code.contains",
        fileIds.get(link.source) ?? symbolIds.get(link.source),
        symbolIds.get(link.target),
        "confirmed",
      );
    if (link.kind === "imports")
      addEdge(
        "code.imports",
        fileIds.get(link.source),
        fileIds.get(link.target),
        "confirmed",
      );
    if (link.kind === "syntactic-call")
      addEdge(
        "code.calls",
        symbolIds.get(link.source),
        symbolIds.get(link.target),
        "inferred",
        CALL_BASIS,
      );
  }
  const relations = (
    db
      .prepare(
        `SELECT * FROM relations
         WHERE deleted_rev IS NULL
           AND kind IN ('code.contains', 'code.imports', 'code.calls')`,
      )
      .all() as Record<string, unknown>[]
  ).map(toRelationRow);
  const present = new Set<string>();
  const removals: Command[] = [];
  for (const relation of relations) {
    const source = byId.get(relation.sourceId);
    const target = byId.get(relation.targetId);
    if (
      !source ||
      !target ||
      !inRepo(source, binding) ||
      !inRepo(target, binding)
    )
      continue;
    const key = `${relation.kind}\0${relation.sourceId}\0${relation.targetId}`;
    present.add(key);
    if (relation.attributes.origin === "index" && !desired.has(key))
      removals.push({ op: "relation.delete", id: relation.id });
  }
  const additions: Command[] = [];
  for (const [key, edge] of desired) {
    if (present.has(key)) continue;
    additions.push({
      op: "relation.create",
      kind: edge.kind,
      sourceId: edge.sourceId,
      targetId: edge.targetId,
      status: edge.status,
      ...(edge.basis ? { basis: edge.basis } : {}),
      attributes: { origin: "index" },
    });
  }
  runPublic(db, registry, actor, [...removals, ...additions]);
  return {
    repositoryId,
    label: binding.label,
    head: workspace.head,
    branch: workspace.branch,
    files: fileIds.size,
    omitted: workspace.omitted,
    revision: revisionOf(db),
  };
}

function repoBinding(row: ObjectRow): Binding | undefined {
  const root = row.source?.external?.uri;
  if (!root || row.source?.external?.kind !== "git") return undefined;
  try {
    const label =
      typeof row.data.label === "string" && row.data.label
        ? row.data.label
        : "project";
    return openRepo(label, root);
  } catch {
    return undefined;
  }
}

export function importRepository(
  db: Db,
  registry: Registry,
  actor: Actor,
  input: { path?: string; workspaceId?: string },
): SyncResult {
  if (Boolean(input.path) === Boolean(input.workspaceId))
    throw new CommandError(
      "INVALID_DATA",
      "请只填写一个仓库路径，或只填写已经导入的仓库编号。",
      null,
    );
  const rows = loadCodeRows(db);
  const repos = aliveRepos(rows);
  let binding: Binding;
  if (input.workspaceId) {
    const found = repos.find((row) => row.id === input.workspaceId);
    const opened = found ? repoBinding(found) : undefined;
    if (!opened)
      throw new CommandError(
        "NOT_FOUND",
        "找不到这个代码仓库。请先导入，或从已导入的仓库里选一个。",
        null,
      );
    binding = opened;
  } else {
    const rootBinding = openRepo("project", input.path!);
    const existing = repos
      .map((row) => ({ row, binding: repoBinding(row) }))
      .find((item) => item.binding?.root === rootBinding.root);
    if (!existing && repos.length >= 4)
      throw new CommandError(
        "LIMIT",
        "最多同时连接 4 个仓库。请先删除不再使用的代码仓库对象，然后再导入。",
        null,
      );
    const labels = new Set(
      repos.map((row) =>
        typeof row.data.label === "string" ? row.data.label : "",
      ),
    );
    const base =
      rootBinding.root
        .split(/[\\/]/)
        .pop()
        ?.replace(/[^a-zA-Z0-9_-]/g, "-")
        .slice(0, 32) || "project";
    const label = labels.has(base)
      ? `${base}-${rootBinding.id.slice(0, 4)}`
      : base;
    binding = existing?.binding ?? openRepo(label, rootBinding.root);
  }
  const opened = repos
    .map((row) => repoBinding(row))
    .filter((item): item is Binding => Boolean(item));
  const bindings = [
    binding,
    ...opened.filter((item) => item.root !== binding.root),
  ];
  const index = scan(bindings);
  let result: SyncResult | undefined;
  for (const item of bindings) {
    const synced = syncBinding(db, registry, actor, item, index);
    if (item.root === binding.root) result = synced;
  }
  if (!result)
    throw new CommandError(
      "INTERNAL",
      "仓库索引没有写完。请再导入一次。",
      null,
    );
  return result;
}

export function refreshRepositories(
  db: Db,
  registry: Registry,
  actor: Actor,
  workspaceId?: string,
): { repositories: SyncResult[]; revision: number } {
  if (!isPackEnabled(db, CODE_PACK))
    throw new CommandError(
      "UNKNOWN_TYPE",
      "代码包没有启用。请在设置里启用「代码」包后再刷新索引。",
      null,
    );
  const repos = aliveRepos(loadCodeRows(db)).filter((row) =>
    workspaceId ? row.id === workspaceId : true,
  );
  const bindings = repos
    .map((row) => repoBinding(row))
    .filter((item): item is Binding => Boolean(item));
  if (workspaceId && !bindings.length)
    throw new CommandError(
      "NOT_FOUND",
      "找不到这个代码仓库，没法刷新。请先导入，或从已导入的仓库里选一个。",
      null,
    );
  if (!bindings.length) return { repositories: [], revision: revisionOf(db) };
  const index = scan(bindings);
  const repositories = bindings.map((binding) =>
    syncBinding(db, registry, actor, binding, index),
  );
  return { repositories, revision: revisionOf(db) };
}

export function readIndexedSource(
  db: Db,
  objectId: string,
  options: { startLine?: number; maxLines?: number },
) {
  const raw = db.prepare("SELECT * FROM objects WHERE id = ?").get(objectId) as
    Record<string, unknown> | undefined;
  if (!raw)
    throw new CommandError(
      "NOT_FOUND",
      "找不到这个代码对象。请先刷新索引，或改用查询结果里的编号。",
      null,
    );
  const object = toObjectRow(raw);
  if (
    object.deleted ||
    (object.type !== "code.file" && object.type !== "code.symbol")
  )
    throw new CommandError(
      "NOT_FOUND",
      "找不到这个代码对象。请先刷新索引，或改用查询结果里的编号。",
      null,
    );
  const rows = loadCodeRows(db);
  const binding = aliveRepos(rows)
    .map((row) => repoBinding(row))
    .filter((item): item is Binding => Boolean(item))
    .find((item) => inRepo(object, item));
  if (!binding)
    throw new CommandError(
      "NOT_FOUND",
      "这个代码对象没有对应的已导入仓库。请先导入仓库后再读取。",
      null,
    );
  const filePath =
    object.type === "code.file"
      ? String(object.data.path ?? "")
      : symbolPath(object, binding.id);
  const hash =
    object.type === "code.file"
      ? String(object.data.hash ?? object.source?.external?.fingerprint ?? "")
      : String(object.source?.external?.fingerprint ?? "");
  const text = readFile(binding, filePath);
  if (digest(text) !== hash)
    throw new CommandError(
      "INVALID_DATA",
      "源码已经变了。请先刷新索引，再读取。",
      null,
    );
  const lineCount = text.split("\n").length;
  const startLine =
    object.type === "code.symbol" ? Number(object.data.startLine ?? 1) : 1;
  const endLine =
    object.type === "code.symbol"
      ? Number(object.data.endLine ?? lineCount)
      : lineCount;
  return sourceFor(
    [binding],
    {
      id: object.id,
      workspaceId: binding.id,
      kind: object.type === "code.symbol" ? "symbol" : "file",
      title: object.title,
      source: {
        workspaceId: binding.id,
        path: filePath,
        startLine,
        endLine,
        hash,
      },
    },
    options,
  );
}

function symbolPath(object: ObjectRow, bindingId: string): string {
  const fragment = object.source?.external?.fragment ?? "";
  const marker = fragment.indexOf("#");
  if (marker > 0) return fragment.slice(0, marker);
  const legacy = object.id.startsWith(`${bindingId}:`)
    ? object.id.slice(bindingId.length + 1)
    : object.id.startsWith(`code:${bindingId}:`)
      ? object.id.slice(`code:${bindingId}:`.length)
      : "";
  const hash = legacy.indexOf("#");
  return hash >= 0 ? legacy.slice(0, hash) : legacy;
}
