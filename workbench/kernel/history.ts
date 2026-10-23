import { getMeta, setMeta, transaction, type Db } from "./db.ts";
import { CommandError } from "./errors.ts";
import { toObjectRow, toPresentationRow, toRelationRow } from "./rows.ts";
import type { Actor, Change, Snapshot } from "./types.ts";

const RECORD_LIMIT = 2000;
const BYTE_LIMIT = 64 * 1024 * 1024;
const AUDIT_LIMIT = 20_000;
const TABLES = new Set<Change["table"]>([
  "objects",
  "presentations",
  "relations",
  "settings",
  "packs",
]);
const IGNORED = new Set([
  "version",
  "rev",
  "updatedAt",
  "updatedBy",
  "updated_at",
  "updated_by",
]);

type Entry = {
  id: string;
  parentId: string | null;
  seq: number;
  changes: Change[];
};

type Link = { parentId: string | null; seq: number };

export function undo(
  db: Db,
  actor: Actor,
): { revision: number; cursorId: string | null } {
  return transaction(db, () => undoIn(db, actor));
}

export function redo(
  db: Db,
  actor: Actor,
): { revision: number; cursorId: string | null } {
  return transaction(db, () => redoIn(db, actor));
}

export function jump(
  db: Db,
  actor: Actor,
  entryId: string,
): { revision: number; cursorId: string | null } {
  return transaction(db, () => jumpIn(db, actor, entryId));
}

export function historyList(
  db: Db,
  limit: number,
): {
  cursorId: string | null;
  entries: {
    id: string;
    parentId: string | null;
    seq: number;
    label: string;
    actorKind: "human" | "agent";
    at: number;
    current: boolean;
    onCurrentPath: boolean;
  }[];
} {
  return transaction(db, () => listIn(db, limit));
}

export function pruneHistory(db: Db): void {
  try {
    transaction(db, () => pruneIn(db));
  } catch (error) {
    // 写入历史时外层事务已经打开。嵌套的 transaction 会直接拒绝，这时就地裁剪。
    if (
      error instanceof Error &&
      error.message === "不能在事务里再开启事务。"
    ) {
      pruneIn(db);
      return;
    }
    throw error;
  }
}

function undoIn(db: Db, actor: Actor) {
  const current = readCursor(db);
  if (!current) return { revision: readRevision(db), cursorId: null };
  const rev = bump(db);
  const now = Date.now();
  undoEntry(db, current, rev, actor, now);
  setCursor(db, current.parentId);
  return commitNavigation(
    db,
    actor,
    "undo",
    current.id,
    rev,
    now,
    current.parentId,
  );
}

function redoIn(db: Db, actor: Actor) {
  const cursor = cursorId(db);
  const child = cursor
    ? (db
        .prepare(
          "SELECT id FROM history WHERE parent_id = ? ORDER BY seq DESC LIMIT 1",
        )
        .get(cursor) as { id: string } | undefined)
    : (db
        .prepare(
          "SELECT id FROM history WHERE parent_id IS NULL ORDER BY seq DESC LIMIT 1",
        )
        .get() as { id: string } | undefined);
  if (!child) return { revision: readRevision(db), cursorId: cursor };
  const entry = mustEntry(db, child.id);
  const rev = bump(db);
  const now = Date.now();
  redoEntry(db, entry, rev, actor, now);
  setCursor(db, entry.id);
  return commitNavigation(db, actor, "redo", entry.id, rev, now, entry.id);
}

function jumpIn(db: Db, actor: Actor, entryId: string) {
  const map = links(db);
  if (!map.has(entryId))
    throw new CommandError(
      "NOT_FOUND",
      "没有这条历史记录。请刷新历史列表后再选择。",
      null,
    );
  const cursor = cursorId(db);
  if (cursor && !map.has(cursor))
    throw new CommandError(
      "INTERNAL",
      "历史游标指向的记录已经不在了，已停止。",
      null,
    );
  const shared = commonAncestor(map, cursor, entryId);
  const undos = walkUntil(map, cursor, shared);
  const redos = walkUntil(map, entryId, shared).reverse();
  if (undos.length === 0 && redos.length === 0)
    return { revision: readRevision(db), cursorId: cursor };
  const rev = bump(db);
  const now = Date.now();
  for (const id of undos) undoEntry(db, mustEntry(db, id), rev, actor, now);
  for (const id of redos) redoEntry(db, mustEntry(db, id), rev, actor, now);
  setCursor(db, entryId);
  return commitNavigation(db, actor, "jump", entryId, rev, now, entryId);
}

function listIn(db: Db, limit: number) {
  const cursor = cursorId(db);
  const onPath = currentPath(links(db), cursor);
  const rows = db
    .prepare(
      `SELECT id, parent_id, seq, label, actor_kind, at
       FROM history ORDER BY seq DESC LIMIT ?`,
    )
    .all(limit) as {
    id: string;
    parent_id: string | null;
    seq: number;
    label: string;
    actor_kind: string;
    at: number;
  }[];
  const entries = rows
    .map((row) => ({
      id: row.id,
      parentId: row.parent_id,
      seq: Number(row.seq),
      label: row.label,
      actorKind: kindOf(row.actor_kind),
      at: Number(row.at),
      current: row.id === cursor,
      onCurrentPath: onPath.has(row.id),
    }))
    .sort((a, b) => a.seq - b.seq);
  return { cursorId: cursor, entries };
}

function pruneIn(db: Db) {
  const cursor = getMeta(db, "history_cursor") ?? "";
  for (;;) {
    const size = db
      .prepare(
        "SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS bytes FROM history",
      )
      .get() as { n: number; bytes: number };
    if (Number(size.n) <= RECORD_LIMIT && Number(size.bytes) <= BYTE_LIMIT)
      break;
    const victim = db
      .prepare(
        `SELECT id FROM history
         WHERE parent_id IS NULL AND id <> ?
         ORDER BY seq ASC LIMIT 1`,
      )
      .get(cursor) as { id: string } | undefined;
    if (!victim) break;
    db.prepare("UPDATE history SET parent_id = NULL WHERE parent_id = ?").run(
      victim.id,
    );
    db.prepare("DELETE FROM history WHERE id = ?").run(victim.id);
  }
  db.prepare(
    `DELETE FROM audit WHERE seq < (
       SELECT seq FROM audit ORDER BY seq DESC LIMIT 1 OFFSET ?
     )`,
  ).run(AUDIT_LIMIT - 1);
}

function undoEntry(
  db: Db,
  entry: Entry,
  rev: number,
  actor: Actor,
  now: number,
) {
  refuseConflicts(db, entry.changes, "after", "撤销");
  for (let index = entry.changes.length - 1; index >= 0; index -= 1) {
    const change = entry.changes[index]!;
    applySnapshot(db, change.table, change.id, change.before, rev, actor, now);
  }
}

function redoEntry(
  db: Db,
  entry: Entry,
  rev: number,
  actor: Actor,
  now: number,
) {
  refuseConflicts(db, entry.changes, "before", "重做");
  for (const change of entry.changes)
    applySnapshot(db, change.table, change.id, change.after, rev, actor, now);
}

function refuseConflicts(
  db: Db,
  changes: Change[],
  side: "before" | "after",
  action: string,
) {
  const ids: string[] = [];
  for (const change of changes) {
    const current = currentSnapshot(db, change.table, change.id);
    if (sameContent(current, change[side])) continue;
    // 撤销创建会软删除并留下墓碑，before 仍是 null。墓碑和“当时还不存在”是同一状态。
    if (change[side] === null && current?.alive === false) continue;
    if (!ids.includes(change.id)) ids.push(change.id);
  }
  if (ids.length === 0) return;
  throw new CommandError(
    "HISTORY_CONFLICT",
    `这些内容在这条历史之后又被改过，不能${action}：${ids.join("、")}。请先查看它们现在的内容，或改回当时的状态后再试。`,
    null,
    { ids },
  );
}

function applySnapshot(
  db: Db,
  table: Change["table"],
  id: string,
  snapshot: Snapshot,
  rev: number,
  actor: Actor,
  now: number,
) {
  const alive = snapshot !== null && snapshot.alive !== false;
  if (table === "objects")
    return applyObject(db, id, snapshot, alive, rev, actor, now);
  if (table === "presentations")
    return applyPresentation(db, id, snapshot, alive, rev, actor, now);
  if (table === "relations")
    return applyRelation(db, id, snapshot, alive, rev, actor, now);
  if (table === "settings") return applySetting(db, id, snapshot, alive, rev);
  applyPack(db, id, snapshot, alive, rev);
}

function applyObject(
  db: Db,
  id: string,
  snapshot: Snapshot,
  alive: boolean,
  rev: number,
  actor: Actor,
  now: number,
) {
  if (!alive) {
    db.prepare(
      `UPDATE objects
       SET deleted_rev = ?, rev = ?, version = version + 1, updated_at = ?, updated_by = ?
       WHERE id = ?`,
    ).run(rev, rev, now, actor.id, id);
    return;
  }
  const fields = objectFields(snapshot);
  const updated = db
    .prepare(
      `UPDATE objects SET
         type = ?, type_version = ?, title = ?, data = ?, source = ?,
         created_at = ?, created_by = ?,
         version = version + 1, updated_at = ?, updated_by = ?,
         rev = ?, deleted_rev = NULL
       WHERE id = ?`,
    )
    .run(
      fields.type,
      fields.typeVersion,
      fields.title,
      fields.data,
      fields.source,
      fields.createdAt,
      fields.createdBy,
      now,
      actor.id,
      rev,
      id,
    );
  if (Number(updated.changes) > 0) return;
  db.prepare(
    `INSERT INTO objects (
       id, type, type_version, title, data, source, version,
       created_at, created_by, updated_at, updated_by, rev
     ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    fields.type,
    fields.typeVersion,
    fields.title,
    fields.data,
    fields.source,
    fields.createdAt,
    fields.createdBy,
    now,
    actor.id,
    rev,
  );
}

function applyPresentation(
  db: Db,
  id: string,
  snapshot: Snapshot,
  alive: boolean,
  rev: number,
  actor: Actor,
  now: number,
) {
  if (!alive) {
    db.prepare(
      `UPDATE presentations
       SET deleted_rev = ?, rev = ?, version = version + 1, updated_at = ?, updated_by = ?
       WHERE id = ?`,
    ).run(rev, rev, now, actor.id, id);
    return;
  }
  const fields = presentationFields(snapshot);
  const updated = db
    .prepare(
      `UPDATE presentations SET
         board_id = ?, object_id = ?, parent_id = ?, x = ?, y = ?, width = ?, height = ?,
         z = ?, locked = ?, appearance = ?,
         version = version + 1, updated_at = ?, updated_by = ?,
         rev = ?, deleted_rev = NULL
       WHERE id = ?`,
    )
    .run(
      fields.boardId,
      fields.objectId,
      fields.parentId,
      fields.x,
      fields.y,
      fields.width,
      fields.height,
      fields.z,
      fields.locked,
      fields.appearance,
      now,
      actor.id,
      rev,
      id,
    );
  if (Number(updated.changes) > 0) return;
  db.prepare(
    `INSERT INTO presentations (
       id, board_id, object_id, parent_id, x, y, width, height, z, locked, appearance,
       version, updated_at, updated_by, rev
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
  ).run(
    id,
    fields.boardId,
    fields.objectId,
    fields.parentId,
    fields.x,
    fields.y,
    fields.width,
    fields.height,
    fields.z,
    fields.locked,
    fields.appearance,
    now,
    actor.id,
    rev,
  );
}

function applyRelation(
  db: Db,
  id: string,
  snapshot: Snapshot,
  alive: boolean,
  rev: number,
  actor: Actor,
  now: number,
) {
  if (!alive) {
    db.prepare(
      `UPDATE relations
       SET deleted_rev = ?, rev = ?, version = version + 1, updated_at = ?, updated_by = ?
       WHERE id = ?`,
    ).run(rev, rev, now, actor.id, id);
    return;
  }
  const fields = relationFields(snapshot);
  const updated = db
    .prepare(
      `UPDATE relations SET
         kind = ?, source_id = ?, target_id = ?, status = ?, basis = ?,
         attributes = ?, evidence = ?, created_at = ?, created_by = ?,
         version = version + 1, updated_at = ?, updated_by = ?,
         rev = ?, deleted_rev = NULL
       WHERE id = ?`,
    )
    .run(
      fields.kind,
      fields.sourceId,
      fields.targetId,
      fields.status,
      fields.basis,
      fields.attributes,
      fields.evidence,
      fields.createdAt,
      fields.createdBy,
      now,
      actor.id,
      rev,
      id,
    );
  if (Number(updated.changes) > 0) return;
  db.prepare(
    `INSERT INTO relations (
       id, kind, source_id, target_id, status, basis, attributes, evidence,
       version, created_at, created_by, updated_at, updated_by, rev
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    fields.kind,
    fields.sourceId,
    fields.targetId,
    fields.status,
    fields.basis,
    fields.attributes,
    fields.evidence,
    fields.createdAt,
    fields.createdBy,
    now,
    actor.id,
    rev,
  );
}

function applySetting(
  db: Db,
  id: string,
  snapshot: Snapshot,
  alive: boolean,
  rev: number,
) {
  if (!alive) {
    db.prepare(
      "UPDATE settings SET deleted_rev = ?, rev = ? WHERE key = ?",
    ).run(rev, rev, id);
    return;
  }
  const value = jsonText(record(snapshot).value, "value");
  const updated = db
    .prepare(
      "UPDATE settings SET value = ?, rev = ?, deleted_rev = NULL WHERE key = ?",
    )
    .run(value, rev, id);
  if (Number(updated.changes) > 0) return;
  db.prepare("INSERT INTO settings (key, value, rev) VALUES (?, ?, ?)").run(
    id,
    value,
    rev,
  );
}

function applyPack(
  db: Db,
  id: string,
  snapshot: Snapshot,
  alive: boolean,
  rev: number,
) {
  if (!alive) {
    db.prepare("UPDATE packs SET deleted_rev = ?, rev = ? WHERE id = ?").run(
      rev,
      rev,
      id,
    );
    return;
  }
  // packs.version 是包的版本号，快照里已经有，不能当成行版本再加一。
  const body = record(snapshot);
  const kind = text(body, "kind");
  const version = num(body, "version");
  const enabled = bool(body, "enabled") ? 1 : 0;
  const manifest =
    body.manifest == null ? null : jsonText(body.manifest, "manifest");
  const updated = db
    .prepare(
      `UPDATE packs SET
         kind = ?, version = ?, enabled = ?, manifest = ?, rev = ?, deleted_rev = NULL
       WHERE id = ?`,
    )
    .run(kind, version, enabled, manifest, rev, id);
  if (Number(updated.changes) > 0) return;
  db.prepare(
    `INSERT INTO packs (id, kind, version, enabled, manifest, rev)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, kind, version, enabled, manifest, rev);
}

function objectFields(snapshot: Snapshot) {
  const body = record(snapshot);
  return {
    type: text(body, "type"),
    typeVersion: num(body, "typeVersion"),
    title: text(body, "title"),
    data: jsonText(body.data, "data"),
    source: body.source == null ? null : jsonText(body.source, "source"),
    createdAt: num(body, "createdAt"),
    createdBy: text(body, "createdBy"),
  };
}

function presentationFields(snapshot: Snapshot) {
  const body = record(snapshot);
  return {
    boardId: text(body, "boardId"),
    objectId: text(body, "objectId"),
    parentId: textOrNull(body, "parentId"),
    x: num(body, "x"),
    y: num(body, "y"),
    width: num(body, "width"),
    height: num(body, "height"),
    z: num(body, "z"),
    locked: bool(body, "locked") ? 1 : 0,
    appearance: jsonText(body.appearance, "appearance"),
  };
}

function relationFields(snapshot: Snapshot) {
  const body = record(snapshot);
  const status = text(body, "status");
  if (status !== "confirmed" && status !== "inferred")
    throw new CommandError(
      "INTERNAL",
      "历史快照里的关系状态无法识别，已取消。",
      null,
    );
  return {
    kind: text(body, "kind"),
    sourceId: text(body, "sourceId"),
    targetId: text(body, "targetId"),
    status,
    basis: textOrNull(body, "basis"),
    attributes: jsonText(body.attributes, "attributes"),
    evidence: jsonText(body.evidence, "evidence"),
    createdAt: num(body, "createdAt"),
    createdBy: text(body, "createdBy"),
  };
}

function currentSnapshot(db: Db, table: Change["table"], id: string): Snapshot {
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
  return {
    id: String(row.id),
    kind: String(row.kind),
    version: Number(row.version),
    enabled: row.enabled === 1,
    manifest: row.manifest == null ? null : JSON.parse(String(row.manifest)),
    alive: row.deleted_rev == null,
  };
}

function sameContent(left: Snapshot, right: Snapshot) {
  if (left === null || right === null) return left === right;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (IGNORED.has(key)) continue;
    if (!deepEqual(left[key], right[key])) return false;
  }
  return true;
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    return left.every((item, index) => deepEqual(item, right[index]));
  }
  if (typeof left === "object" && typeof right === "object") {
    const a = left as Record<string, unknown>;
    const b = right as Record<string, unknown>;
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      if (!deepEqual(a[key], b[key])) return false;
    }
    return true;
  }
  return false;
}

function readCursor(db: Db): Entry | null {
  const id = cursorId(db);
  if (!id) return null;
  return mustEntry(db, id);
}

function mustEntry(db: Db, id: string): Entry {
  const entry = readEntry(db, id);
  if (!entry)
    throw new CommandError("INTERNAL", "历史记录已经不在了，已取消。", null);
  return entry;
}

function readEntry(db: Db, id: string): Entry | null {
  const row = db
    .prepare("SELECT id, parent_id, seq, changes FROM history WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(row.changes));
  } catch (error) {
    throw new CommandError(
      "INTERNAL",
      "历史记录里的修改内容无法读取，已取消。",
      null,
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
  if (!Array.isArray(parsed) || !parsed.every(isChange))
    throw new CommandError(
      "INTERNAL",
      "历史记录里的修改内容无法读取，已取消。",
      null,
    );
  return {
    id: String(row.id),
    parentId: row.parent_id == null ? null : String(row.parent_id),
    seq: Number(row.seq),
    changes: parsed,
  };
}

function isChange(value: unknown): value is Change {
  if (!value || typeof value !== "object") return false;
  const change = value as Change;
  return TABLES.has(change.table) && typeof change.id === "string";
}

function links(db: Db) {
  const rows = db.prepare("SELECT id, parent_id, seq FROM history").all() as {
    id: string;
    parent_id: string | null;
    seq: number;
  }[];
  const map = new Map<string, Link>();
  for (const row of rows)
    map.set(row.id, { parentId: row.parent_id, seq: Number(row.seq) });
  return map;
}

function commonAncestor(
  map: Map<string, Link>,
  cursor: string | null,
  target: string,
) {
  const seen = new Set(walkUntil(map, cursor, null));
  for (const id of walkUntil(map, target, null)) {
    if (seen.has(id)) return id;
  }
  return null;
}

function walkUntil(
  map: Map<string, Link>,
  start: string | null,
  stop: string | null,
) {
  const chain: string[] = [];
  const seen = new Set<string>();
  let node = start;
  while (node && node !== stop && !seen.has(node)) {
    seen.add(node);
    chain.push(node);
    const parent = map.get(node)?.parentId ?? null;
    node = parent;
  }
  return chain;
}

function currentPath(map: Map<string, Link>, cursor: string | null) {
  const ids = new Set(walkUntil(map, cursor, null));
  if (cursor && !map.has(cursor)) return ids;
  const next = new Map<string, { id: string; seq: number }>();
  for (const [id, link] of map) {
    if (!link.parentId) continue;
    const previous = next.get(link.parentId);
    if (!previous || link.seq > previous.seq)
      next.set(link.parentId, { id, seq: link.seq });
  }
  // 游标为空时，重做从 seq 最大的根记录开始，这条路径也要标成当前路径。
  let node = cursor;
  if (!node) {
    let root: { id: string; seq: number } | null = null;
    for (const [id, link] of map) {
      if (link.parentId) continue;
      if (!root || link.seq > root.seq) root = { id, seq: link.seq };
    }
    if (!root) return ids;
    ids.add(root.id);
    node = root.id;
  }
  const seen = new Set<string>();
  while (node && !seen.has(node)) {
    seen.add(node);
    const child = next.get(node);
    if (!child) break;
    ids.add(child.id);
    node = child.id;
  }
  return ids;
}

function cursorId(db: Db): string | null {
  const value = getMeta(db, "history_cursor") ?? "";
  return value === "" ? null : value;
}

function setCursor(db: Db, id: string | null) {
  setMeta(db, "history_cursor", id ?? "");
}

function readRevision(db: Db) {
  const raw = getMeta(db, "revision") ?? "0";
  if (!/^\d+$/.test(raw))
    throw new CommandError("INTERNAL", "修订号损坏，已停止。", null);
  return Number(raw);
}

function bump(db: Db) {
  const next = readRevision(db) + 1;
  setMeta(db, "revision", String(next));
  return next;
}

function commitNavigation(
  db: Db,
  actor: Actor,
  action: "undo" | "redo" | "jump",
  historyId: string,
  rev: number,
  now: number,
  cursor: string | null,
) {
  writeAudit(db, actor, action, historyId, rev, now);
  // 导航不新增历史记录，审计条数仍要守住上限。
  pruneHistory(db);
  return { revision: rev, cursorId: cursor };
}

function writeAudit(
  db: Db,
  actor: Actor,
  action: "undo" | "redo" | "jump",
  historyId: string,
  rev: number,
  now: number,
) {
  db.prepare(
    `INSERT INTO audit (at, actor, actor_kind, action, history_id, detail)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    now,
    actor.id,
    actor.kind,
    action,
    historyId,
    JSON.stringify({ revision: rev }),
  );
}

function kindOf(value: string): "human" | "agent" {
  if (value === "human" || value === "agent") return value;
  throw new CommandError(
    "INTERNAL",
    "历史记录里的操作者类型无法识别，已停止读取。",
    null,
  );
}

function record(snapshot: Snapshot): Record<string, unknown> {
  if (snapshot === null)
    throw new CommandError("INTERNAL", "历史快照是空的，已取消。", null);
  return snapshot;
}

function text(snapshot: Record<string, unknown>, key: string) {
  const value = snapshot[key];
  if (typeof value !== "string")
    throw new CommandError(
      "INTERNAL",
      `历史快照里的「${key}」不是文字，已取消。`,
      null,
    );
  return value;
}

function textOrNull(snapshot: Record<string, unknown>, key: string) {
  const value = snapshot[key];
  if (value == null) return null;
  if (typeof value !== "string")
    throw new CommandError(
      "INTERNAL",
      `历史快照里的「${key}」不是文字，已取消。`,
      null,
    );
  return value;
}

function num(snapshot: Record<string, unknown>, key: string) {
  const value = snapshot[key];
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new CommandError(
      "INTERNAL",
      `历史快照里的「${key}」不是数字，已取消。`,
      null,
    );
  return value;
}

function bool(snapshot: Record<string, unknown>, key: string) {
  const value = snapshot[key];
  if (typeof value !== "boolean")
    throw new CommandError(
      "INTERNAL",
      `历史快照里的「${key}」不是是否，已取消。`,
      null,
    );
  return value;
}

function jsonText(value: unknown, key: string) {
  if (value === undefined)
    throw new CommandError(
      "INTERNAL",
      `历史快照缺少「${key}」，已取消。`,
      null,
    );
  return JSON.stringify(value);
}
