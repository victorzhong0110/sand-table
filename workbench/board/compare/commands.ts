import type { Command } from "../../kernel/index.ts";

export type ComparisonSource = { id: string; title: string; version: number };

export function comparisonCommands({
  boardId,
  left,
  right,
  position,
  pinnedVersions,
}: {
  boardId: string;
  left: ComparisonSource;
  right: ComparisonSource;
  position: { x: number; y: number };
  pinnedVersions?: { left?: number; right?: number };
}): Command[] {
  const name = (source: ComparisonSource) => source.title || "未命名对象";
  const title =
    left.id === right.id
      ? `${name(left)} · 版本比较`
      : `${name(left).slice(0, 120)} 与 ${name(right).slice(0, 120)}`;
  return [
    {
      op: "object.create",
      type: "base.comparison",
      ref: "comparison",
      title: title.slice(0, 300),
      data: pinnedVersions ? { pinnedVersions } : {},
    },
    {
      op: "presentation.create",
      boardId,
      objectId: "@comparison",
      ...position,
    },
    {
      op: "relation.create",
      kind: "base.compare_left",
      sourceId: "@comparison",
      targetId: left.id,
      expectedTargetVersion: left.version,
    },
    {
      op: "relation.create",
      kind: "base.compare_right",
      sourceId: "@comparison",
      targetId: right.id,
      expectedTargetVersion: right.version,
    },
  ];
}
