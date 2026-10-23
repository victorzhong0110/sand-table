import { getMeta, transaction, type Db } from "./db.ts";
import { CommandError } from "./errors.ts";
import { isPackEnabled } from "./packs-state.ts";
import type { Registry } from "./registry.ts";
import { toObjectRow, toPresentationRow, toRelationRow } from "./rows.ts";
import { summarize } from "./text.ts";
import type {
  Actor,
  ObjectRow,
  PresentationRow,
  RelationRow,
  TypeSpec,
} from "./types.ts";

const TIPS = [
  "Call sand_types before creating objects of a type you have not used.",
  "Call sand_context to see what the person is looking at.",
];
const BOARD_LIMIT = 50;
const QUERY_DEFAULT = 20;
const QUERY_MAX = 50;
const READ_MAX = 20;
const TEXT_DEFAULT = 8000;
const TEXT_MAX = 20_000;
const RELATION_LIMIT = 50;
const TYPE_FILTER_MAX = 20;
const HUMAN_EDIT_LIMIT = 20;
const OBJECT_ID_LIMIT = 10;
const ACTIVITY_OBJECT_LIMIT = 30;
const TASK_LIMIT = 300;
const ACTION_LIMIT = 200;
const DONE_TTL_MS = 2 * 60 * 1000;
const ACTIVITY_TTL_MS = 10 * 60 * 1000;
const ACTIVITY_STATES = new Set(["running", "waiting", "done", "unknown"]);

export type StatusResult = {
  workspace: { id: string; title: string; revision: number };
  homeBoardId: string | null;
  boards: { id: string; title: string; presentations: number }[];
  packs: { id: string; title: string; enabled: boolean }[];
  tips: string[];
};

export type TypesResult =
  | {
      types: {
        type: string;
        title: string;
        description: string;
        pack: string;
        container: boolean;
      }[];
      relationKinds: {
        kind: string;
        title: string;
        inverseTitle: string;
        allowsInferred: boolean;
        requiresBasis: boolean;
      }[];
      templates: { id: string; title: string; pack: string }[];
    }
  | { types: ReturnType<typeof fullType>[] };

export type QueryFilter = {
  boardId?: string;
  types?: string[];
  text?: string;
  relatedTo?: { id: string; kind?: string; direction?: "out" | "in" | "both" };
  order?: "updated" | "title";
  limit?: number;
  cursor?: string;
};

export type QueryRow = {
  id: string;
  type: string;
  title: string;
  summary: string;
  version: number;
  updatedAt: number;
  typeAvailable: boolean;
};

export type ReadOptions = {
  include?: ("presentations" | "relations")[];
  textLimit?: number;
  textOffset?: { id: string; field: string; offset: number };
};

export type ReadResult = {
  objects: {
    id: string;
    type: string;
    title: string;
    data: Record<string, unknown>;
    source: ObjectRow["source"];
    version: number;
    typeAvailable: boolean;
    truncated: { field: string; totalLength: number }[];
    presentations: { id: string; boardId: string; boardTitle: string }[];
    relations: {
      id: string;
      kind: string;
      direction: "out" | "in";
      otherId: string;
      otherTitle: string;
      status: "confirmed" | "inferred";
      basis: string | null;
    }[];
  }[];
  missing: string[];
};

export type BoardContents = {
  revision: number;
  board: ObjectRow;
  presentations: PresentationRow[];
  objects: ObjectRow[];
  relations: RelationRow[];
  settings: { key: string; value: unknown }[];
  packs: { id: string; kind: string; version: number; enabled: boolean }[];
};

export type ChangesResult = {
  revision: number;
  objects: ObjectRow[];
  presentations: PresentationRow[];
  relations: RelationRow[];
  settings: { key: string; value: unknown; rev: number; deleted: boolean }[];
  packs: {
    id: string;
    kind: string;
    version: number;
    enabled: boolean;
    manifest: unknown;
    rev: number;
    deleted: boolean;
  }[];
};

export type ResetResult = { reset: true; revision: number };

export type ChangesSinceResult = ChangesResult | ResetResult;

export type ContextResult = {
  board: { id: string; title: string } | null;
  selection: {
    presentationId: string;
    objectId: string;
    type: string;
    title: string;
  }[];
  recentHumanEdits: { label: string; at: number; objectIds: string[] }[];
  otherAgents: {
    actor: string;
    state: "running" | "waiting" | "done" | "unknown";
    task: string;
  }[];
  revision: number;
};

export type ActivityInput = {
  state: "running" | "waiting" | "done" | "unknown";
  task: string;
  action: string;
  objectIds?: string[];
  boardId?: string;
};

export type ViewInput = {
  viewId: string;
  boardId?: string;
  camera?: unknown;
  selection?: string[];
  navStack?: unknown[];
};

export function status(db: Db, registry: Registry): StatusResult {
  return readOnly(db, () => {
    const homeBoardId = metaText(db, "home_board_id");
    const containers = containerTypes(registry);
    const params: string[] = [];
    const boardClauses = ["type = 'base.board'"];
    if (homeBoardId) {
      boardClauses.push("id = ?");
      params.push(homeBoardId);
    }
    if (containers.length > 0) {
      boardClauses.push(`type IN (${containers.map(() => "?").join(", ")})`);
      params.push(...containers);
    }
    const boards = (
      db
        .prepare(
          `SELECT id, title,
             (SELECT COUNT(*) FROM presentations
              WHERE board_id = objects.id AND deleted_rev IS NULL) AS presentations
           FROM objects
           WHERE deleted_rev IS NULL AND (${boardClauses.join(" OR ")})
           ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, updated_at DESC, id ASC
           LIMIT ?`,
        )
        .all(...params, homeBoardId ?? "", BOARD_LIMIT) as {
        id: string;
        title: string;
        presentations: number;
      }[]
    ).map((row) => ({
      id: String(row.id),
      title: String(row.title),
      presentations: Number(row.presentations),
    }));
    return {
      workspace: {
        id: requiredMeta(db, "workspace_id", "工作空间编号"),
        title: requiredMeta(db, "title", "工作空间标题"),
        revision: revisionOf(db),
      },
      homeBoardId,
      boards,
      packs: livePacks(db, registry).map((pack) => ({
        id: pack.id,
        title: pack.title,
        enabled: pack.enabled,
      })),
      tips: [...TIPS],
    };
  });
}

export function listTypes(
  db: Db,
  registry: Registry,
  filter?: { types?: string[]; pack?: string },
): TypesResult {
  return readOnly(db, () => {
    const enabled = new Set(enabledPackIds(db));
    const detailed = filter?.types !== undefined || filter?.pack !== undefined;
    if (filter?.types && filter.types.length > TYPE_FILTER_MAX)
      throw new CommandError(
        "LIMIT",
        "一次最多查看 20 个类型。请分批查看。",
        null,
      );
    const types = enabledTypes(registry, enabled).filter((spec) => {
      if (filter?.pack && registry.packIdOf(spec.type) !== filter.pack)
        return false;
      if (filter?.types && !filter.types.includes(spec.type)) return false;
      return true;
    });
    if (detailed) {
      const ordered =
        filter?.types === undefined
          ? types
          : filter.types.flatMap((name) => {
              const spec = types.find((item) => item.type === name);
              return spec ? [spec] : [];
            });
      return { types: ordered.map(fullType) };
    }
    return {
      types: types.map((spec) => ({
        type: spec.type,
        title: spec.title,
        description: spec.description,
        pack: registry.packIdOf(spec.type),
        container: spec.capabilities?.container === true,
      })),
      relationKinds: enabledPacks(registry, enabled).flatMap((pack) =>
        (pack.spec.relationKinds ?? []).map((kind) => ({
          kind: kind.kind,
          title: kind.title,
          inverseTitle: kind.inverseTitle,
          allowsInferred: kind.allowsInferred,
          requiresBasis: kind.requiresBasis === true,
        })),
      ),
      templates: enabledPacks(registry, enabled).flatMap((pack) =>
        (pack.spec.templates ?? []).map((template) => ({
          id: template.id,
          title: template.title,
          pack: pack.spec.id,
        })),
      ),
    };
  });
}

export function query(
  db: Db,
  registry: Registry,
  filter: QueryFilter,
): { rows: QueryRow[]; nextCursor: string | null; total: number } {
  return readOnly(db, () => {
    const limit = pageLimit(filter.limit);
    const offset = decodeCursor(filter.cursor);
    const { where, params, orderSql } = objectFilter(filter);
    const total = Number(
      (
        db
          .prepare(`SELECT COUNT(*) AS n FROM objects WHERE ${where}`)
          .get(...params) as { n: number }
      ).n,
    );
    const rows = (
      db
        .prepare(
          `SELECT * FROM objects WHERE ${where} ORDER BY ${orderSql} LIMIT ? OFFSET ?`,
        )
        .all(...params, limit, offset) as Record<string, unknown>[]
    ).map((raw) => {
      const row = toObjectRow(raw);
      return {
        id: row.id,
        type: row.type,
        title: row.title,
        summary: summarize(registry.getType(row.type), row.data, row.title),
        version: row.version,
        updatedAt: row.updatedAt,
        typeAvailable: typeAvailable(db, registry, row.type),
      };
    });
    const next = offset + rows.length;
    return {
      rows,
      nextCursor: next < total ? encodeCursor(next) : null,
      total,
    };
  });
}

export function readObjects(
  db: Db,
  registry: Registry,
  ids: string[],
  options: ReadOptions,
): ReadResult {
  return readOnly(db, () => {
    if (ids.length < 1)
      throw new CommandError("INVALID_DATA", "请至少给出一个对象。", null);
    if (ids.length > READ_MAX)
      throw new CommandError(
        "LIMIT",
        "一次最多读取 20 个对象。请分批读取。",
        null,
      );
    const textLimit = textLimitOf(options.textLimit);
    const include = new Set(
      options.include ?? (["presentations", "relations"] as const),
    );
    const objects: ReadResult["objects"] = [];
    const missing: string[] = [];
    for (const id of ids) {
      const raw = db.prepare("SELECT * FROM objects WHERE id = ?").get(id) as
        Record<string, unknown> | undefined;
      if (!raw) {
        missing.push(id);
        continue;
      }
      const row = toObjectRow(raw);
      if (row.deleted) {
        missing.push(id);
        continue;
      }
      const cut = cutData(row.data, id, textLimit, options.textOffset);
      objects.push({
        id: row.id,
        type: row.type,
        title: row.title,
        data: cut.data,
        source: row.source,
        version: row.version,
        typeAvailable: typeAvailable(db, registry, row.type),
        truncated: cut.truncated,
        presentations: include.has("presentations")
          ? presentationsOf(db, id)
          : [],
        relations: include.has("relations") ? relationsOf(db, id) : [],
      });
    }
    return { objects, missing };
  });
}

export function boardContents(db: Db, boardId: string): BoardContents {
  return readOnly(db, () => {
    const board = liveObject(db, boardId);
    if (!board)
      throw new CommandError(
        "NOT_FOUND",
        "找不到这块白板。请从首页重新进入，或刷新后再试。",
        null,
      );
    const presentations = (
      db
        .prepare(
          "SELECT * FROM presentations WHERE board_id = ? AND deleted_rev IS NULL ORDER BY z ASC, id ASC",
        )
        .all(boardId) as Record<string, unknown>[]
    ).map(toPresentationRow);
    const objectIds = [...new Set(presentations.map((item) => item.objectId))];
    const objects = objectIds.flatMap((id) => {
      const row = liveObject(db, id);
      return row ? [row] : [];
    });
    const onBoard = [...new Set(objects.map((item) => item.id))];
    const relations =
      onBoard.length === 0
        ? []
        : (
            db
              .prepare(
                `SELECT * FROM relations
                 WHERE deleted_rev IS NULL
                   AND source_id IN (${onBoard.map(() => "?").join(", ")})
                   AND target_id IN (${onBoard.map(() => "?").join(", ")})
                 ORDER BY id ASC`,
              )
              .all(...onBoard, ...onBoard) as Record<string, unknown>[]
          ).map(toRelationRow);
    return {
      revision: revisionOf(db),
      board,
      presentations,
      objects,
      relations,
      settings: liveSettings(db),
      packs: livePackRows(db),
    };
  });
}

export function changesSince(db: Db, rev: number): ChangesSinceResult {
  return readOnly(db, () => {
    if (!Number.isInteger(rev))
      throw new CommandError(
        "INVALID_DATA",
        "修订号必须是整数。请重新读取当前白板后再试。",
        null,
      );
    const revision = revisionOf(db);
    const floor = Number(getMeta(db, "tombstone_floor") ?? "0");
    if (rev < floor) return { reset: true, revision };
    return {
      revision,
      objects: changedRows(
        db,
        "SELECT * FROM objects WHERE rev > ? ORDER BY rev ASC, id ASC",
        rev,
      ).map(toObjectRow),
      presentations: changedRows(
        db,
        "SELECT * FROM presentations WHERE rev > ? ORDER BY rev ASC, id ASC",
        rev,
      ).map(toPresentationRow),
      relations: changedRows(
        db,
        "SELECT * FROM relations WHERE rev > ? ORDER BY rev ASC, id ASC",
        rev,
      ).map(toRelationRow),
      settings: changedRows(
        db,
        "SELECT * FROM settings WHERE rev > ? ORDER BY rev ASC, key ASC",
        rev,
      ).map((row) => ({
        key: String(row.key),
        value: parseJson(row.value, "settings", row.key, "value"),
        rev: Number(row.rev),
        deleted: row.deleted_rev != null,
      })),
      packs: changedRows(
        db,
        "SELECT * FROM packs WHERE rev > ? ORDER BY rev ASC, id ASC",
        rev,
      ).map((row) => ({
        id: String(row.id),
        kind: String(row.kind),
        version: Number(row.version),
        enabled: Number(row.enabled) === 1,
        manifest:
          row.manifest == null
            ? null
            : parseJson(row.manifest, "packs", row.id, "manifest"),
        rev: Number(row.rev),
        deleted: row.deleted_rev != null,
      })),
    };
  });
}

export function context(db: Db, actor: Actor, viewId?: string): ContextResult {
  return transaction(db, () => {
    const view = viewId
      ? (db.prepare("SELECT * FROM views WHERE id = ?").get(viewId) as
          Record<string, unknown> | undefined)
      : (db
          .prepare(
            "SELECT * FROM views ORDER BY updated_at DESC, id ASC LIMIT 1",
          )
          .get() as Record<string, unknown> | undefined);
    if (viewId && !view)
      throw new CommandError(
        "NOT_FOUND",
        "找不到这个视角。请先打开白板，再查看当前内容。",
        null,
      );
    const board = view ? liveObject(db, String(view.board_id)) : undefined;
    const selection = view ? selectionOf(db, view.selection) : [];
    const seen = Number(
      (
        db
          .prepare("SELECT history_seq FROM agent_reads WHERE actor = ?")
          .get(actor.id) as { history_seq: number } | undefined
      )?.history_seq ?? 0,
    );
    const edits = (
      db
        .prepare(
          `SELECT label, at, changes, seq FROM (
             SELECT label, at, changes, seq FROM history
             WHERE actor_kind = 'human' AND seq > ?
             ORDER BY seq DESC
             LIMIT ?
           ) ORDER BY seq ASC`,
        )
        .all(seen, HUMAN_EDIT_LIMIT) as {
        label: string;
        at: number;
        changes: string;
      }[]
    ).map((row) => ({
      label: String(row.label),
      at: Number(row.at),
      objectIds: objectIdsOf(row.changes),
    }));
    const maxSeq = Number(
      (
        db
          .prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM history")
          .get() as {
          seq: number;
        }
      ).seq,
    );
    const now = Date.now();
    db.prepare(
      `INSERT INTO agent_reads (actor, history_seq, at) VALUES (?, ?, ?)
       ON CONFLICT(actor) DO UPDATE SET history_seq = excluded.history_seq, at = excluded.at`,
    ).run(actor.id, maxSeq, now);
    const others = (
      db
        .prepare(
          `SELECT actor, state, task FROM activities
           WHERE actor <> ? AND expires_at > ?
           ORDER BY reported_at DESC, actor ASC`,
        )
        .all(actor.id, now) as {
        actor: string;
        state: string;
        task: string;
      }[]
    ).map((row) => ({
      actor: String(row.actor),
      state: activityState(row.state),
      task: String(row.task),
    }));
    return {
      board: board ? { id: board.id, title: board.title } : null,
      selection,
      recentHumanEdits: edits,
      otherAgents: others,
      revision: revisionOf(db),
    };
  });
}

export function setActivity(
  db: Db,
  actor: Actor,
  input: ActivityInput,
  now: number,
): void {
  if (!ACTIVITY_STATES.has(input.state))
    throw new CommandError(
      "INVALID_DATA",
      "活动状态只能是进行中、等待、完成或未知。请改好后再告诉我。",
      null,
    );
  if (
    typeof input.task !== "string" ||
    Array.from(input.task).length > TASK_LIMIT
  )
    throw new CommandError(
      "LIMIT",
      "正在做的事不能超过 300 字。请缩短后再发。",
      null,
    );
  if (
    typeof input.action !== "string" ||
    Array.from(input.action).length > ACTION_LIMIT
  )
    throw new CommandError(
      "LIMIT",
      "当前动作不能超过 200 字。请缩短后再发。",
      null,
    );
  transaction(db, () => {
    const objectIds = existingIds(db, input.objectIds ?? []).slice(
      0,
      ACTIVITY_OBJECT_LIMIT,
    );
    const ttl = input.state === "done" ? DONE_TTL_MS : ACTIVITY_TTL_MS;
    db.prepare(
      `INSERT INTO activities (
         actor, state, task, action, board_id, object_ids, reported_at, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(actor) DO UPDATE SET
         state = excluded.state,
         task = excluded.task,
         action = excluded.action,
         board_id = excluded.board_id,
         object_ids = excluded.object_ids,
         reported_at = excluded.reported_at,
         expires_at = excluded.expires_at`,
    ).run(
      actor.id,
      input.state,
      input.task,
      input.action,
      input.boardId ?? null,
      JSON.stringify(objectIds),
      now,
      now + ttl,
    );
  });
}

export function setView(db: Db, input: ViewInput, now: number): void {
  if (!input.viewId)
    throw new CommandError(
      "INVALID_DATA",
      "缺少视角编号。请重新打开白板后再试。",
      null,
    );
  const camera =
    input.camera === undefined ? undefined : jsonText(input.camera, "视角");
  const selection =
    input.selection === undefined
      ? undefined
      : JSON.stringify(stringList(input.selection, "选中项"));
  const navStack =
    input.navStack === undefined
      ? undefined
      : JSON.stringify(arrayValue(input.navStack, "进入路径"));
  transaction(db, () => {
    const existing = db
      .prepare("SELECT id, board_id FROM views WHERE id = ?")
      .get(input.viewId) as { id: string; board_id: string } | undefined;
    const boardId = input.boardId ?? existing?.board_id;
    if (!boardId)
      throw new CommandError(
        "INVALID_DATA",
        "还没有这个视角。请先指定要看的白板。",
        null,
      );
    if (!liveObject(db, boardId))
      throw new CommandError(
        "NOT_FOUND",
        "找不到这块白板。请从首页重新进入后再切换视角。",
        null,
      );
    if (!existing) {
      db.prepare(
        `INSERT INTO views (id, board_id, camera, selection, nav_stack, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        input.viewId,
        boardId,
        camera ?? JSON.stringify({ x: 0, y: 0, zoom: 1 }),
        selection ?? "[]",
        navStack ?? "[]",
        now,
      );
      return;
    }
    db.prepare(
      `UPDATE views
       SET board_id = ?, camera = ?, selection = ?, nav_stack = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      boardId,
      camera ??
        (
          db
            .prepare("SELECT camera FROM views WHERE id = ?")
            .get(input.viewId) as {
            camera: string;
          }
        ).camera,
      selection ??
        (
          db
            .prepare("SELECT selection FROM views WHERE id = ?")
            .get(input.viewId) as { selection: string }
        ).selection,
      navStack ??
        (
          db
            .prepare("SELECT nav_stack FROM views WHERE id = ?")
            .get(input.viewId) as { nav_stack: string }
        ).nav_stack,
      now,
      input.viewId,
    );
  });
}

function fullType(spec: TypeSpec) {
  const capabilities = {
    ...(spec.capabilities?.container ? { container: true } : {}),
    ...(spec.capabilities?.cover ? { cover: true } : {}),
  };
  return {
    type: spec.type,
    title: spec.title,
    description: spec.description,
    icon: spec.icon,
    version: spec.version,
    schema: spec.schema,
    ...(Object.keys(capabilities).length > 0 ? { capabilities } : {}),
    display: {
      material: spec.display.material,
      defaultSize: { ...spec.display.defaultSize },
      ...(spec.display.summary ? { summary: [...spec.display.summary] } : {}),
      ...(spec.display.view ? { view: spec.display.view } : {}),
    },
    relationSlots: (spec.relationSlots ?? []).map((slot) => ({
      ...slot,
      ...(slot.targetTypes ? { targetTypes: [...slot.targetTypes] } : {}),
    })),
  };
}

function objectFilter(filter: QueryFilter) {
  const clauses = ["deleted_rev IS NULL"];
  const params: (string | number)[] = [];
  if (filter.boardId) {
    clauses.push(
      `EXISTS (
         SELECT 1 FROM presentations
         WHERE presentations.object_id = objects.id
           AND presentations.board_id = ?
           AND presentations.deleted_rev IS NULL
       )`,
    );
    params.push(filter.boardId);
  }
  if (filter.types) {
    if (filter.types.length > TYPE_FILTER_MAX)
      throw new CommandError(
        "LIMIT",
        "一次最多按 20 个类型查找。请分批查询。",
        null,
      );
    if (filter.types.length === 0) clauses.push("0");
    else {
      clauses.push(`type IN (${filter.types.map(() => "?").join(", ")})`);
      params.push(...filter.types);
    }
  }
  if (filter.text) {
    const needle = likeNeedle(filter.text);
    clauses.push(
      `(LOWER(title) LIKE '%' || LOWER(?) || '%' ESCAPE '\\'
        OR LOWER(data) LIKE '%' || LOWER(?) || '%' ESCAPE '\\')`,
    );
    params.push(needle, needle);
  }
  if (filter.relatedTo) {
    const direction = filter.relatedTo.direction ?? "both";
    if (direction !== "out" && direction !== "in" && direction !== "both")
      throw new CommandError(
        "INVALID_DATA",
        "关系方向只能是 out、in 或 both。请改一下再查。",
        null,
      );
    const parts: string[] = [];
    const add = (
      column: "source_id" | "target_id",
      other: "target_id" | "source_id",
    ) => {
      parts.push(
        `EXISTS (
           SELECT 1 FROM relations
           WHERE relations.deleted_rev IS NULL
             AND relations.${column} = ?
             AND relations.${other} = objects.id
             ${filter.relatedTo?.kind ? "AND relations.kind = ?" : ""}
         )`,
      );
      params.push(filter.relatedTo!.id);
      if (filter.relatedTo?.kind) params.push(filter.relatedTo.kind);
    };
    if (direction === "out" || direction === "both")
      add("source_id", "target_id");
    if (direction === "in" || direction === "both")
      add("target_id", "source_id");
    clauses.push(`(${parts.join(" OR ")})`);
  }
  const order = filter.order ?? "updated";
  if (order !== "updated" && order !== "title")
    throw new CommandError(
      "INVALID_DATA",
      "排序只能是最近修改或标题。请改一下再查。",
      null,
    );
  return {
    where: clauses.join(" AND "),
    params,
    orderSql:
      order === "title" ? "title ASC, id ASC" : "updated_at DESC, id ASC",
  };
}

function presentationsOf(db: Db, objectId: string) {
  return (
    db
      .prepare(
        `SELECT presentations.id AS id, presentations.board_id AS board_id, objects.title AS title
         FROM presentations
         LEFT JOIN objects ON objects.id = presentations.board_id
         WHERE presentations.object_id = ? AND presentations.deleted_rev IS NULL
         ORDER BY presentations.z ASC, presentations.id ASC`,
      )
      .all(objectId) as { id: string; board_id: string; title: string | null }[]
  ).map((row) => ({
    id: String(row.id),
    boardId: String(row.board_id),
    boardTitle: row.title == null ? "" : String(row.title),
  }));
}

function relationsOf(db: Db, objectId: string) {
  return (
    db
      .prepare(
        `SELECT relations.id AS id, relations.kind AS kind, relations.source_id AS source_id,
                relations.target_id AS target_id, relations.status AS status, relations.basis AS basis,
                objects.title AS title
         FROM relations
         LEFT JOIN objects ON objects.id = CASE
           WHEN relations.source_id = ? THEN relations.target_id
           ELSE relations.source_id
         END
         WHERE relations.deleted_rev IS NULL
           AND (relations.source_id = ? OR relations.target_id = ?)
         ORDER BY relations.updated_at DESC, relations.id ASC
         LIMIT ?`,
      )
      .all(objectId, objectId, objectId, RELATION_LIMIT) as {
      id: string;
      kind: string;
      source_id: string;
      target_id: string;
      status: string;
      basis: string | null;
      title: string | null;
    }[]
  ).map((row) => {
    const outgoing = row.source_id === objectId;
    return {
      id: String(row.id),
      kind: String(row.kind),
      direction: outgoing ? ("out" as const) : ("in" as const),
      otherId: outgoing ? String(row.target_id) : String(row.source_id),
      otherTitle: row.title == null ? "" : String(row.title),
      status:
        row.status === "inferred"
          ? ("inferred" as const)
          : ("confirmed" as const),
      basis: row.basis == null ? null : String(row.basis),
    };
  });
}

function cutData(
  data: Record<string, unknown>,
  id: string,
  textLimit: number,
  textOffset: ReadOptions["textOffset"],
) {
  const copy: Record<string, unknown> = { ...data };
  const truncated: { field: string; totalLength: number }[] = [];
  for (const [field, value] of Object.entries(copy)) {
    if (typeof value !== "string") continue;
    const offset =
      textOffset && textOffset.id === id && textOffset.field === field
        ? textOffset.offset
        : 0;
    const chars = Array.from(value);
    const start =
      Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
    if (start === 0 && chars.length <= textLimit) continue;
    copy[field] = chars.slice(start, start + textLimit).join("");
    truncated.push({ field, totalLength: chars.length });
  }
  return { data: copy, truncated };
}

function selectionOf(db: Db, raw: unknown) {
  const ids = parseJson(raw, "views", "", "selection");
  if (!Array.isArray(ids)) return [];
  const selection: ContextResult["selection"] = [];
  for (const id of ids) {
    if (typeof id !== "string") continue;
    const presentation = db
      .prepare("SELECT * FROM presentations WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    if (!presentation) continue;
    const row = toPresentationRow(presentation);
    if (row.deleted) continue;
    const object = liveObject(db, row.objectId);
    if (!object) continue;
    selection.push({
      presentationId: row.id,
      objectId: object.id,
      type: object.type,
      title: object.title,
    });
  }
  return selection;
}

function objectIdsOf(changes: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(changes);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const ids: string[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const change = item as { table?: unknown; id?: unknown };
    if (change.table !== "objects" || typeof change.id !== "string") continue;
    if (ids.includes(change.id)) continue;
    ids.push(change.id);
    if (ids.length >= OBJECT_ID_LIMIT) break;
  }
  return ids;
}

function existingIds(db: Db, ids: string[]) {
  const found: string[] = [];
  for (const id of ids) {
    if (typeof id !== "string") continue;
    const row = db
      .prepare(
        "SELECT 1 AS hit FROM objects WHERE id = ? AND deleted_rev IS NULL",
      )
      .get(id) as { hit: number } | undefined;
    if (!row || found.includes(id)) continue;
    found.push(id);
  }
  return found;
}

function liveObject(db: Db, id: string) {
  const raw = db.prepare("SELECT * FROM objects WHERE id = ?").get(id) as
    Record<string, unknown> | undefined;
  if (!raw) return undefined;
  const row = toObjectRow(raw);
  return row.deleted ? undefined : row;
}

function liveSettings(db: Db) {
  return (
    db
      .prepare(
        "SELECT key, value FROM settings WHERE deleted_rev IS NULL ORDER BY key ASC",
      )
      .all() as { key: string; value: string }[]
  ).map((row) => ({
    key: String(row.key),
    value: parseJson(row.value, "settings", row.key, "value"),
  }));
}

function livePackRows(db: Db) {
  return (
    db
      .prepare(
        `SELECT id, kind, version, enabled FROM packs
         WHERE deleted_rev IS NULL ORDER BY id ASC`,
      )
      .all() as {
      id: string;
      kind: string;
      version: number;
      enabled: number;
    }[]
  ).map((row) => ({
    id: String(row.id),
    kind: String(row.kind),
    version: Number(row.version),
    enabled: Number(row.enabled) === 1,
  }));
}

function livePacks(db: Db, registry: Registry) {
  return (
    db
      .prepare(
        `SELECT id, enabled, manifest FROM packs
         WHERE deleted_rev IS NULL ORDER BY id ASC`,
      )
      .all() as { id: string; enabled: number; manifest: string | null }[]
  ).map((row) => ({
    id: String(row.id),
    title: packTitle(registry, String(row.id), row.manifest),
    enabled: Number(row.enabled) === 1,
  }));
}

function packTitle(registry: Registry, id: string, manifest: string | null) {
  const registered = registry.getPack(id)?.spec.title;
  if (registered) return registered;
  if (manifest) {
    try {
      const parsed = JSON.parse(manifest) as { title?: unknown };
      if (typeof parsed.title === "string" && parsed.title) return parsed.title;
    } catch {
      /* 清单损坏时用包 id，避免整次读取失败 */
    }
  }
  return id;
}

function enabledPackIds(db: Db) {
  return (
    db
      .prepare("SELECT id FROM packs WHERE enabled = 1 AND deleted_rev IS NULL")
      .all() as { id: string }[]
  ).map((row) => String(row.id));
}

function enabledPacks(registry: Registry, enabled: Set<string>) {
  return registry
    .listPacks()
    .filter((pack) => enabled.has(pack.spec.id))
    .sort((a, b) => a.spec.id.localeCompare(b.spec.id));
}

function enabledTypes(registry: Registry, enabled: Set<string>) {
  return enabledPacks(registry, enabled).flatMap(
    (pack) => pack.spec.types ?? [],
  );
}

function containerTypes(registry: Registry) {
  const names: string[] = [];
  for (const pack of registry.listPacks()) {
    for (const spec of pack.spec.types ?? []) {
      if (spec.capabilities?.container) names.push(spec.type);
    }
  }
  return names;
}

function typeAvailable(db: Db, registry: Registry, type: string) {
  if (!registry.getType(type)) return false;
  return isPackEnabled(db, registry.packIdOf(type));
}

function changedRows(db: Db, sql: string, rev: number) {
  return db.prepare(sql).all(rev) as Record<string, unknown>[];
}

function pageLimit(value: number | undefined) {
  if (value === undefined) return QUERY_DEFAULT;
  if (!Number.isInteger(value) || value < 1)
    throw new CommandError(
      "INVALID_DATA",
      "每页数量必须是正整数。请改好后再查。",
      null,
    );
  if (value > QUERY_MAX)
    throw new CommandError(
      "LIMIT",
      "每页最多 50 条。请把数量调到 50 以内再查。",
      null,
    );
  return value;
}

function textLimitOf(value: number | undefined) {
  if (value === undefined) return TEXT_DEFAULT;
  if (!Number.isInteger(value) || value < 1)
    throw new CommandError(
      "INVALID_DATA",
      "文字截断长度必须是正整数。请改好后再读。",
      null,
    );
  if (value > TEXT_MAX)
    throw new CommandError(
      "LIMIT",
      "每个文字字段最多返回 20000 字。请把长度调到 20000 以内再读。",
      null,
    );
  return value;
}

function decodeCursor(cursor: string | undefined) {
  if (!cursor) return 0;
  try {
    const text = Buffer.from(cursor, "base64url").toString("utf8");
    if (!/^\d+$/.test(text)) return 0;
    const offset = Number(text);
    return Number.isSafeInteger(offset) ? offset : 0;
  } catch {
    return 0;
  }
}

function encodeCursor(offset: number) {
  return Buffer.from(String(offset)).toString("base64url");
}

function likeNeedle(text: string) {
  return text.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function revisionOf(db: Db) {
  const raw = getMeta(db, "revision") ?? "0";
  if (!/^\d+$/.test(raw))
    throw new CommandError("INTERNAL", "修订号损坏，已停止读取。", null);
  return Number(raw);
}

function requiredMeta(db: Db, key: string, label: string) {
  const value = getMeta(db, key);
  if (!value)
    throw new CommandError(
      "INTERNAL",
      `${label}丢了，已停止读取。请换一个工作空间文件再打开。`,
      null,
    );
  return value;
}

function metaText(db: Db, key: string) {
  const value = getMeta(db, key);
  return value ? value : null;
}

function activityState(value: string): ActivityInput["state"] {
  if (ACTIVITY_STATES.has(value)) return value as ActivityInput["state"];
  return "unknown";
}

function stringList(value: string[], label: string) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new CommandError(
      "INVALID_DATA",
      `${label}必须是文字列表。请重新选择后再试。`,
      null,
    );
  return value;
}

function arrayValue(value: unknown[], label: string) {
  if (!Array.isArray(value))
    throw new CommandError(
      "INVALID_DATA",
      `${label}必须是列表。请重新进入白板后再试。`,
      null,
    );
  return value;
}

function jsonText(value: unknown, label: string) {
  try {
    const text = JSON.stringify(value);
    if (text === undefined)
      throw new CommandError(
        "INVALID_DATA",
        `${label}无法保存。请换一种内容再试。`,
        null,
      );
    return text;
  } catch (error) {
    if (error instanceof CommandError) throw error;
    throw new CommandError(
      "INVALID_DATA",
      `${label}无法保存。请换一种内容再试。`,
      null,
    );
  }
}

function parseJson(value: unknown, table: string, id: unknown, column: string) {
  if (typeof value !== "string")
    throw new CommandError(
      "INTERNAL",
      `表 ${table} 的记录 ${String(id)} 里，字段 ${column} 不是 JSON 文本。`,
      null,
    );
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new CommandError(
      "INTERNAL",
      `表 ${table} 的记录 ${String(id)} 里，字段 ${column} 无法解析为 JSON。`,
      null,
    );
  }
}

function readOnly<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN DEFERRED");
  try {
    const value = fn();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* 回滚失败时仍抛出读取里原来的错误 */
    }
    throw error;
  }
}
