import { getMeta, setMeta, transaction, type Db } from "./db.ts";
import { CommandError } from "./errors.ts";
import { historyKind, recordHistory } from "./history-record.ts";
import { newId } from "./ids.ts";
import { makeLabel, type LabelLookup } from "./labels.ts";
import { isPackEnabled } from "./packs-state.ts";
import { createRegistry, PackSpecError, type Registry } from "./registry.ts";
import { toObjectRow, toPresentationRow, toRelationRow } from "./rows.ts";
import type {
  Actor,
  Change,
  Command,
  CommandBatch,
  CommandResult,
  ExternalLocator,
  ObjectRow,
  ObjectSource,
  Snapshot,
  SystemCommand,
  SystemCommandBatch,
} from "./types.ts";

const BATCH_LIMIT = 200;
const TITLE_LIMIT = 300;
const DATA_LIMIT = 1024 * 1024;
const MANIFEST_LIMIT = 256 * 1024;
const TEMPLATE_DEPTH = 8;
const SLOTS = [
  "id",
  "boardId",
  "objectId",
  "parentId",
  "sourceId",
  "targetId",
] as const;
const PUBLIC_OPS = new Set([
  "object.create",
  "object.update",
  "object.delete",
  "object.clone",
  "presentation.create",
  "presentation.update",
  "presentation.delete",
  "relation.create",
  "relation.update",
  "relation.delete",
  "setting.set",
  "pack.enable",
  "pack.disable",
  "pack.import",
  "pack.remove",
  "template.apply",
]);
const SYSTEM_OPS = new Set(["pack.sync_builtin", "object.upsert_derived"]);
const ORIGINS = new Set([
  "human",
  "imported",
  "ai-generated",
  "ai-inferred",
  "derived",
]);
const BASE_TYPE: Record<string, string> = {
  text: "base.note",
  heading: "base.heading",
  code: "base.code_snippet",
  metric: "base.metric",
  status: "base.status",
  chart: "base.chart",
  table: "base.table",
  events: "base.events",
  task: "base.task",
  reasoning: "base.reasoning",
  comparison: "base.comparison",
};

type AnyCommand = Command | SystemCommand;
type TableName = Change["table"];

type Ctx = {
  db: Db;
  staged: Registry;
  actor: Actor;
  rev: number;
  now: number;
  refs: Map<string, string>;
  created: Record<string, string>;
  changed: CommandResult["changed"];
  changes: Change[];
  warnings: CommandResult["warnings"];
  afterCommit: Array<() => void>;
  templateStack: string[];
  registry: Registry;
};

export function applyCommands(
  db: Db,
  registry: Registry,
  batch: CommandBatch,
): CommandResult {
  assertActor(batch.actor);
  assertBatch(batch.commands);
  return run(db, registry, batch.actor, batch.commands, "public", {
    record: batch.record !== false,
    label: batch.label,
    intentId: batch.intentId,
  });
}

export function applySystemCommands(
  db: Db,
  registry: Registry,
  batch: SystemCommandBatch,
): CommandResult {
  assertActor(batch.actor);
  assertBatch(batch.commands);
  return run(db, registry, batch.actor, batch.commands, "system", {
    record: false,
  });
}

export function parsePublicCommands(input: unknown): Command[] {
  if (!Array.isArray(input))
    throw new CommandError("INVALID_DATA", "命令必须是数组。", null);
  return input.map((item, index) => {
    if (!plain(item) || typeof item.op !== "string")
      throw new CommandError("INVALID_DATA", "每一条命令都必须带 op。", index);
    if (SYSTEM_OPS.has(item.op))
      throw new CommandError("FORBIDDEN", "这条命令不能从外部提交。", index);
    if (!PUBLIC_OPS.has(item.op))
      throw new CommandError(
        "INVALID_DATA",
        `不认识的命令「${item.op}」。`,
        index,
      );
    return item as Command;
  });
}

function run(
  db: Db,
  registry: Registry,
  actor: Actor,
  commands: AnyCommand[],
  mode: "public" | "system",
  options: { record: boolean; label?: string; intentId?: string },
): CommandResult {
  const staged = stageRegistry(registry);
  const afterCommit: Array<() => void> = [];
  try {
    const result = transaction(db, () =>
      executeAll(
        db,
        registry,
        staged,
        actor,
        commands,
        mode,
        options,
        afterCommit,
      ),
    );
    for (const job of afterCommit) job();
    return result;
  } catch (error) {
    if (error instanceof CommandError) throw error;
    throw asInternal(error);
  }
}

function executeAll(
  db: Db,
  registry: Registry,
  staged: Registry,
  actor: Actor,
  commands: AnyCommand[],
  mode: "public" | "system",
  options: { record: boolean; label?: string; intentId?: string },
  afterCommit: Array<() => void>,
): CommandResult {
  const current = Number(getMeta(db, "revision") ?? "0");
  if (!Number.isInteger(current))
    throw new CommandError("INTERNAL", "修订号损坏，已停止写入。", null);
  const ctx: Ctx = {
    db,
    staged,
    actor,
    rev: current + 1,
    now: Date.now(),
    refs: new Map(),
    created: {},
    changed: [],
    changes: [],
    warnings: [],
    afterCommit,
    templateStack: [],
    registry,
  };
  commands.forEach((command, index) => {
    const op = command.op;
    if (mode === "public" && SYSTEM_OPS.has(op))
      throw new CommandError("FORBIDDEN", "这条命令不能从外部提交。", index);
    if (mode === "system" && !SYSTEM_OPS.has(op))
      throw new CommandError(
        "FORBIDDEN",
        "内部写入只接受内置包同步和派生对象更新。",
        index,
      );
    if (command.op === "template.apply") {
      const expanded = expandTemplate(ctx, command, index, 0, 0);
      expanded.forEach((inner, innerIndex) => {
        execute(
          ctx,
          resolveRefs(ctx, inner, index),
          index,
          `${index}.${innerIndex}`,
        );
      });
      return;
    }
    execute(
      ctx,
      mode === "public" ? resolveRefs(ctx, command, index) : command,
      index,
      String(index),
    );
  });
  setMeta(db, "revision", String(ctx.rev));
  let historyId: string | null = null;
  if (options.record) {
    const recordable = ctx.changes.filter((change) => shouldRecord(db, change));
    if (recordable.length > 0) {
      const publicCommands = commands as Command[];
      const batch: CommandBatch = {
        actor,
        intentId: options.intentId ?? newId(),
        label: options.label,
        commands: publicCommands,
        record: true,
      };
      historyId = recordHistory(
        db,
        batch,
        recordable,
        makeLabel(publicCommands, options.label, lookup(ctx)),
        historyKind(publicCommands),
        ctx.now,
      );
    }
  }
  db.prepare(
    `INSERT INTO audit (at, actor, actor_kind, action, history_id, detail)
     VALUES (?, ?, ?, 'apply', ?, ?)`,
  ).run(
    ctx.now,
    actor.id,
    actor.kind,
    historyId,
    JSON.stringify({ commands: commands.length, revision: ctx.rev }),
  );
  return {
    revision: ctx.rev,
    historyId,
    created: ctx.created,
    changed: ctx.changed,
    warnings: ctx.warnings,
  };
}

function execute(
  ctx: Ctx,
  command: AnyCommand,
  index: number,
  createdKey: string,
) {
  switch (command.op) {
    case "object.create":
      return createObject(ctx, command, index, createdKey);
    case "object.update":
      return updateObject(ctx, command, index);
    case "object.delete":
      return deleteObject(ctx, command, index);
    case "object.clone":
      return cloneObject(ctx, command, index, createdKey);
    case "presentation.create":
      return createPresentation(ctx, command, index, createdKey);
    case "presentation.update":
      return updatePresentation(ctx, command, index);
    case "presentation.delete":
      return deletePresentation(ctx, command, index);
    case "relation.create":
      return createRelation(ctx, command, index, createdKey);
    case "relation.update":
      return updateRelation(ctx, command, index);
    case "relation.delete":
      return deleteRelation(ctx, command, index);
    case "setting.set":
      return setSetting(ctx, command, index);
    case "pack.enable":
      return setPackEnabled(ctx, command.id, true, index);
    case "pack.disable":
      return setPackEnabled(ctx, command.id, false, index);
    case "pack.import":
      return importPack(ctx, command.manifest, index);
    case "pack.remove":
      return removePack(ctx, command.id, index);
    case "pack.sync_builtin":
      return syncBuiltin(ctx, command, index);
    case "object.upsert_derived":
      return upsertDerived(ctx, command, index);
    default:
      throw new CommandError("INVALID_DATA", "不认识的命令。", index);
  }
}

function createObject(
  ctx: Ctx,
  command: Extract<Command, { op: "object.create" }>,
  index: number,
  createdKey: string,
) {
  const spec = requireType(ctx, command.type, index);
  const title = command.title ?? "";
  assertTitle(title, index);
  const data = command.data ?? {};
  assertPlainData(data, index);
  const json = assertDataSize(data, index);
  const validated = ctx.staged.validateData(command.type, data);
  if (!validated.ok) throwData(validated.errors, index);
  if (command.source) assertSource(command.source, index);
  const id = newId();
  ctx.db
    .prepare(
      `INSERT INTO objects (
         id, type, type_version, title, data, source, version,
         created_at, created_by, updated_at, updated_by, rev
       ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      command.type,
      spec.version,
      title,
      json,
      command.source ? JSON.stringify(command.source) : null,
      ctx.now,
      ctx.actor.id,
      ctx.now,
      ctx.actor.id,
      ctx.rev,
    );
  remember(ctx, command.ref, id, createdKey, index);
  pushChange(ctx, "objects", id, null);
}

function updateObject(
  ctx: Ctx,
  command: Extract<Command, { op: "object.update" }>,
  index: number,
) {
  const row = objectById(ctx, command.id, index);
  assertVersion(row.version, command.expectedVersion, row.title, index);
  if (command.title !== undefined) {
    if (typeof command.title !== "string")
      throw new CommandError("INVALID_DATA", "标题必须是文字。", index);
    assertTitle(command.title, index);
  }
  const set = command.set ?? {};
  const unset = command.unset ?? [];
  if (
    !plain(set) ||
    !Array.isArray(unset) ||
    unset.some((key) => typeof key !== "string")
  )
    throw new CommandError("INVALID_DATA", "修改内容的格式不对。", index);
  rejectBadKeys([...Object.keys(set), ...unset], index);
  const overlap = unset.filter((key) =>
    Object.prototype.hasOwnProperty.call(set, key),
  );
  if (overlap.length > 0)
    throw new CommandError(
      "INVALID_DATA",
      `「${overlap[0]}」不能同时赋值和删除。`,
      index,
    );
  const touchesData =
    Object.keys(set).length > 0 ||
    unset.length > 0 ||
    command.source !== undefined;
  let dataJson = JSON.stringify(row.data);
  if (touchesData) {
    requireType(ctx, row.type, index);
    const next = { ...row.data };
    for (const key of unset) delete next[key];
    Object.assign(next, set);
    dataJson = assertDataSize(next, index);
    const validated = ctx.staged.validateData(row.type, next);
    if (!validated.ok)
      classifyUpdateErrors(ctx, validated.errors, set, unset, index);
    if (command.source) assertSource(command.source, index);
  }
  const before = snapshotObject(ctx.db, row.id);
  const sets: Record<string, string | number | null> = {
    version: row.version + 1,
    updated_at: ctx.now,
    updated_by: ctx.actor.id,
    rev: ctx.rev,
  };
  if (touchesData) sets.data = dataJson;
  if (command.title !== undefined) sets.title = command.title;
  if (command.source !== undefined)
    sets.source = JSON.stringify(command.source);
  assign(ctx.db, "objects", "id", row.id, sets);
  pushChange(ctx, "objects", row.id, before);
}

function deleteObject(
  ctx: Ctx,
  command: Extract<Command, { op: "object.delete" }>,
  index: number,
) {
  const row = objectById(ctx, command.id, index);
  assertVersion(row.version, command.expectedVersion, row.title, index);
  const presentations = ctx.db
    .prepare(
      `SELECT id FROM presentations
       WHERE deleted_rev IS NULL AND (object_id = ? OR board_id = ?)`,
    )
    .all(row.id, row.id) as { id: string }[];
  const relations = ctx.db
    .prepare(
      `SELECT id FROM relations
       WHERE deleted_rev IS NULL AND (source_id = ? OR target_id = ?)`,
    )
    .all(row.id, row.id) as { id: string }[];
  const beforeObject = snapshotObject(ctx.db, row.id);
  const beforePresentations = presentations.map((item) => ({
    id: item.id,
    before: snapshotPresentation(ctx.db, item.id),
  }));
  const beforeRelations = relations.map((item) => ({
    id: item.id,
    before: snapshotRelation(ctx.db, item.id),
  }));
  ctx.db
    .prepare(
      `UPDATE objects
       SET deleted_rev = ?, rev = ?, version = version + 1, updated_at = ?, updated_by = ?
       WHERE id = ?`,
    )
    .run(ctx.rev, ctx.rev, ctx.now, ctx.actor.id, row.id);
  for (const item of presentations)
    softDeleteVersioned(ctx, "presentations", item.id);
  for (const item of relations) softDeleteVersioned(ctx, "relations", item.id);
  pushChange(ctx, "objects", row.id, beforeObject);
  for (const item of beforePresentations)
    pushChange(ctx, "presentations", item.id, item.before);
  for (const item of beforeRelations)
    pushChange(ctx, "relations", item.id, item.before);
}

function cloneObject(
  ctx: Ctx,
  command: Extract<Command, { op: "object.clone" }>,
  index: number,
  createdKey: string,
) {
  const row = objectById(ctx, command.id, index);
  requireType(ctx, row.type, index);
  const validated = ctx.staged.validateData(row.type, row.data);
  if (!validated.ok) throwData(validated.errors, index);
  const id = newId();
  ctx.db
    .prepare(
      `INSERT INTO objects (
         id, type, type_version, title, data, source, version,
         created_at, created_by, updated_at, updated_by, rev
       ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      row.type,
      row.typeVersion,
      row.title,
      JSON.stringify(row.data),
      row.source ? JSON.stringify(row.source) : null,
      ctx.now,
      ctx.actor.id,
      ctx.now,
      ctx.actor.id,
      ctx.rev,
    );
  remember(ctx, command.ref, id, createdKey, index);
  pushChange(ctx, "objects", id, null);
}

function createPresentation(
  ctx: Ctx,
  command: Extract<Command, { op: "presentation.create" }>,
  index: number,
  createdKey: string,
) {
  const board = objectById(ctx, command.boardId, index, "白板");
  assertContainer(ctx, board, index);
  const object = objectById(ctx, command.objectId, index);
  if (hasCycle(ctx.db, object.id, board.id))
    throw new CommandError(
      "CYCLE",
      "不能把白板放进自己里面（直接或间接都不行）。",
      index,
    );
  const spec = ctx.staged.getType(object.type);
  const width =
    command.width ?? spec?.display.defaultSize.width ?? missingSize(index);
  const height =
    command.height ?? spec?.display.defaultSize.height ?? missingSize(index);
  positive(finiteNumber(width, index, "宽度"), index, "宽度");
  positive(finiteNumber(height, index, "高度"), index, "高度");
  const fallback = defaultPosition(ctx.db, board.id);
  const x =
    command.x === undefined
      ? fallback.x
      : finiteNumber(command.x, index, "横坐标");
  const y =
    command.y === undefined
      ? fallback.y
      : finiteNumber(command.y, index, "纵坐标");
  const z = 0;
  if (command.parentId) assertParent(ctx, command.parentId, board.id, index);
  const appearance = command.appearance ?? {};
  if (!plain(appearance))
    throw new CommandError("INVALID_DATA", "外观必须是对象。", index);
  const id = newId();
  ctx.db
    .prepare(
      `INSERT INTO presentations (
         id, board_id, object_id, parent_id, x, y, width, height, z, locked, appearance,
         version, updated_at, updated_by, rev
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 1, ?, ?, ?)`,
    )
    .run(
      id,
      board.id,
      object.id,
      command.parentId ?? null,
      x,
      y,
      width,
      height,
      z,
      JSON.stringify(appearance),
      ctx.now,
      ctx.actor.id,
      ctx.rev,
    );
  remember(ctx, command.ref, id, createdKey, index);
  pushChange(ctx, "presentations", id, null);
}

function updatePresentation(
  ctx: Ctx,
  command: Extract<Command, { op: "presentation.update" }>,
  index: number,
) {
  const row = presentationById(ctx, command.id, index);
  const object = objectById(ctx, row.objectId, index);
  const touches =
    command.x !== undefined ||
    command.y !== undefined ||
    command.width !== undefined ||
    command.height !== undefined;
  if (row.locked && touches && command.locked !== false)
    throw new CommandError(
      "LOCKED",
      `「${object.title || "这个组件"}」已锁定。请先解锁，再移动或调整大小。`,
      index,
    );
  if (hasCycle(ctx.db, row.objectId, row.boardId))
    throw new CommandError(
      "CYCLE",
      "不能把白板放进自己里面（直接或间接都不行）。",
      index,
    );
  if (command.parentId) assertParent(ctx, command.parentId, row.boardId, index);
  if (command.parentId === command.id)
    throw new CommandError("INVALID_DATA", "展示不能套进自己里面。", index);
  const sets: Record<string, string | number | null> = {
    version: row.version + 1,
    updated_at: ctx.now,
    updated_by: ctx.actor.id,
    rev: ctx.rev,
  };
  if (command.x !== undefined)
    sets.x = finiteNumber(command.x, index, "横坐标");
  if (command.y !== undefined)
    sets.y = finiteNumber(command.y, index, "纵坐标");
  if (command.width !== undefined) {
    const width = finiteNumber(command.width, index, "宽度");
    positive(width, index, "宽度");
    sets.width = width;
  }
  if (command.height !== undefined) {
    const height = finiteNumber(command.height, index, "高度");
    positive(height, index, "高度");
    sets.height = height;
  }
  if (command.z !== undefined) sets.z = finiteInteger(command.z, index, "层");
  if (command.locked !== undefined) {
    if (typeof command.locked !== "boolean")
      throw new CommandError("INVALID_DATA", "锁定状态必须是是否。", index);
    sets.locked = command.locked ? 1 : 0;
  }
  if (command.parentId !== undefined) sets.parent_id = command.parentId;
  if (command.appearance !== undefined) {
    if (!plain(command.appearance))
      throw new CommandError("INVALID_DATA", "外观必须是对象。", index);
    sets.appearance = JSON.stringify(command.appearance);
  }
  const before = snapshotPresentation(ctx.db, row.id);
  assign(ctx.db, "presentations", "id", row.id, sets);
  pushChange(ctx, "presentations", row.id, before);
}

function deletePresentation(
  ctx: Ctx,
  command: Extract<Command, { op: "presentation.delete" }>,
  index: number,
) {
  const row = presentationById(ctx, command.id, index);
  const before = snapshotPresentation(ctx.db, row.id);
  softDeleteVersioned(ctx, "presentations", row.id);
  pushChange(ctx, "presentations", row.id, before);
}

function createRelation(
  ctx: Ctx,
  command: Extract<Command, { op: "relation.create" }>,
  index: number,
  createdKey: string,
) {
  const source = objectById(ctx, command.sourceId, index);
  const target = objectById(ctx, command.targetId, index);
  const status = command.status ?? "confirmed";
  assertStatus(status, index);
  const basis = command.basis ?? null;
  assertRelationRules(ctx, command.kind, source, target, status, basis, index);
  const attributes = command.attributes ?? {};
  assertAttributes(attributes, index);
  const evidence = command.evidence ?? [];
  assertEvidence(evidence, index);
  const id = newId();
  ctx.db
    .prepare(
      `INSERT INTO relations (
         id, kind, source_id, target_id, status, basis, attributes, evidence,
         version, created_at, created_by, updated_at, updated_by, rev
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      command.kind,
      source.id,
      target.id,
      status,
      basis,
      JSON.stringify(attributes),
      JSON.stringify(evidence),
      ctx.now,
      ctx.actor.id,
      ctx.now,
      ctx.actor.id,
      ctx.rev,
    );
  remember(ctx, command.ref, id, createdKey, index);
  pushChange(ctx, "relations", id, null);
}

function updateRelation(
  ctx: Ctx,
  command: Extract<Command, { op: "relation.update" }>,
  index: number,
) {
  const row = relationById(ctx, command.id, index);
  assertVersion(row.version, command.expectedVersion, row.kind, index);
  const source = objectById(ctx, row.sourceId, index);
  const target = objectById(ctx, row.targetId, index);
  const status = command.status ?? row.status;
  assertStatus(status, index);
  const basis = command.basis === undefined ? row.basis : command.basis;
  assertRelationRules(ctx, row.kind, source, target, status, basis, index);
  const sets: Record<string, string | number | null> = {
    status,
    basis,
    version: row.version + 1,
    updated_at: ctx.now,
    updated_by: ctx.actor.id,
    rev: ctx.rev,
  };
  if (command.attributes !== undefined) {
    assertAttributes(command.attributes, index);
    sets.attributes = JSON.stringify(command.attributes);
  }
  if (command.evidence !== undefined) {
    assertEvidence(command.evidence, index);
    sets.evidence = JSON.stringify(command.evidence);
  }
  const before = snapshotRelation(ctx.db, row.id);
  assign(ctx.db, "relations", "id", row.id, sets);
  pushChange(ctx, "relations", row.id, before);
}

function deleteRelation(
  ctx: Ctx,
  command: Extract<Command, { op: "relation.delete" }>,
  index: number,
) {
  const row = relationById(ctx, command.id, index);
  const before = snapshotRelation(ctx.db, row.id);
  softDeleteVersioned(ctx, "relations", row.id);
  pushChange(ctx, "relations", row.id, before);
}

function setSetting(
  ctx: Ctx,
  command: Extract<Command, { op: "setting.set" }>,
  index: number,
) {
  if (typeof command.key !== "string" || !command.key.trim())
    throw new CommandError("INVALID_DATA", "设置名不能为空。", index);
  if (Array.from(command.key).length > 200)
    throw new CommandError("LIMIT", "设置名不能超过 200 个字。", index);
  const json = assertDataSize(command.value, index);
  const before = snapshotSetting(ctx.db, command.key);
  ctx.db
    .prepare(
      `INSERT INTO settings (key, value, rev) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, rev = excluded.rev, deleted_rev = NULL`,
    )
    .run(command.key, json, ctx.rev);
  pushChange(ctx, "settings", command.key, before);
}

function setPackEnabled(ctx: Ctx, id: string, enabled: boolean, index: number) {
  if (!enabled && id === "base")
    throw new CommandError("FORBIDDEN", "基础组件包不能停用。", index);
  packById(ctx, id, index);
  const before = snapshotPack(ctx.db, id);
  assign(ctx.db, "packs", "id", id, {
    enabled: enabled ? 1 : 0,
    rev: ctx.rev,
  });
  pushChange(ctx, "packs", id, before);
}

function importPack(
  ctx: Ctx,
  manifest: Record<string, unknown>,
  index: number,
) {
  if (!plain(manifest))
    throw new CommandError("INVALID_DATA", "组件包清单必须是对象。", index);
  const normalized = normalizeManifest(manifest, index);
  const json = JSON.stringify(normalized);
  if (Buffer.byteLength(json) > MANIFEST_LIMIT)
    throw new CommandError(
      "LIMIT",
      "组件包清单超过 256 KB。请删掉一部分再导入。",
      index,
    );
  try {
    ctx.staged.registerPack(normalized, "data");
  } catch (error) {
    if (error instanceof PackSpecError) {
      const problem = error.problems[0];
      throw new CommandError(
        "INVALID_DATA",
        problem ? problem.message : "组件包清单不合格。",
        index,
        problem ? { path: problem.path, message: problem.message } : undefined,
      );
    }
    throw error;
  }
  const id = String((normalized as { id: string }).id);
  const existing = ctx.db
    .prepare("SELECT * FROM packs WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;
  if (
    existing?.kind === "builtin" ||
    ctx.registry.getPack(id)?.kind === "builtin"
  )
    throw new CommandError(
      "FORBIDDEN",
      `「${id}」已经被内置组件包占用。`,
      index,
    );
  if (existing?.manifest)
    assertPackCompatible(ctx, String(existing.manifest), index);
  const before = snapshotPack(ctx.db, id);
  const version = Number((normalized as { version: number }).version);
  ctx.db
    .prepare(
      `INSERT INTO packs (id, kind, version, enabled, manifest, rev, deleted_rev)
       VALUES (?, 'data', ?, 1, ?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET
         kind = 'data',
         version = excluded.version,
         enabled = 1,
         manifest = excluded.manifest,
         rev = excluded.rev,
         deleted_rev = NULL`,
    )
    .run(id, version, json, ctx.rev);
  ctx.afterCommit.push(() => ctx.registry.registerPack(normalized, "data"));
  pushChange(ctx, "packs", id, before);
}

function removePack(ctx: Ctx, id: string, index: number) {
  const row = packById(ctx, id, index);
  if (row.kind === "builtin" || ctx.staged.getPack(id)?.kind === "builtin")
    throw new CommandError("FORBIDDEN", "内置组件包不能移除。", index);
  const before = snapshotPack(ctx.db, id);
  ctx.db
    .prepare("UPDATE packs SET deleted_rev = ?, rev = ? WHERE id = ?")
    .run(ctx.rev, ctx.rev, id);
  ctx.staged.unregisterPack(id);
  ctx.afterCommit.push(() => ctx.registry.unregisterPack(id));
  pushChange(ctx, "packs", id, before);
}

function syncBuiltin(
  ctx: Ctx,
  command: Extract<SystemCommand, { op: "pack.sync_builtin" }>,
  index: number,
) {
  const pack = ctx.staged.getPack(command.id);
  if (!pack || pack.kind !== "builtin")
    throw new CommandError(
      "FORBIDDEN",
      `没有内置组件包「${command.id}」，不能按内置包初始化。`,
      index,
    );
  if (pack.spec.version !== command.version)
    throw new CommandError(
      "INVALID_DATA",
      `内置组件包「${command.id}」的版本和注册表不一致。`,
      index,
      { path: "/version", message: "版本和注册表不一致" },
    );
  if (typeof command.enabledByDefault !== "boolean")
    throw new CommandError("INVALID_DATA", "内置包的默认启用状态不对。", index);
  const existing = ctx.db
    .prepare("SELECT * FROM packs WHERE id = ?")
    .get(command.id) as Record<string, unknown> | undefined;
  if (existing?.kind === "data")
    throw new CommandError(
      "FORBIDDEN",
      `「${command.id}」已经是数据包，不能改成内置包。`,
      index,
    );
  if (existing?.kind === "builtin") {
    if (Number(existing.version) === command.version) return;
    const before = snapshotPack(ctx.db, command.id);
    ctx.db
      .prepare("UPDATE packs SET version = ?, rev = ? WHERE id = ?")
      .run(command.version, ctx.rev, command.id);
    pushChange(ctx, "packs", command.id, before);
    return;
  }
  ctx.db
    .prepare(
      `INSERT INTO packs (id, kind, version, enabled, manifest, rev)
       VALUES (?, 'builtin', ?, ?, NULL, ?)`,
    )
    .run(
      command.id,
      command.version,
      command.enabledByDefault ? 1 : 0,
      ctx.rev,
    );
  pushChange(ctx, "packs", command.id, null);
}

function upsertDerived(
  ctx: Ctx,
  command: Extract<SystemCommand, { op: "object.upsert_derived" }>,
  index: number,
) {
  const pack = ctx.staged.getPack(command.packId);
  if (!pack || pack.kind !== "builtin")
    throw new CommandError("FORBIDDEN", "派生对象只能写入内置组件包。", index);
  const prefix = pack.spec.derivedIdPrefix;
  if (!prefix)
    throw new CommandError(
      "FORBIDDEN",
      `组件包「${pack.spec.title}」没有派生编号前缀，不能写入派生对象。`,
      index,
    );
  const spec = ctx.staged.getType(command.type);
  if (!spec || ctx.staged.packIdOf(command.type) !== command.packId)
    throw new CommandError(
      "UNKNOWN_TYPE",
      `类型「${command.type}」不属于组件包「${command.packId}」。`,
      index,
    );
  if (!isPackEnabled(ctx.db, command.packId))
    throw new CommandError(
      "UNKNOWN_TYPE",
      `组件包「${pack.spec.title}」没有启用，不能写入派生对象。`,
      index,
    );
  if (command.source?.origin !== "derived")
    throw new CommandError(
      "FORBIDDEN",
      "这条命令只能写入派生对象，不能覆盖人工内容。",
      index,
    );
  assertSource(command.source, index);
  const title = command.title ?? "";
  assertTitle(title, index);
  const data = command.data ?? {};
  assertPlainData(data, index);
  const json = assertDataSize(data, index);
  const validated = ctx.staged.validateData(command.type, data);
  if (!validated.ok) throwData(validated.errors, index);
  const existing = objectAny(ctx, command.id);
  if (!existing) {
    if (!command.id.startsWith(prefix))
      throw new CommandError(
        "INVALID_DATA",
        `新建派生对象的编号必须以「${prefix}」开头。`,
        index,
        { path: "/id", message: "编号前缀不对" },
      );
    assertLocatorFree(ctx, command.id, command.source, index);
    ctx.db
      .prepare(
        `INSERT INTO objects (
           id, type, type_version, title, data, source, version,
           created_at, created_by, updated_at, updated_by, rev
         ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
      )
      .run(
        command.id,
        command.type,
        spec.version,
        title,
        json,
        JSON.stringify(command.source),
        ctx.now,
        ctx.actor.id,
        ctx.now,
        ctx.actor.id,
        ctx.rev,
      );
    pushChange(ctx, "objects", command.id, null);
    return;
  }
  if (ctx.staged.packIdOf(existing.type) !== command.packId)
    throw new CommandError(
      "FORBIDDEN",
      "这个编号属于别的组件包，没有改写。",
      index,
    );
  if (existing.source?.origin !== "derived")
    throw new CommandError(
      "FORBIDDEN",
      `「${existing.title || "这个对象"}」是人工内容，不能用派生写入覆盖。`,
      index,
    );
  if (!command.id.startsWith(prefix)) {
    const previous = externalKey(existing.source);
    const incoming = externalKey(command.source);
    if (!previous || previous !== incoming)
      throw new CommandError(
        "FORBIDDEN",
        "这个旧编号的外部位置对不上，没有改写。",
        index,
      );
  }
  assertLocatorFree(ctx, command.id, command.source, index);
  const before = snapshotObject(ctx.db, existing.id);
  assign(ctx.db, "objects", "id", existing.id, {
    type: command.type,
    type_version: spec.version,
    title,
    data: json,
    source: JSON.stringify(command.source),
    version: existing.version + 1,
    updated_at: ctx.now,
    updated_by: ctx.actor.id,
    rev: ctx.rev,
    deleted_rev: null,
  });
  pushChange(ctx, "objects", existing.id, before);
}

function expandTemplate(
  ctx: Ctx,
  command: Extract<Command, { op: "template.apply" }>,
  index: number,
  dx: number,
  dy: number,
): Command[] {
  if (ctx.templateStack.length >= TEMPLATE_DEPTH)
    throw new CommandError(
      "LIMIT",
      "模板套用太深了。请减少嵌套后再试。",
      index,
    );
  const template = ctx.staged.getTemplate(command.templateId);
  if (!template)
    throw new CommandError(
      "NOT_FOUND",
      `没有模板「${command.templateId}」。请检查模板 id。`,
      index,
    );
  if (!isPackEnabled(ctx.db, ctx.staged.packIdOf(template.id)))
    throw new CommandError(
      "UNKNOWN_TYPE",
      `模板「${template.title}」所在的组件包没有启用。`,
      index,
    );
  if (ctx.templateStack.includes(template.id))
    throw new CommandError(
      "INVALID_DATA",
      `模板「${template.title}」套用了自己。`,
      index,
    );
  const ownX =
    command.x === undefined ? 0 : finiteNumber(command.x, index, "横坐标");
  const ownY =
    command.y === undefined ? 0 : finiteNumber(command.y, index, "纵坐标");
  const nextX = dx + ownX;
  const nextY = dy + ownY;
  ctx.templateStack.push(template.id);
  try {
    const out: Command[] = [];
    for (const inner of template.commands) {
      const replaced = replaceBoard(inner, command.boardId);
      if (replaced.op === "template.apply")
        out.push(...expandTemplate(ctx, replaced, index, nextX, nextY));
      else out.push(shift(replaced, nextX, nextY));
    }
    return out;
  } finally {
    ctx.templateStack.pop();
  }
}

function replaceBoard<T extends Command>(command: T, boardId: string): T {
  const copy = { ...command } as T & Record<string, unknown>;
  for (const slot of SLOTS) {
    if (copy[slot] === "$board") copy[slot] = boardId;
  }
  return copy;
}

function shift<T extends Command>(command: T, dx: number, dy: number): T {
  if (
    command.op !== "presentation.create" &&
    command.op !== "presentation.update"
  )
    return command;
  const copy = { ...command } as T & { x?: number; y?: number };
  if (typeof copy.x === "number") copy.x += dx;
  if (typeof copy.y === "number") copy.y += dy;
  return copy;
}

function resolveRefs<T extends AnyCommand>(
  ctx: Ctx,
  command: T,
  index: number,
): T {
  const copy = { ...command } as T & Record<string, unknown>;
  for (const slot of SLOTS) {
    const value = copy[slot];
    if (typeof value !== "string" || !value.startsWith("@")) continue;
    const name = value.slice(1);
    const id = ctx.refs.get(name);
    if (!id)
      throw new CommandError(
        "NOT_FOUND",
        `这一批里没有名为「${name}」的引用。请在更前面的创建命令上写 ref。`,
        index,
      );
    copy[slot] = id;
  }
  return copy;
}

function remember(
  ctx: Ctx,
  ref: string | undefined,
  id: string,
  createdKey: string,
  index: number,
) {
  if (ref !== undefined) {
    if (!ref) throw new CommandError("INVALID_DATA", "引用名不能为空。", index);
    if (ctx.refs.has(ref))
      throw new CommandError(
        "INVALID_DATA",
        `引用名「${ref}」在这一批里重复了。请换成不同的名字。`,
        index,
      );
    ctx.refs.set(ref, id);
    ctx.created[ref] = id;
    return;
  }
  ctx.created[createdKey] = id;
}

function requireType(ctx: Ctx, type: string, index: number) {
  const spec = ctx.staged.getType(type);
  if (!spec || !isPackEnabled(ctx.db, ctx.staged.packIdOf(type)))
    throw new CommandError(
      "UNKNOWN_TYPE",
      `类型「${type}」不存在，或它所在的组件包没有启用。请先启用组件包，或改用已启用的类型。`,
      index,
    );
  return spec;
}

function assertContainer(ctx: Ctx, board: ObjectRow, index: number) {
  const spec = ctx.staged.getType(board.type);
  if (!spec?.capabilities?.container)
    throw new CommandError(
      "NOT_CONTAINER",
      `「${board.title || board.type}」不是白板，不能往里面放内容。`,
      index,
    );
}

function assertRelationRules(
  ctx: Ctx,
  kind: string,
  source: ObjectRow,
  target: ObjectRow,
  status: "confirmed" | "inferred",
  basis: string | null,
  index: number,
) {
  const spec = ctx.staged.getRelationKind(kind);
  if (!spec || !isPackEnabled(ctx.db, ctx.staged.packIdOf(kind)))
    throw new CommandError(
      "UNKNOWN_TYPE",
      `关系「${kind}」不存在，或它所在的组件包没有启用。`,
      index,
    );
  if (source.id === target.id)
    throw new CommandError(
      "INVALID_DATA",
      "关系的两端不能是同一个对象。",
      index,
    );
  if (spec.sourceTypes && !spec.sourceTypes.includes(source.type))
    throw new CommandError(
      "INVALID_DATA",
      `关系「${spec.title}」的起点不能是这种类型。`,
      index,
      { path: "/sourceId", message: "起点类型不符合" },
    );
  if (spec.targetTypes && !spec.targetTypes.includes(target.type))
    throw new CommandError(
      "INVALID_DATA",
      `关系「${spec.title}」的终点不能是这种类型。`,
      index,
      { path: "/targetId", message: "终点类型不符合" },
    );
  if (status === "inferred" && spec.allowsInferred === false)
    throw new CommandError(
      "INVALID_DATA",
      `关系「${spec.title}」不能标成推测。`,
      index,
      {
        path: "/status",
        message: "不能标成推测",
      },
    );
  if (status === "inferred" && !hasText(basis))
    throw new CommandError(
      "INVALID_DATA",
      `推测关系「${spec.title}」必须写下依据。`,
      index,
      { path: "/basis", message: "必须写下依据" },
    );
  if (spec.requiresBasis && !hasText(basis))
    throw new CommandError(
      "INVALID_DATA",
      `关系「${spec.title}」必须写下依据。`,
      index,
      {
        path: "/basis",
        message: "必须写下依据",
      },
    );
}

function classifyUpdateErrors(
  ctx: Ctx,
  errors: { path: string; message: string }[],
  set: Record<string, unknown>,
  unset: string[],
  index: number,
) {
  const blocking = errors.filter((error) => {
    const key = topKey(error.path);
    if (!key) return true;
    return (
      Object.prototype.hasOwnProperty.call(set, key) || unset.includes(key)
    );
  });
  const warnings = errors.filter((error) => !blocking.includes(error));
  for (const warning of warnings)
    ctx.warnings.push({
      commandIndex: index,
      message: warning.message,
      path: warning.path,
    });
  if (blocking.length > 0) throwData(blocking, index);
}

function assertPackCompatible(
  ctx: Ctx,
  previousManifest: string,
  index: number,
) {
  let previous: { types?: { type: string }[] };
  try {
    previous = JSON.parse(previousManifest) as { types?: { type: string }[] };
  } catch {
    return;
  }
  const oldTypes = new Set((previous.types ?? []).map((type) => type.type));
  for (const type of oldTypes) {
    const rows = ctx.db
      .prepare(
        "SELECT id, data FROM objects WHERE type = ? AND deleted_rev IS NULL",
      )
      .all(type) as { id: string; data: string }[];
    for (const row of rows) {
      let data: unknown;
      try {
        data = JSON.parse(row.data);
      } catch {
        continue;
      }
      const validated = ctx.staged.validateData(type, data);
      if (!validated.ok)
        throw new CommandError(
          "INVALID_DATA",
          `新的组件包接不住已有的「${type}」数据。请换一个类型名，或放宽字段。`,
          index,
          {
            path: validated.errors[0]?.path,
            message: validated.errors[0]?.message,
          },
        );
    }
  }
}

function assertLocatorFree(
  ctx: Ctx,
  id: string,
  source: ObjectSource,
  index: number,
) {
  const external = source.external;
  if (!external?.uri) return;
  const row = ctx.db
    .prepare(
      `SELECT id FROM objects
       WHERE id <> ?
         AND json_extract(source, '$.external.uri') = ?
         AND ifnull(json_extract(source, '$.external.fragment'), '') = ?
       LIMIT 1`,
    )
    .get(id, external.uri, external.fragment ?? "") as
    { id: string } | undefined;
  if (row)
    throw new CommandError(
      "FORBIDDEN",
      "这个外部位置已经对应另一个对象，没有改写。",
      index,
    );
}

function shouldRecord(db: Db, change: Change) {
  if (change.table === "objects")
    return !derivedSnapshot(change.after ?? change.before);
  if (change.table === "presentations") {
    const snap = change.after ?? change.before;
    return !(
      isDerivedObject(db, String(snap?.boardId ?? "")) &&
      isDerivedObject(db, String(snap?.objectId ?? ""))
    );
  }
  if (change.table === "relations") {
    const snap = change.after ?? change.before;
    return !(
      isDerivedObject(db, String(snap?.sourceId ?? "")) &&
      isDerivedObject(db, String(snap?.targetId ?? ""))
    );
  }
  return true;
}

function derivedSnapshot(snapshot: Snapshot) {
  if (!snapshot || !plain(snapshot.source)) return false;
  return snapshot.source.origin === "derived";
}

function isDerivedObject(db: Db, id: string) {
  const row = db.prepare("SELECT source FROM objects WHERE id = ?").get(id) as
    { source: string | null } | undefined;
  if (!row?.source) return false;
  try {
    return (JSON.parse(row.source) as ObjectSource).origin === "derived";
  } catch {
    return false;
  }
}

function lookup(ctx: Ctx): LabelLookup {
  const titleOf = (id: string) => {
    const resolved = resolveKnown(ctx, id);
    const row = ctx.db
      .prepare("SELECT title FROM objects WHERE id = ?")
      .get(resolved) as { title: string } | undefined;
    return row?.title ?? "";
  };
  return {
    objectTitle: titleOf,
    endpointTitle: titleOf,
    presentationObjectTitle(id) {
      const resolved = resolveKnown(ctx, id);
      const row = ctx.db
        .prepare(
          `SELECT objects.title AS title
           FROM presentations JOIN objects ON objects.id = presentations.object_id
           WHERE presentations.id = ?`,
        )
        .get(resolved) as { title: string } | undefined;
      return row?.title ?? "";
    },
    packTitle(id, manifest) {
      if (manifest && typeof manifest.title === "string" && manifest.title)
        return manifest.title;
      const row = ctx.db
        .prepare("SELECT manifest FROM packs WHERE id = ?")
        .get(id) as { manifest: string | null } | undefined;
      if (row?.manifest) {
        try {
          const parsed = JSON.parse(row.manifest) as { title?: unknown };
          if (typeof parsed.title === "string" && parsed.title)
            return parsed.title;
        } catch {
          /* 清单损坏时退回注册表标题 */
        }
      }
      return ctx.staged.getPack(id)?.spec.title ?? id;
    },
  };
}

function resolveKnown(ctx: Ctx, id: string) {
  if (id.startsWith("@")) return ctx.refs.get(id.slice(1)) ?? id;
  return id;
}

function objectById(ctx: Ctx, id: string, index: number, what = "对象") {
  const row = objectAny(ctx, id);
  if (!row)
    throw new CommandError(
      "NOT_FOUND",
      `找不到这个${what}。请重新读取后再试。`,
      index,
    );
  if (row.deleted)
    throw new CommandError(
      "NOT_FOUND",
      `「${row.title || what}」已经删除。请重新读取后再试。`,
      index,
    );
  return row;
}

function objectAny(ctx: Ctx, id: string) {
  const raw = ctx.db.prepare("SELECT * FROM objects WHERE id = ?").get(id) as
    Record<string, unknown> | undefined;
  return raw ? toObjectRow(raw) : undefined;
}

function presentationById(ctx: Ctx, id: string, index: number) {
  const raw = ctx.db
    .prepare("SELECT * FROM presentations WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;
  if (!raw)
    throw new CommandError(
      "NOT_FOUND",
      "找不到这个展示。请重新读取后再试。",
      index,
    );
  const row = toPresentationRow(raw);
  if (row.deleted)
    throw new CommandError(
      "NOT_FOUND",
      "这个展示已经移除。请重新读取后再试。",
      index,
    );
  return row;
}

function relationById(ctx: Ctx, id: string, index: number) {
  const raw = ctx.db.prepare("SELECT * FROM relations WHERE id = ?").get(id) as
    Record<string, unknown> | undefined;
  if (!raw)
    throw new CommandError(
      "NOT_FOUND",
      "找不到这条关系。请重新读取后再试。",
      index,
    );
  const row = toRelationRow(raw);
  if (row.deleted)
    throw new CommandError(
      "NOT_FOUND",
      "这条关系已经删除。请重新读取后再试。",
      index,
    );
  return row;
}

function packById(ctx: Ctx, id: string, index: number) {
  const row = ctx.db.prepare("SELECT * FROM packs WHERE id = ?").get(id) as
    Record<string, unknown> | undefined;
  if (!row || row.deleted_rev != null)
    throw new CommandError("NOT_FOUND", `找不到组件包「${id}」。`, index);
  return row;
}

function assertParent(
  ctx: Ctx,
  parentId: string,
  boardId: string,
  index: number,
) {
  const parent = presentationById(ctx, parentId, index);
  if (parent.boardId !== boardId)
    throw new CommandError(
      "INVALID_DATA",
      "展示的外框不在同一块白板上。",
      index,
    );
}

function hasCycle(db: Db, placedId: string, boardId: string) {
  if (placedId === boardId) return true;
  const row = db
    .prepare(
      `WITH RECURSIVE inside(id, path) AS (
         SELECT object_id, ',' || object_id || ','
         FROM presentations
         WHERE board_id = ? AND deleted_rev IS NULL
         UNION
         SELECT p.object_id, inside.path || p.object_id || ','
         FROM presentations p
         JOIN inside ON p.board_id = inside.id
         WHERE p.deleted_rev IS NULL
           AND instr(inside.path, ',' || p.object_id || ',') = 0
       )
       SELECT 1 AS hit FROM inside WHERE id = ? LIMIT 1`,
    )
    .get(placedId, boardId) as { hit: number } | undefined;
  return Boolean(row);
}

function defaultPosition(db: Db, boardId: string) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n, MAX(x + width) AS rightEdge, MIN(y) AS top
       FROM presentations WHERE board_id = ? AND deleted_rev IS NULL`,
    )
    .get(boardId) as {
    n: number;
    rightEdge: number | null;
    top: number | null;
  };
  if (!row || Number(row.n) === 0) return { x: 0, y: 0 };
  return { x: Number(row.rightEdge) + 40, y: Number(row.top) };
}

function softDeleteVersioned(
  ctx: Ctx,
  table: "presentations" | "relations",
  id: string,
) {
  ctx.db
    .prepare(
      `UPDATE ${table}
       SET deleted_rev = ?, rev = ?, version = version + 1, updated_at = ?, updated_by = ?
       WHERE id = ?`,
    )
    .run(ctx.rev, ctx.rev, ctx.now, ctx.actor.id, id);
}

function pushChange(ctx: Ctx, table: TableName, id: string, before: Snapshot) {
  const after = takeSnapshot(ctx.db, table, id);
  if (!after)
    throw new CommandError("INTERNAL", "写入后没有读到记录，已取消。", null);
  ctx.changes.push({ table, id, before, after });
  ctx.changed.push({
    table,
    id,
    version: typeof after.version === "number" ? after.version : 1,
  });
}

function takeSnapshot(db: Db, table: TableName, id: string): Snapshot {
  if (table === "objects") return snapshotObject(db, id);
  if (table === "presentations") return snapshotPresentation(db, id);
  if (table === "relations") return snapshotRelation(db, id);
  if (table === "settings") return snapshotSetting(db, id);
  return snapshotPack(db, id);
}

function snapshotObject(db: Db, id: string): Snapshot {
  const raw = db.prepare("SELECT * FROM objects WHERE id = ?").get(id) as
    Record<string, unknown> | undefined;
  if (!raw) return null;
  const row = toObjectRow(raw);
  return {
    id: row.id,
    type: row.type,
    typeVersion: row.typeVersion,
    title: row.title,
    data: row.data,
    source: row.source,
    version: row.version,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
    alive: !row.deleted,
  };
}

function snapshotPresentation(db: Db, id: string): Snapshot {
  const raw = db.prepare("SELECT * FROM presentations WHERE id = ?").get(id) as
    Record<string, unknown> | undefined;
  if (!raw) return null;
  const row = toPresentationRow(raw);
  return {
    id: row.id,
    boardId: row.boardId,
    objectId: row.objectId,
    parentId: row.parentId,
    x: row.x,
    y: row.y,
    width: row.width,
    height: row.height,
    z: row.z,
    locked: row.locked,
    appearance: row.appearance,
    version: row.version,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
    alive: !row.deleted,
  };
}

function snapshotRelation(db: Db, id: string): Snapshot {
  const raw = db.prepare("SELECT * FROM relations WHERE id = ?").get(id) as
    Record<string, unknown> | undefined;
  if (!raw) return null;
  const row = toRelationRow(raw);
  return {
    id: row.id,
    kind: row.kind,
    sourceId: row.sourceId,
    targetId: row.targetId,
    status: row.status,
    basis: row.basis,
    attributes: row.attributes,
    evidence: row.evidence,
    version: row.version,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
    alive: !row.deleted,
  };
}

function snapshotSetting(db: Db, key: string): Snapshot {
  const row = db.prepare("SELECT * FROM settings WHERE key = ?").get(key) as
    Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    key,
    value: JSON.parse(String(row.value)),
    alive: row.deleted_rev == null,
  };
}

function snapshotPack(db: Db, id: string): Snapshot {
  const row = db.prepare("SELECT * FROM packs WHERE id = ?").get(id) as
    Record<string, unknown> | undefined;
  if (!row) return null;
  let manifest: unknown = null;
  if (row.manifest != null) {
    try {
      manifest = JSON.parse(String(row.manifest));
    } catch (error) {
      throw new CommandError(
        "INTERNAL",
        "组件包清单无法读取，已取消写入。",
        null,
        {
          cause: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }
  return {
    id: String(row.id),
    kind: String(row.kind),
    version: Number(row.version),
    enabled: row.enabled === 1,
    manifest,
    alive: row.deleted_rev == null,
  };
}

function assign(
  db: Db,
  table: "objects" | "presentations" | "relations" | "settings" | "packs",
  idColumn: string,
  id: string,
  sets: Record<string, string | number | null>,
) {
  const keys = Object.keys(sets);
  db.prepare(
    `UPDATE ${table} SET ${keys.map((key) => `${key} = ?`).join(", ")} WHERE ${idColumn} = ?`,
  ).run(...keys.map((key) => sets[key]), id);
}

function stageRegistry(registry: Registry) {
  const staged = createRegistry();
  try {
    for (const pack of registry.listPacks())
      staged.registerPack(pack.spec, pack.kind);
  } catch (error) {
    throw asInternal(error);
  }
  return staged;
}

function normalizeManifest(manifest: Record<string, unknown>, index: number) {
  if (manifest.format === "sand-table-pack") return manifest;
  if (manifest.version === 1) return convertV1(manifest, index);
  return manifest;
}

function convertV1(manifest: Record<string, unknown>, index: number) {
  if (typeof manifest.id !== "string" || typeof manifest.name !== "string")
    throw new CommandError(
      "INVALID_DATA",
      "旧版组件包需要 id 和 name。",
      index,
    );
  if (manifest.components !== undefined && !Array.isArray(manifest.components))
    throw new CommandError(
      "INVALID_DATA",
      "旧版组件包的 components 必须是数组。",
      index,
    );
  const presets = ((manifest.components ?? []) as unknown[]).map(
    (component, at) => convertComponent(component, index, at),
  );
  return {
    format: "sand-table-pack" as const,
    formatVersion: 2 as const,
    id: packSlug(manifest.id),
    title: manifest.name,
    version: 1,
    presets,
  };
}

function convertComponent(component: unknown, index: number, at: number) {
  if (!plain(component))
    throw new CommandError(
      "INVALID_DATA",
      `第 ${at + 1} 个旧组件不是对象。`,
      index,
    );
  const { key, title, type } = component;
  if (
    typeof key !== "string" ||
    typeof title !== "string" ||
    typeof type !== "string"
  )
    throw new CommandError(
      "INVALID_DATA",
      `第 ${at + 1} 个旧组件需要 key、title 和 type。`,
      index,
    );
  if (component.data !== undefined && !plain(component.data))
    throw new CommandError(
      "INVALID_DATA",
      `第 ${at + 1} 个旧组件的 data 必须是对象。`,
      index,
    );
  const data = plain(component.data) ? { ...component.data } : {};
  if (
    type === "text" &&
    !Object.prototype.hasOwnProperty.call(data, "body") &&
    Object.prototype.hasOwnProperty.call(data, "text")
  ) {
    data.body = data.text;
    delete data.text;
  }
  const preset: Record<string, unknown> = {
    key,
    title,
    type: renameV1Type(type, data),
    data,
  };
  if (typeof component.width === "number") preset.width = component.width;
  if (typeof component.height === "number") preset.height = component.height;
  return preset;
}

function renameV1Type(type: string, data: Record<string, unknown>) {
  if (type === "resource") {
    if (typeof data.url === "string" && data.url) return "base.link";
    if (
      typeof data.blob === "string" ||
      typeof data.sha256 === "string" ||
      typeof data.assetId === "string"
    )
      return "base.media";
    return "base.link";
  }
  return BASE_TYPE[type] ?? `legacy.${type}`;
}

function packSlug(id: string) {
  let out = "";
  for (const char of id.toLowerCase())
    out += /[a-z0-9-]/.test(char) ? char : "-";
  return Array.from(out).slice(0, 41).join("");
}

function assertActor(actor: Actor) {
  if (
    !actor ||
    typeof actor.id !== "string" ||
    !actor.id ||
    (actor.kind !== "human" && actor.kind !== "agent")
  )
    throw new CommandError(
      "INVALID_DATA",
      "需要说明是谁在改：人还是助手。",
      null,
    );
}

function assertBatch(commands: unknown) {
  if (
    !Array.isArray(commands) ||
    commands.length < 1 ||
    commands.length > BATCH_LIMIT
  )
    throw new CommandError(
      "LIMIT",
      Array.isArray(commands) && commands.length > BATCH_LIMIT
        ? "一次最多提交 200 条命令。请拆开再提交。"
        : "这次没有要执行的命令。",
      null,
    );
}

function assertVersion(
  current: number,
  expected: number | undefined,
  title: string,
  index: number,
) {
  if (expected === undefined || expected === current) return;
  throw new CommandError(
    "VERSION_CONFLICT",
    `「${title || "这项内容"}」已被改过，当前版本是 ${current}。请重新读取后再保存。`,
    index,
    { version: current },
  );
}

function assertTitle(title: string, index: number) {
  if (Array.from(title).length > TITLE_LIMIT)
    throw new CommandError(
      "LIMIT",
      "标题不能超过 300 个字。请缩短后再保存。",
      index,
    );
}

function assertPlainData(
  data: unknown,
  index: number,
): asserts data is Record<string, unknown> {
  if (!plain(data))
    throw new CommandError("INVALID_DATA", "数据必须是对象。", index);
}

function assertDataSize(data: unknown, index: number) {
  let json: string;
  try {
    const encoded = JSON.stringify(data);
    if (typeof encoded !== "string")
      throw new CommandError("INVALID_DATA", "数据无法保存成 JSON。", index);
    json = encoded;
  } catch (error) {
    if (error instanceof CommandError) throw error;
    throw new CommandError("INVALID_DATA", "数据无法保存成 JSON。", index);
  }
  if (Buffer.byteLength(json) > DATA_LIMIT)
    throw new CommandError(
      "LIMIT",
      "数据超过 1 MB，无法保存。请删掉一部分内容。",
      index,
    );
  return json;
}

function assertSource(source: ObjectSource, index: number) {
  if (!ORIGINS.has(source.origin))
    throw new CommandError("INVALID_DATA", "对象来源无法识别。", index, {
      path: "/source/origin",
      message: "来源无法识别",
    });
  if (source.origin === "ai-inferred" && !hasText(source.basis))
    throw new CommandError(
      "INVALID_DATA",
      "推测出来的对象必须写下依据。",
      index,
      {
        path: "/source/basis",
        message: "必须写下依据",
      },
    );
}

function assertStatus(
  status: string,
  index: number,
): asserts status is "confirmed" | "inferred" {
  if (status !== "confirmed" && status !== "inferred")
    throw new CommandError(
      "INVALID_DATA",
      "关系状态只能是已确认或推测。",
      index,
    );
}

function assertAttributes(
  value: unknown,
  index: number,
): asserts value is Record<string, unknown> {
  if (!plain(value))
    throw new CommandError("INVALID_DATA", "关系的附加数据必须是对象。", index);
}

function assertEvidence(
  evidence: unknown,
  index: number,
): asserts evidence is ExternalLocator[] {
  if (!Array.isArray(evidence))
    throw new CommandError("INVALID_DATA", "证据必须是列表。", index);
  for (const item of evidence) {
    if (
      !plain(item) ||
      typeof item.kind !== "string" ||
      typeof item.uri !== "string"
    )
      throw new CommandError(
        "INVALID_DATA",
        "每条证据都要有种类和地址。",
        index,
      );
  }
}

function throwData(
  errors: { path: string; message: string }[],
  index: number,
): never {
  const first = errors[0];
  throw new CommandError(
    "INVALID_DATA",
    first ? first.message : "数据不符合这个类型的要求。",
    index,
    first ? { path: first.path, message: first.message } : undefined,
  );
}

function rejectBadKeys(keys: string[], index: number) {
  if (
    keys.some(
      (key) =>
        key === "__proto__" || key === "prototype" || key === "constructor",
    )
  )
    throw new CommandError("INVALID_DATA", "这个字段名不能使用。", index);
}

function finiteNumber(value: unknown, index: number, label: string) {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new CommandError("INVALID_DATA", `${label}必须是有限数字。`, index);
  return value;
}

function finiteInteger(value: unknown, index: number, label: string) {
  const number = finiteNumber(value, index, label);
  if (!Number.isInteger(number))
    throw new CommandError("INVALID_DATA", `${label}必须是整数。`, index);
  return number;
}

function positive(value: number, index: number, label: string) {
  if (!(value > 0))
    throw new CommandError("INVALID_DATA", `${label}必须大于 0。`, index);
}

function missingSize(index: number): never {
  throw new CommandError(
    "INVALID_DATA",
    "这个对象的类型没有默认尺寸，请写上宽度和高度。",
    index,
  );
}

function topKey(path: string) {
  const [first] = path.split("/").filter(Boolean);
  if (!first) return "";
  return first.replaceAll("~1", "/").replaceAll("~0", "~");
}

function externalKey(source: ObjectSource | null | undefined) {
  const external = source?.external;
  if (!external?.uri) return null;
  return `${external.uri}\0${external.fragment ?? ""}`;
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function plain(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asInternal(error: unknown) {
  return new CommandError(
    "INTERNAL",
    "写入没有完成，数据已恢复到这次操作之前。",
    null,
    {
      cause: error instanceof Error ? error.message : String(error),
    },
  );
}
