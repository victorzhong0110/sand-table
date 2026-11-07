import { isDeepStrictEqual } from "node:util";
import { getMeta, type Db } from "./db.ts";
import { CommandError } from "./errors.ts";
import { migrateRow } from "./migrate.ts";
import { isPackEnabled } from "./packs-state.ts";
import { readOnly } from "./read.ts";
import type { Registry } from "./registry.ts";
import { toObjectRow } from "./rows.ts";
import type {
  Change,
  ObjectRow,
  ObjectSource,
  RelationSlot,
  Snapshot,
} from "./types.ts";

export type BindingInput = {
  objectId: string;
  slot: string;
  ids?: string[];
  fields?: string[];
  limit?: number;
  cursor?: string;
};
export type BindingItem = {
  id: string;
  type: string;
  title: string;
  version: number;
  typeVersion: number;
  data: Record<string, unknown>;
  source: ObjectSource | null;
  unavailable?: string;
  migrationError?: string;
};
export type BindingsResult = {
  revision: number;
  items: BindingItem[];
  nextCursor: string | null;
};
export type HistoricalObjectRow = Omit<ObjectRow, "rev"> & { rev: null };
export type VersionResult =
  | { revision: number; ok: true; row: ObjectRow | HistoricalObjectRow }
  | { revision: number; ok: false; reason: string };

type Raw = Record<string, unknown>;

function fail(message: string, details?: Record<string, unknown>): never {
  throw new CommandError("FORBIDDEN", message, null, details);
}
function revision(db: Db): number {
  return Number(getMeta(db, "revision") ?? "0");
}
function object(db: Db, id: string): Raw | undefined {
  return db.prepare("SELECT * FROM objects WHERE id = ?").get(id) as
    Raw | undefined;
}
function available(
  db: Db,
  registry: Registry,
  row: ObjectRow,
): string | undefined {
  if (row.deleted) return "来源对象已删除。";
  if (
    !registry.getType(row.type) ||
    !isPackEnabled(db, registry.packIdOf(row.type))
  )
    return "来源对象所属的组件包未启用。";
  return undefined;
}

/** 只有能从当前历史路径证明由目标删除级联产生的墓碑才用于失效提示。 */
function cascadeProven(
  db: Db,
  relationId: string,
  targetId: string,
  rev: number,
): boolean {
  const audit = db
    .prepare(
      "SELECT action, history_id, detail FROM audit WHERE json_extract(detail, '$.revision') = ? ORDER BY seq DESC LIMIT 1",
    )
    .get(rev) as
    { action: string; history_id: string | null; detail: string } | undefined;
  if (!audit || !["apply", "redo", "jump"].includes(audit.action)) return false;
  const cursor = getMeta(db, "history_cursor");
  if (!cursor) return false;
  const path = db
    .prepare(
      `WITH RECURSIVE path(id, parent_id, changes, depth) AS (
    SELECT id, parent_id, changes, 0 FROM history WHERE id = ?
    UNION ALL SELECT h.id, h.parent_id, h.changes, p.depth + 1 FROM history h JOIN path p ON h.id = p.parent_id
  ) SELECT id, changes FROM path ORDER BY depth`,
    )
    .all(cursor) as { id: string; changes: string }[];
  const history = path.find((entry) =>
    (JSON.parse(entry.changes) as Change[]).some(
      (change) => change.table === "relations" && change.id === relationId,
    ),
  );
  if (!history) return false;
  const changes = JSON.parse(history.changes) as Change[];
  const singleDeletion = (change: Change) =>
    change.before?.alive === true &&
    change.after?.alive === false &&
    typeof change.before.version === "number" &&
    change.after.version === change.before.version + 1;
  const objIndex = changes.findIndex(
    (change) =>
      change.table === "objects" &&
      change.id === targetId &&
      singleDeletion(change),
  );
  const relIndex = changes.findIndex(
    (change) =>
      change.table === "relations" &&
      change.id === relationId &&
      singleDeletion(change),
  );
  return objIndex >= 0 && relIndex > objIndex;
}

function targets(
  db: Db,
  registry: Registry,
  objectId: string,
  slotKey: string,
): Map<string, ObjectRow> {
  const raw = object(db, objectId);
  if (!raw || raw.deleted_rev != null)
    fail("读取组件不存在或已删除，请重新打开白板。");
  const reader = toObjectRow(raw);
  if (available(db, registry, reader))
    fail("读取组件所属的包未启用，请先启用。 ");
  if (slotKey === "self") return new Map([[objectId, reader]]);
  const slot: RelationSlot | undefined = registry
    .getType(reader.type)
    ?.relationSlots?.find((item) => item.key === slotKey);
  if (!slot) fail(`组件没有声明关系槽「${slotKey}」。`);
  const mine = slot.direction === "out" ? "source_id" : "target_id";
  const other = slot.direction === "out" ? "target_id" : "source_id";
  const relations = db
    .prepare(
      `SELECT r.id AS relation_id, r.deleted_rev AS relation_deleted_rev, o.* FROM relations r JOIN objects o ON o.id = r.${other} WHERE r.${mine} = ? AND r.kind = ? ORDER BY o.id, r.id`,
    )
    .all(objectId, slot.kind) as Raw[];
  const result = new Map<string, ObjectRow>();
  for (const rawTarget of relations) {
    const row = toObjectRow(rawTarget);
    if (slot.targetTypes?.length && !slot.targetTypes.includes(row.type))
      continue;
    const relDeleted = rawTarget.relation_deleted_rev;
    if (
      relDeleted != null &&
      !(
        row.deleted &&
        Number(rawTarget.deleted_rev) === Number(relDeleted) &&
        cascadeProven(
          db,
          String(rawTarget.relation_id),
          row.id,
          Number(relDeleted),
        )
      )
    )
      continue;
    result.set(row.id, row);
  }
  return result;
}
function authorize(items: Map<string, ObjectRow>, ids: string[] | undefined) {
  const missing = (ids ?? []).filter((id) => !items.has(id));
  if (missing.length)
    fail(`这些对象没有绑定到该关系槽：${missing.join("、")}。`, {
      ids: missing,
    });
}
function readItem(
  db: Db,
  registry: Registry,
  row: ObjectRow,
  fields?: string[],
): BindingItem {
  const reason = available(db, registry, row);
  const migrated = reason ? row : migrateRow(registry, row);
  const allowed = new Set([
    ...Object.keys(registry.getType(row.type)?.schema.properties ?? {}),
    ...Object.keys(migrated.data),
  ]);
  if (!reason && fields?.some((field) => !allowed.has(field)))
    fail("请求的字段不属于来源对象，请检查字段名称。");
  const data: Record<string, unknown> = {};
  if (!reason) {
    for (const key of fields ?? Object.keys(migrated.data)) {
      if (Object.hasOwn(migrated.data, key))
        Object.defineProperty(data, key, {
          value: migrated.data[key],
          enumerable: true,
          configurable: true,
          writable: true,
        });
    }
  }
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    version: row.version,
    typeVersion: migrated.typeVersion,
    data,
    source: reason ? null : row.source,
    ...(reason ? { unavailable: reason } : {}),
    ...("migrationError" in migrated &&
    typeof migrated.migrationError === "string"
      ? { migrationError: migrated.migrationError }
      : {}),
  };
}

export function readBindings(
  db: Db,
  registry: Registry,
  input: BindingInput,
): BindingsResult {
  return readOnly(db, () => {
    const limit = input.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200)
      throw new CommandError(
        "INVALID_DATA",
        "每页数量须在 1 到 200 之间。",
        null,
      );
    if ((input.ids?.length ?? 0) > 200 || (input.fields?.length ?? 0) > 200)
      throw new CommandError("LIMIT", "一次最多请求 200 个对象或字段。", null);
    const bound = targets(db, registry, input.objectId, input.slot);
    authorize(bound, input.ids);
    const selected = [...bound.values()]
      .filter(
        (row) =>
          (!input.ids || input.ids.includes(row.id)) &&
          (!input.cursor || row.id > input.cursor),
      )
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const page = selected.slice(0, limit);
    return {
      revision: revision(db),
      items: page.map((row) => readItem(db, registry, row, input.fields)),
      nextCursor: selected.length > limit ? page.at(-1)!.id : null,
    };
  });
}

function fromSnapshot(snapshot: Snapshot): HistoricalObjectRow | null {
  if (
    !snapshot ||
    typeof snapshot.id !== "string" ||
    typeof snapshot.version !== "number" ||
    typeof snapshot.type !== "string" ||
    !snapshot.data ||
    typeof snapshot.data !== "object" ||
    Array.isArray(snapshot.data)
  )
    return null;
  return {
    id: snapshot.id,
    type: snapshot.type,
    typeVersion: Number(snapshot.typeVersion),
    title: String(snapshot.title),
    data: snapshot.data as Record<string, unknown>,
    source: (snapshot.source ?? null) as ObjectSource | null,
    version: snapshot.version,
    createdAt: Number(snapshot.createdAt),
    createdBy: String(snapshot.createdBy),
    updatedAt: Number(snapshot.updatedAt),
    updatedBy: String(snapshot.updatedBy),
    rev: null,
    deleted: snapshot.alive !== true,
  };
}
export function readObjectVersion(
  db: Db,
  registry: Registry,
  input: { objectId: string; slot: string; targetId: string; version: number },
): VersionResult {
  return readOnly(db, () => {
    const currentRevision = revision(db);
    if (!Number.isInteger(input.version) || input.version < 1)
      throw new CommandError("INVALID_DATA", "版本号必须是正整数。", null);
    const bound = targets(db, registry, input.objectId, input.slot);
    authorize(bound, [input.targetId]);
    const current = bound.get(input.targetId)!;
    const unavailable = available(db, registry, current);
    if (unavailable)
      return { revision: currentRevision, ok: false, reason: unavailable };
    if (current.version === input.version)
      return { revision: currentRevision, ok: true, row: current };
    const candidates: HistoricalObjectRow[] = [];
    const history = db
      .prepare("SELECT changes FROM history ORDER BY seq")
      .all() as { changes: string }[];
    for (const entry of history)
      for (const change of JSON.parse(entry.changes) as Change[]) {
        if (change.table !== "objects" || change.id !== input.targetId)
          continue;
        for (const snapshot of [change.before, change.after]) {
          const row = fromSnapshot(snapshot);
          if (
            row &&
            !row.deleted &&
            row.id === input.targetId &&
            row.version === input.version
          )
            candidates.push(row);
        }
      }
    if (!candidates.length)
      return {
        revision: currentRevision,
        ok: false,
        reason: "这个版本的记录已被清理。",
      };
    if (
      candidates.some(
        (candidate) => !isDeepStrictEqual(candidate, candidates[0]),
      )
    )
      return {
        revision: currentRevision,
        ok: false,
        reason: "这个版本存在不一致的历史记录，无法确定内容。",
      };
    return { revision: currentRevision, ok: true, row: candidates[0]! };
  });
}
