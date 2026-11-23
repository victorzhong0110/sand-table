import type { Db } from "./db.ts";
import { CommandError } from "./errors.ts";

export function isCommentRelation(kind: string) {
  return kind === "base.comments_on" || kind === "base.reply_to";
}

export function commentAttributeProblem(
  kind: string,
  attributes: Record<string, unknown>,
): string | undefined {
  if (kind === "base.reply_to")
    return Object.keys(attributes).length
      ? "回复沿用根评论的范围，不能另设范围或锚点。"
      : undefined;
  const { scope = "object", presentationId, anchor } = attributes;
  if (
    Object.keys(attributes).some(
      (key) => !["scope", "presentationId", "anchor"].includes(key),
    )
  )
    return "评论关系仅支持范围、展示编号和锚点。";
  if (scope !== "object" && scope !== "presentation")
    return "请选择共享评论或仅此处的局部批注。";
  if (
    (scope === "presentation" &&
      (typeof presentationId !== "string" || !presentationId.trim())) ||
    (scope === "object" && presentationId !== undefined)
  )
    return "局部批注必须指定展示编号，共享评论不指定展示。";
  if (anchor === undefined) return;
  if (typeof anchor !== "object" || anchor === null || Array.isArray(anchor))
    return "锚点必须记录对象内部的位置。";
  const fields = anchor as Record<string, unknown>;
  if (
    typeof fields.fragment !== "string" ||
    !fields.fragment.trim() ||
    Object.keys(fields).some(
      (key) =>
        !["fragment", "version", "fingerprint"].includes(key) ||
        typeof fields[key] !== "string",
    )
  )
    return "锚点需包含位置，可附版本和指纹。";
}

export function assertCommentRelation(
  db: Db,
  relation: {
    id?: string;
    kind: string;
    sourceId: string;
    targetId: string;
    attributes: Record<string, unknown>;
    previousPresentationId?: unknown;
  },
  index: number,
) {
  const { id, kind, sourceId, targetId, attributes, previousPresentationId } =
    relation;
  const problem = commentAttributeProblem(kind, attributes);
  if (problem) throw new CommandError("INVALID_DATA", problem, index);
  if (typeof attributes.presentationId === "string") {
    const presentation = db
      .prepare(
        "SELECT object_id AS objectId, deleted_rev AS deleted FROM presentations WHERE id = ?",
      )
      .get(attributes.presentationId);
    if (
      (presentation && presentation.objectId !== targetId) ||
      ((!presentation || presentation.deleted !== null) &&
        attributes.presentationId !== previousPresentationId)
    )
      throw new CommandError(
        "INVALID_DATA",
        "局部批注的展示必须属于当前评论对象。",
        index,
      );
  }
  const existing = db
    .prepare(
      `SELECT id FROM relations
     WHERE source_id = ? AND kind IN ('base.comments_on', 'base.reply_to')
       AND deleted_rev IS NULL AND id <> ? LIMIT 1`,
    )
    .get(sourceId, id ?? "");
  if (existing)
    throw new CommandError(
      "INVALID_DATA",
      "一条评论只能关联一个对象或回复一条评论。",
      index,
    );
  if (kind !== "base.reply_to") return;
  const chain = db
    .prepare(
      `WITH RECURSIVE ancestors(id) AS (
       VALUES (?)
       UNION
       SELECT r.target_id FROM relations r JOIN ancestors a ON r.source_id = a.id
       WHERE r.kind = 'base.reply_to' AND r.deleted_rev IS NULL
     )
     SELECT EXISTS(SELECT 1 FROM ancestors WHERE id = ?) AS cyclic,
       EXISTS(
         SELECT 1 FROM ancestors a JOIN relations r ON r.source_id = a.id
         WHERE r.kind = 'base.comments_on' AND r.deleted_rev IS NULL
       ) AS hasRoot`,
    )
    .get(targetId, sourceId);
  if (chain?.cyclic === 1)
    throw new CommandError("CYCLE", "回复不能形成环。", index);
  if (chain?.hasRoot !== 1 && !id)
    throw new CommandError(
      "INVALID_DATA",
      "这条评论的讨论已失效，无法添加回复。",
      index,
    );
}
