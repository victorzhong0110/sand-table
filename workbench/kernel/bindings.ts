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
  tableFilters?: { id: string; data: Record<string, unknown> }[];
  tableConsumers?: { id: string; title: string }[];
  tableSource?: string;
  chartScopes?: { id: string; keys: string[] | null }[];
};
export type BindingsResult = {
  revision: number;
  items: BindingItem[];
  nextCursor: string | null;
};
export type GraphNode = {
  id: string;
  title: string;
  type: string;
  version: number;
  icon: string;
  depth: number;
};
export type GraphEdge = {
  id: string;
  kind: string;
  title: string;
  sourceId: string;
  targetId: string;
  status: "confirmed" | "inferred";
};
export type ExpandedBindings = {
  revision: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  kinds: { kind: string; title: string }[];
  truncated: boolean;
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
      `SELECT r.cascade_object_id, r.deleted_rev AS relation_deleted_rev, o.* FROM relations r JOIN objects o ON o.id = r.${other} WHERE r.${mine} = ? AND r.kind = ? ORDER BY o.id, r.id`,
    )
    .all(objectId, slot.kind) as Raw[];
  const result = new Map<string, ObjectRow>();
  for (const rawTarget of relations) {
    const row = toObjectRow(rawTarget);
    if (slot.targetTypes?.length && !slot.targetTypes.includes(row.type))
      continue;
    if (
      rawTarget.relation_deleted_rev != null &&
      !(row.deleted && rawTarget.cascade_object_id === row.id)
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

function inbound(db: Db, id: string, kind: string, types: string[]): Raw[] {
  const rows = db
    .prepare(
      `SELECT o.* FROM objects o WHERE o.deleted_rev IS NULL
     AND o.type IN (SELECT value FROM json_each(?))
     AND o.id IN (SELECT source_id FROM relations WHERE deleted_rev IS NULL AND kind = ? AND target_id = ?)
     ORDER BY o.id LIMIT 201`,
    )
    .all(JSON.stringify(types), kind, id) as Raw[];
  if (rows.length > 200)
    throw new CommandError(
      "LIMIT",
      "已连接对象超过 200 个，请缩小组件范围。",
      null,
    );
  return rows;
}

function chartTable(
  db: Db,
  registry: Registry,
  chart: string,
): string | undefined {
  const rows = [...targets(db, registry, chart, "source").values()].filter(
    (row) => !available(db, registry, row),
  );
  return rows.length === 1 ? rows[0].id : undefined;
}

function activeRowScope(value: unknown): string[] | null {
  return Array.isArray(value) &&
    value.length <= 200 &&
    value.every((key) => typeof key === "string")
    ? value
    : null;
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
    const reader = object(db, input.objectId)?.type;
    const dataView =
      (reader === "base.table" && input.slot === "self") ||
      ((reader === "base.chart" || reader === "base.metric") &&
        input.slot === "source");
    return {
      revision: revision(db),
      items: page.map((row) => {
        const item = readItem(db, registry, row, input.fields);
        if (item.unavailable) return item;
        if (
          reader === "base.chart" &&
          row.type === "base.chart" &&
          (input.slot === "highlights" || input.slot === "highlightedBy")
        )
          item.tableSource = chartTable(db, registry, row.id);
        if (row.type !== "base.table") return item;
        if (dataView)
          item.tableFilters = inbound(db, row.id, "base.filters", [
            "base.filter",
          ])
            .map((raw) =>
              readItem(db, registry, toObjectRow(raw), [
                "column",
                "op",
                "value",
                "upper",
              ]),
            )
            .filter((filter) => !filter.unavailable && !filter.migrationError)
            .map(({ id, data }) => ({ id, data }));
        if (reader === "base.filter" && input.slot === "targets")
          item.tableConsumers = inbound(db, row.id, "base.data_source", [
            "base.chart",
            "base.metric",
          ]).map((raw) => ({ id: String(raw.id), title: String(raw.title) }));
        if (reader === "base.chart" && input.slot === "source")
          item.chartScopes = inbound(db, input.objectId, "base.filters", [
            "base.chart",
          ])
            .map(toObjectRow)
            .map(({ id, data }) => ({
              id,
              keys:
                chartTable(db, registry, id) === row.id
                  ? activeRowScope(data.rowScope)
                  : null,
            }));
        return item;
      }),
      nextCursor: selected.length > limit ? page.at(-1)!.id : null,
    };
  });
}

const GRAPH_TYPE = "base.relation_graph";
const FOCUS_KIND = "base.graph_focus";
const NODE_LIMIT = 200;
const EDGE_LIMIT = 1000;

export function expandBindings(
  db: Db,
  registry: Registry,
  input: { objectId: string; slot: string },
): ExpandedBindings {
  return readOnly(db, () => {
    const reader = object(db, input.objectId);
    if (
      reader?.type !== GRAPH_TYPE ||
      reader.deleted_rev != null ||
      input.slot !== "focus" ||
      registry.getPack("base")?.kind !== "builtin" ||
      !isPackEnabled(db, "base")
    )
      fail("只有启用的内置关系图能展开中心关系。");
    const graph = migrateRow(registry, toObjectRow(reader));
    if ("migrationError" in graph) fail("关系图配置无法读取，请检查组件版本。");
    const depth = graph.data.depth === 3 ? 3 : graph.data.depth === 2 ? 2 : 1;
    const packs = registry
      .listPacks()
      .filter(({ spec }) => isPackEnabled(db, spec.id));
    const icons = new Map(
      packs.flatMap(({ spec }) =>
        (spec.types ?? []).map(({ type, icon }) => [type, icon] as const),
      ),
    );
    const kinds = packs
      .flatMap(({ spec }) => spec.relationKinds ?? [])
      .filter(({ kind }) => kind !== FOCUS_KIND)
      .map(({ kind, title }) => ({ kind, title }));
    const selected = Array.isArray(graph.data.kinds) ? graph.data.kinds : [];
    const activeKinds = new Map(
      kinds
        .filter(({ kind }) => !selected.length || selected.includes(kind))
        .map(({ kind, title }) => [kind, title]),
    );
    const nodeTypes = JSON.stringify([...icons.keys()]);
    const relationKinds = JSON.stringify([...activeKinds.keys()]);
    type NodeRow = Omit<GraphNode, "depth" | "icon">;
    type EdgeRow = Omit<GraphEdge, "title">;
    const centers = db
      .prepare(
        `SELECT DISTINCT o.id, o.title, o.type, o.version
         FROM relations r JOIN objects o ON o.id = r.target_id
         WHERE r.source_id = ? AND r.kind = ? AND r.deleted_rev IS NULL
           AND o.deleted_rev IS NULL AND o.type IN (SELECT value FROM json_each(?))
         ORDER BY o.id LIMIT ?`,
      )
      .all(input.objectId, FOCUS_KIND, nodeTypes, NODE_LIMIT + 1) as NodeRow[];
    const neighbors = db.prepare(
      `WITH incident(id) AS (
         SELECT r.target_id FROM relations r
          WHERE r.deleted_rev IS NULL AND r.source_id IN (SELECT value FROM json_each(?))
            AND r.kind IN (SELECT value FROM json_each(?))
         UNION
         SELECT r.source_id FROM relations r
          WHERE r.deleted_rev IS NULL AND r.target_id IN (SELECT value FROM json_each(?))
            AND r.kind IN (SELECT value FROM json_each(?))
       )
       SELECT o.id, o.title, o.type, o.version FROM incident i JOIN objects o ON o.id = i.id
       WHERE o.deleted_rev IS NULL AND o.type IN (SELECT value FROM json_each(?))
         AND o.id NOT IN (SELECT value FROM json_each(?))
       ORDER BY o.id LIMIT ?`,
    );
    const nodes = new Map<string, GraphNode>();
    function add(rows: NodeRow[], level: number) {
      const count = NODE_LIMIT - nodes.size;
      const accepted = rows.slice(0, count);
      for (const row of accepted)
        nodes.set(row.id, { ...row, icon: icons.get(row.type)!, depth: level });
      return {
        frontier: accepted.map(({ id }) => id),
        overflow: rows.length > count,
      };
    }
    let { frontier, overflow: truncated } = add(centers, 0);
    for (
      let level = 1;
      level <= depth && frontier.length && !truncated;
      level++
    ) {
      const ids = JSON.stringify(frontier);
      const rows = neighbors.all(
        ids,
        relationKinds,
        ids,
        relationKinds,
        nodeTypes,
        JSON.stringify([...nodes.keys()]),
        NODE_LIMIT - nodes.size + 1,
      ) as NodeRow[];
      ({ frontier, overflow: truncated } = add(rows, level));
    }
    const endpoints = JSON.stringify([...nodes.keys()]);
    const edges = db
      .prepare(
        `SELECT id, kind, source_id AS sourceId, target_id AS targetId, status
         FROM relations WHERE deleted_rev IS NULL
           AND source_id IN (SELECT value FROM json_each(?))
           AND target_id IN (SELECT value FROM json_each(?))
           AND kind IN (SELECT value FROM json_each(?))
         ORDER BY id LIMIT ?`,
      )
      .all(endpoints, endpoints, relationKinds, EDGE_LIMIT + 1) as EdgeRow[];
    return {
      revision: revision(db),
      nodes: [...nodes.values()],
      edges: edges
        .slice(0, EDGE_LIMIT)
        .map((edge) => ({ ...edge, title: activeKinds.get(edge.kind)! })),
      kinds,
      truncated: truncated || edges.length > EDGE_LIMIT,
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
    const candidates = [...objectHistory(db, input.targetId)].filter(
      (row) => row.version === input.version,
    );
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

function* objectHistory(db: Db, id: string) {
  const history = db
    .prepare("SELECT changes FROM history ORDER BY seq")
    .iterate() as Iterable<{ changes: string }>;
  for (const entry of history)
    for (const change of JSON.parse(entry.changes) as Change[]) {
      if (change.table !== "objects" || change.id !== id) continue;
      for (const snapshot of [change.before, change.after]) {
        const row = fromSnapshot(snapshot);
        if (row && !row.deleted && row.id === id) yield row;
      }
    }
}

export function listObjectVersions(
  db: Db,
  registry: Registry,
  objectId: string,
) {
  return readOnly(db, () => {
    const current = targets(db, registry, objectId, "self").get(objectId);
    if (!current)
      throw new CommandError("NOT_FOUND", "找不到要比较的对象。", null);
    const unavailable = available(db, registry, current);
    if (unavailable) throw new CommandError("NOT_FOUND", unavailable, null);
    const known = new Map<number, HistoricalObjectRow>();
    const ambiguous = new Set<number>();
    for (const row of objectHistory(db, objectId)) {
      const previous = known.get(row.version);
      if (previous && !isDeepStrictEqual(previous, row))
        ambiguous.add(row.version);
      else known.set(row.version, row);
    }
    const versions = [...known.values()]
      .filter(
        (row) => row.version !== current.version && !ambiguous.has(row.version),
      )
      .map((row) => ({ version: row.version, at: row.updatedAt }))
      .sort((a, b) => b.version - a.version);
    return {
      current: current.version,
      truncated: versions.length > 100,
      versions: versions.slice(0, 100),
    };
  });
}
