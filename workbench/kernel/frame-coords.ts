// 框内坐标的版本标记与体检。
//
// v3 的展示坐标有两种（docs/kernel-v3/01-data-model.md §4）：
// 没有父框的是白板上的绝对坐标，有父框的是相对父框左上角的坐标。
// 旧版导入器把白板上的绝对坐标换算成框内相对坐标再写库。
//
// 换算是有版本的：以后要判断一个库里的框内坐标是不是相对坐标，靠这里的标记。
// 没有标记的库不能盲目当成相对坐标迁移——说不准是相对还是绝对，
// 改坏了就是改坏用户的作品。这种库只报给人确认，不动它。

import { getMeta, setMeta, type Db } from "./db.ts";

/**
 * 框内坐标的版本。导入的库和 v3 新建的库都写这个标记。
 *
 * relative-1：框内展示的 x、y 是相对父框左上角的。
 */
export const FRAME_COORDS_MARKER = "relative-1";

/** 一个说不准坐标口径的框内展示。 */
export type FrameCoordItem = {
  presentationId: string;
  parentId: string;
  x: number;
  y: number;
};

export type FrameCoordAudit = {
  state: "ok" | "needs-review";
  /** 库里的坐标版本标记；没有就是 null。 */
  marker: string | null;
  /** 需要人工确认的展示。state 是 ok 时是空的。 */
  items: FrameCoordItem[];
  /** 说清这次体检的结论。 */
  message: string;
};

/** 记下这个库的框内坐标是相对坐标。导入和新建时写。 */
export function markFrameCoords(db: Db, marker = FRAME_COORDS_MARKER): void {
  setMeta(db, "frame_coords", marker);
}

/**
 * 体检：这个库里的框内坐标能不能信。
 *
 * 有版本标记的按标记走；没有标记、又没有框内展示的（新建的空库）不用管；
 * 没有标记但有框内展示的，说不准是相对还是绝对——不改它，报给人确认。
 */
export function auditFrameCoordinates(db: Db): FrameCoordAudit {
  const marker = getMeta(db, "frame_coords") ?? null;
  const rows = db
    .prepare(
      `SELECT id, parent_id, x, y FROM presentations
       WHERE parent_id IS NOT NULL AND deleted_rev IS NULL
       ORDER BY id`,
    )
    .all() as { id: string; parent_id: string; x: number; y: number }[];
  if (marker === FRAME_COORDS_MARKER)
    return {
      state: "ok",
      marker,
      items: [],
      message: "框内坐标是相对父框左上角的，不用迁移。",
    };
  if (!rows.length)
    return {
      state: "ok",
      marker,
      items: [],
      message: "这个库里还没有框内展示，坐标不用核对。",
    };
  const items: FrameCoordItem[] = rows.map((row) => ({
    presentationId: String(row.id),
    parentId: String(row.parent_id),
    x: Number(row.x),
    y: Number(row.y),
  }));
  return {
    state: "needs-review",
    marker,
    items,
    message: `这个库里有 ${items.length} 个框内展示，但没有坐标版本标记，说不准是相对坐标还是绝对坐标。没有改动它们，请人工确认后再处理。`,
  };
}
