import { getMeta, type Db } from "./db.ts";
import { CommandError } from "./errors.ts";
import { readOnly } from "./read.ts";

export type CommentEntry = {
  id: string;
  rootId: string;
  parentId: string | null;
  scope: "object" | "presentation";
  presentationId: string | null;
  originalRemoved: boolean;
  targetRemoved: boolean;
  removed: boolean;
  body: string;
  resolved: boolean;
  version: number;
  createdAt: number;
  createdBy: string;
};

export function readCommentCounts(db: Db, boardId: string) {
  return readOnly(db, () => {
    const rows = db
      .prepare(
        `WITH RECURSIVE threads(presentationId, commentId) AS (
         SELECT p.id, r.source_id FROM presentations p
         JOIN relations r ON r.target_id = p.object_id AND r.kind = 'base.comments_on'
         WHERE p.board_id = ? AND p.deleted_rev IS NULL AND r.deleted_rev IS NULL
           AND (json_extract(r.attributes, '$.presentationId') IS NULL
             OR json_extract(r.attributes, '$.presentationId') = p.id)
         UNION
         SELECT t.presentationId, r.source_id FROM threads t
         JOIN relations r ON r.target_id = t.commentId AND r.kind = 'base.reply_to'
         WHERE r.deleted_rev IS NULL
       )
       SELECT t.presentationId, COUNT(*) AS count FROM threads t
       JOIN objects c ON c.id = t.commentId AND c.type = 'base.comment'
       WHERE c.deleted_rev IS NULL AND COALESCE(json_extract(c.data, '$.resolved'), 0) <> 1
       GROUP BY t.presentationId`,
      )
      .all(boardId);
    return {
      revision: Number(getMeta(db, "revision")),
      counts: Object.fromEntries(
        rows.map((row) => [String(row.presentationId), Number(row.count)]),
      ),
    };
  });
}

export function readComments(
  db: Db,
  objectId: string,
  presentationId?: string,
) {
  return readOnly(db, () => {
    const target = db
      .prepare(
        "SELECT version, deleted_rev AS removed FROM objects WHERE id = ?",
      )
      .get(objectId);
    if (!target)
      throw new CommandError("NOT_FOUND", "找不到评论所附的对象。", null);
    if (
      presentationId &&
      !db
        .prepare("SELECT 1 FROM presentations WHERE id = ? AND object_id = ?")
        .get(presentationId, objectId)
    )
      throw new CommandError("NOT_FOUND", "此展示不属于评论所附的对象。", null);
    const rows = db
      .prepare(
        `WITH RECURSIVE owners AS (
         SELECT r.* FROM relations r
         WHERE r.kind IN ('base.comments_on', 'base.reply_to')
           AND (r.deleted_rev IS NULL OR (
             r.cascade_object_id IN (r.target_id, r.source_id) AND NOT EXISTS (
               SELECT 1 FROM relations live WHERE live.source_id = r.source_id
                 AND live.kind IN ('base.comments_on', 'base.reply_to') AND live.deleted_rev IS NULL
             )
           ))
       ), roots AS (
         SELECT r.source_id AS id,
           json_extract(r.attributes, '$.presentationId') AS presentationId,
           (p.id IS NULL OR p.deleted_rev IS NOT NULL) AS placementRemoved
         FROM owners r
         JOIN objects c ON c.id = r.source_id AND c.type = 'base.comment'
         LEFT JOIN presentations p
           ON p.id = json_extract(r.attributes, '$.presentationId') AND p.object_id = r.target_id
         WHERE r.kind = 'base.comments_on' AND r.target_id = ?
           AND (json_extract(r.attributes, '$.presentationId') IS NULL
             OR p.id = ? OR p.id IS NULL OR p.deleted_rev IS NOT NULL)
       ), tree(rootId, id, parentId) AS (
         SELECT DISTINCT id, id, NULL FROM roots
         UNION
         SELECT t.rootId, r.source_id, t.id FROM tree t
         JOIN owners r ON r.target_id = t.id AND r.kind = 'base.reply_to'
         JOIN objects c ON c.id = r.source_id AND c.type = 'base.comment'
         LIMIT 201
       )
       SELECT c.id, t.rootId, t.parentId, roots.presentationId, roots.placementRemoved,
         c.deleted_rev IS NOT NULL AS removed,
         CASE WHEN c.deleted_rev IS NULL THEN json_extract(c.data, '$.body') ELSE '' END AS body,
         json_extract(c.data, '$.resolved') AS resolved,
         c.version, c.created_at AS createdAt, c.created_by AS createdBy
       FROM tree t JOIN roots ON roots.id = t.rootId
       JOIN objects c ON c.id = t.id
       ORDER BY c.created_at, c.id`,
      )
      .all(objectId, presentationId ?? null);
    const targetRemoved = target.removed !== null;
    const entries = rows.slice(0, 200).map((row): CommentEntry => ({
      id: String(row.id),
      rootId: String(row.rootId),
      parentId: row.parentId ? String(row.parentId) : null,
      scope: row.presentationId ? "presentation" : "object",
      presentationId: row.presentationId ? String(row.presentationId) : null,
      originalRemoved: Boolean(row.presentationId && row.placementRemoved),
      targetRemoved,
      removed: Boolean(row.removed),
      body: typeof row.body === "string" ? row.body : "",
      resolved: row.resolved === 1,
      version: Number(row.version),
      createdAt: Number(row.createdAt),
      createdBy: String(row.createdBy),
    }));
    return {
      revision: Number(getMeta(db, "revision")),
      targetVersion: Number(target.version),
      targetRemoved,
      entries,
      truncated: rows.length > 200,
    };
  });
}
