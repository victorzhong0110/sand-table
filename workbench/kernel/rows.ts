import { CommandError } from "./errors.ts";
import type {
  Appearance,
  ExternalLocator,
  ObjectRow,
  ObjectSource,
  PresentationRow,
  RelationRow,
} from "./types.ts";

export function toObjectRow(r: Record<string, unknown>): ObjectRow {
  return {
    id: String(r.id),
    type: String(r.type),
    typeVersion: Number(r.type_version),
    title: String(r.title),
    data: parseJson(r.data, "objects", r.id, "data") as Record<string, unknown>,
    source:
      r.source == null
        ? null
        : (parseJson(
            r.source,
            "objects",
            r.id,
            "source",
          ) as ObjectSource | null),
    version: Number(r.version),
    createdAt: Number(r.created_at),
    createdBy: String(r.created_by),
    updatedAt: Number(r.updated_at),
    updatedBy: String(r.updated_by),
    rev: Number(r.rev),
    deleted: r.deleted_rev != null,
  };
}

export function toPresentationRow(r: Record<string, unknown>): PresentationRow {
  return {
    id: String(r.id),
    boardId: String(r.board_id),
    objectId: String(r.object_id),
    parentId: r.parent_id == null ? null : String(r.parent_id),
    x: Number(r.x),
    y: Number(r.y),
    width: Number(r.width),
    height: Number(r.height),
    z: Number(r.z),
    locked: r.locked === 1 || r.locked === true,
    appearance: parseJson(
      r.appearance,
      "presentations",
      r.id,
      "appearance",
    ) as Appearance,
    version: Number(r.version),
    updatedAt: Number(r.updated_at),
    updatedBy: String(r.updated_by),
    rev: Number(r.rev),
    deleted: r.deleted_rev != null,
  };
}

export function toRelationRow(r: Record<string, unknown>): RelationRow {
  return {
    id: String(r.id),
    kind: String(r.kind),
    sourceId: String(r.source_id),
    targetId: String(r.target_id),
    status: r.status === "inferred" ? "inferred" : "confirmed",
    basis: r.basis == null ? null : String(r.basis),
    attributes: parseJson(
      r.attributes,
      "relations",
      r.id,
      "attributes",
    ) as Record<string, unknown>,
    evidence: parseJson(
      r.evidence,
      "relations",
      r.id,
      "evidence",
    ) as ExternalLocator[],
    version: Number(r.version),
    createdAt: Number(r.created_at),
    createdBy: String(r.created_by),
    updatedAt: Number(r.updated_at),
    updatedBy: String(r.updated_by),
    rev: Number(r.rev),
    deleted: r.deleted_rev != null,
  };
}

function parseJson(
  value: unknown,
  table: string,
  id: unknown,
  column: string,
): unknown {
  if (typeof value !== "string")
    throw new CommandError(
      "INTERNAL",
      `表 ${table} 的记录 ${String(id)} 里，字段 ${column} 不是 JSON 文本。`,
    );
  try {
    return JSON.parse(value);
  } catch {
    throw new CommandError(
      "INTERNAL",
      `表 ${table} 的记录 ${String(id)} 里，字段 ${column} 无法解析为 JSON。`,
      null,
      { table, id: String(id), column },
    );
  }
}
