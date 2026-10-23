import { getMeta, setMeta, type Db } from "./db.ts";
import { CommandError } from "./errors.ts";
import { newId } from "./ids.ts";
import type { Change, Command, CommandBatch, Snapshot } from "./types.ts";

const MERGE_WINDOW_MS = 15 * 60 * 1000;

/**
 * 每次写入都会改 version / updatedAt / updatedBy。
 * 合并时比的是内容：这些记账字段相同与否不决定这条修改还在不在。
 */
const BOOKKEEPING = new Set(["version", "updatedAt", "updatedBy"]);

export function historyKind(commands: Command[]): string {
  if (commands.every(isCreate)) return "create";
  if (commands.every(isDelete)) return "delete";
  if (
    commands.length > 0 &&
    commands.every(
      (command) =>
        command.op === "presentation.update" && changesGeometry(command),
    )
  )
    return "move";
  if (commands.every((command) => command.op.startsWith("pack.")))
    return "pack";
  if (commands.every((command) => command.op === "setting.set"))
    return "setting";
  return "edit";
}

export function recordHistory(
  db: Db,
  batch: CommandBatch,
  changes: Change[],
  label: string,
  kind: string,
  now: number,
): string | null {
  const intentId = batch.intentId;
  if (!intentId) {
    throw new CommandError("INTERNAL", "历史记录缺少 intentId。", null);
  }
  const cursor = getMeta(db, "history_cursor") ?? "";
  const current = cursor ? readHistory(db, cursor) : undefined;
  if (current && canMerge(db, current, batch, intentId, now)) {
    const merged = coalesce([...current.changes, ...changes]);
    if (merged.length === 0) {
      db.prepare("DELETE FROM history WHERE id = ?").run(current.id);
      setMeta(db, "history_cursor", current.parentId ?? "");
      return null;
    }
    writeChanges(db, current.id, merged, now);
    return current.id;
  }
  const incoming = coalesce(changes);
  if (incoming.length === 0) return null;
  const id = newId();
  const seqRow = db
    .prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM history")
    .get() as {
    seq: number;
  };
  const json = JSON.stringify(incoming);
  db.prepare(
    `INSERT INTO history (
       id, parent_id, seq, intent_id, label, kind, actor, actor_kind, at, changes, bytes
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    current ? current.id : null,
    Number(seqRow.seq) + 1,
    intentId,
    label,
    kind,
    batch.actor.id,
    batch.actor.kind,
    now,
    json,
    Buffer.byteLength(json),
  );
  setMeta(db, "history_cursor", id);
  return id;
}

function isCreate(command: Command) {
  return (
    command.op === "object.create" ||
    command.op === "object.clone" ||
    command.op === "presentation.create" ||
    command.op === "relation.create"
  );
}

function isDelete(command: Command) {
  return (
    command.op === "object.delete" ||
    command.op === "presentation.delete" ||
    command.op === "relation.delete"
  );
}

function changesGeometry(command: Command) {
  if (command.op !== "presentation.update") return false;
  return (
    command.x !== undefined ||
    command.y !== undefined ||
    command.width !== undefined ||
    command.height !== undefined
  );
}

type HistoryRow = {
  id: string;
  parentId: string | null;
  intentId: string;
  actor: string;
  actorKind: string;
  at: number;
  changes: Change[];
};

function readHistory(db: Db, id: string): HistoryRow | undefined {
  const row = db.prepare("SELECT * FROM history WHERE id = ?").get(id) as
    Record<string, unknown> | undefined;
  if (!row) return undefined;
  let changes: Change[];
  try {
    changes = JSON.parse(String(row.changes)) as Change[];
  } catch (error) {
    throw new CommandError(
      "INTERNAL",
      "历史记录里的修改内容无法读取，这次写入已取消。",
      null,
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
  return {
    id: String(row.id),
    parentId: row.parent_id == null ? null : String(row.parent_id),
    intentId: String(row.intent_id),
    actor: String(row.actor),
    actorKind: String(row.actor_kind),
    at: Number(row.at),
    changes,
  };
}

function canMerge(
  db: Db,
  current: HistoryRow,
  batch: CommandBatch,
  intentId: string,
  now: number,
) {
  if (current.intentId !== intentId) return false;
  if (
    current.actor !== batch.actor.id ||
    current.actorKind !== batch.actor.kind
  )
    return false;
  if (now < current.at || now - current.at > MERGE_WINDOW_MS) return false;
  const child = db
    .prepare("SELECT 1 AS hit FROM history WHERE parent_id = ? LIMIT 1")
    .get(current.id) as { hit: number } | undefined;
  return !child;
}

function writeChanges(db: Db, id: string, changes: Change[], now: number) {
  const json = JSON.stringify(changes);
  db.prepare(
    "UPDATE history SET changes = ?, bytes = ?, at = ? WHERE id = ?",
  ).run(json, Buffer.byteLength(json), now, id);
}

function coalesce(changes: Change[]): Change[] {
  const order: string[] = [];
  const map = new Map<string, Change>();
  for (const change of changes) {
    const key = `${change.table}\0${change.id}`;
    const previous = map.get(key);
    if (!previous) {
      order.push(key);
      map.set(key, {
        table: change.table,
        id: change.id,
        before: change.before,
        after: change.after,
      });
      continue;
    }
    previous.after = change.after;
  }
  return order
    .map((key) => map.get(key)!)
    .filter((change) => !sameContent(change.before, change.after));
}

function sameContent(before: Snapshot, after: Snapshot) {
  return contentKey(before) === contentKey(after);
}

function contentKey(snapshot: Snapshot) {
  if (snapshot === null) return "null";
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(snapshot)) {
    if (!BOOKKEEPING.has(key)) copy[key] = value;
  }
  return stable(copy);
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
