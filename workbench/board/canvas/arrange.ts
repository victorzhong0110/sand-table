export const FRAME_PAD = 24;
export const ARRANGE_COMMAND_LIMIT = 200;

export type AlignEdge =
  "left" | "center-x" | "right" | "top" | "center-y" | "bottom";

export type DistributeAxis = "x" | "y";

export type ZAction = "front" | "back" | "forward" | "backward";

export type ArrangeRect = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  locked?: boolean;
};

export type ArrangeItem = ArrangeRect & {
  parentId: string | null;
  z: number;
};

export type Point = { x: number; y: number };

const byId = (a: { id: string }, b: { id: string }) =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

export function selectionBounds(rects: readonly ArrangeRect[]) {
  const left = Math.min(...rects.map((item) => item.x));
  const top = Math.min(...rects.map((item) => item.y));
  const right = Math.max(...rects.map((item) => item.x + item.width));
  const bottom = Math.max(...rects.map((item) => item.y + item.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function align(
  rects: readonly ArrangeRect[],
  edge: AlignEdge,
): { id: string; x: number; y: number }[] {
  if (rects.length < 2)
    return rects.map((item) => ({ id: item.id, x: item.x, y: item.y }));
  const bounds = selectionBounds(rects);
  return rects.map((item) => {
    if (item.locked) return { id: item.id, x: item.x, y: item.y };
    switch (edge) {
      case "left":
        return { id: item.id, x: bounds.x, y: item.y };
      case "right":
        return {
          id: item.id,
          x: bounds.x + bounds.width - item.width,
          y: item.y,
        };
      case "center-x":
        return {
          id: item.id,
          x: bounds.x + (bounds.width - item.width) / 2,
          y: item.y,
        };
      case "top":
        return { id: item.id, x: item.x, y: bounds.y };
      case "bottom":
        return {
          id: item.id,
          x: item.x,
          y: bounds.y + bounds.height - item.height,
        };
      case "center-y":
        return {
          id: item.id,
          x: item.x,
          y: bounds.y + (bounds.height - item.height) / 2,
        };
      default: {
        const unreachable: never = edge;
        return unreachable;
      }
    }
  });
}

/** 少于 3 个时不可用。首尾保持不动，中间按等间距重排。锁定的保持原位。 */
export function distribute(
  rects: readonly ArrangeRect[],
  axis: DistributeAxis,
): { id: string; x: number; y: number }[] | null {
  if (rects.length < 3) return null;
  const sorted = [...rects].sort((a, b) => {
    const delta = axis === "x" ? a.x - b.x : a.y - b.y;
    return delta || byId(a, b);
  });
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (!first || !last) return null;
  const spanStart = axis === "x" ? first.x : first.y;
  const spanEnd = axis === "x" ? last.x + last.width : last.y + last.height;
  const totalSize = sorted.reduce(
    (sum, item) => sum + (axis === "x" ? item.width : item.height),
    0,
  );
  const gap = (spanEnd - spanStart - totalSize) / (sorted.length - 1);
  let cursor = spanStart;
  return sorted.map((item, index) => {
    const size = axis === "x" ? item.width : item.height;
    const at = cursor;
    cursor += size + gap;
    if (item.locked || index === 0 || index === sorted.length - 1)
      return { id: item.id, x: item.x, y: item.y };
    if (axis === "x") return { id: item.id, x: at, y: item.y };
    return { id: item.id, x: item.x, y: at };
  });
}

export function boardOrigin(
  id: string,
  byId: ReadonlyMap<string, ArrangeItem>,
): Point {
  const chain: ArrangeItem[] = [];
  const seen = new Set<string>();
  let current = byId.get(id);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  let x = 0;
  let y = 0;
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const item = chain[index];
    if (!item) continue;
    x += item.x;
    y += item.y;
  }
  return { x, y };
}

export function topLevelIds(
  ids: readonly string[],
  parentOf: (id: string) => string | null,
): string[] {
  const selected = new Set(ids);
  return ids.filter((id) => {
    const seen = new Set<string>();
    let parent = parentOf(id);
    while (parent && !seen.has(parent)) {
      if (selected.has(parent)) return false;
      seen.add(parent);
      parent = parentOf(parent);
    }
    return true;
  });
}

function indexById(items: readonly ArrangeItem[]) {
  return new Map(items.map((item) => [item.id, item]));
}

export function alignSelection(
  items: readonly ArrangeItem[],
  selectedIds: readonly string[],
  edge: AlignEdge,
): { id: string; x: number; y: number }[] {
  const byId = indexById(items);
  const chosen = topLevelIds(
    selectedIds,
    (id) => byId.get(id)?.parentId ?? null,
  ).flatMap((id) => {
    const item = byId.get(id);
    return item ? [item] : [];
  });
  const rects = chosen.map((item) => {
    const origin = boardOrigin(item.id, byId);
    return {
      id: item.id,
      x: origin.x,
      y: origin.y,
      width: item.width,
      height: item.height,
      locked: item.locked,
    };
  });
  return align(rects, edge).flatMap((next) => {
    const item = byId.get(next.id);
    if (!item || item.locked) return [];
    if (
      next.x === boardOrigin(item.id, byId).x &&
      next.y === boardOrigin(item.id, byId).y
    )
      return [];
    const parent = item.parentId
      ? boardOrigin(item.parentId, byId)
      : { x: 0, y: 0 };
    return [{ id: item.id, x: next.x - parent.x, y: next.y - parent.y }];
  });
}

export function distributeSelection(
  items: readonly ArrangeItem[],
  selectedIds: readonly string[],
  axis: DistributeAxis,
): { id: string; x: number; y: number }[] | null {
  const byId = indexById(items);
  const chosen = topLevelIds(
    selectedIds,
    (id) => byId.get(id)?.parentId ?? null,
  ).flatMap((id) => {
    const item = byId.get(id);
    return item ? [item] : [];
  });
  const rects = chosen.map((item) => {
    const origin = boardOrigin(item.id, byId);
    return {
      id: item.id,
      x: origin.x,
      y: origin.y,
      width: item.width,
      height: item.height,
      locked: item.locked,
    };
  });
  const placed = distribute(rects, axis);
  if (!placed) return null;
  return placed.flatMap((next) => {
    const item = byId.get(next.id);
    if (!item || item.locked) return [];
    const before = boardOrigin(item.id, byId);
    if (next.x === before.x && next.y === before.y) return [];
    const parent = item.parentId
      ? boardOrigin(item.parentId, byId)
      : { x: 0, y: 0 };
    return [{ id: item.id, x: next.x - parent.x, y: next.y - parent.y }];
  });
}

export function restack(
  items: readonly { id: string; z: number }[],
  selectedIds: readonly string[],
  action: ZAction,
): { id: string; z: number }[] {
  if (!items.length || !selectedIds.length) return [];
  const selected = new Set(selectedIds);
  const ordered = [...items].sort((a, b) => a.z - b.z || byId(a, b));
  if (action === "front") {
    let z = Math.max(...items.map((item) => item.z)) + 1;
    return ordered
      .filter((item) => selected.has(item.id))
      .map((item) => ({ id: item.id, z: z++ }));
  }
  if (action === "back") {
    const chosen = ordered.filter((item) => selected.has(item.id));
    let z = Math.min(...items.map((item) => item.z)) - chosen.length;
    return chosen.map((item) => ({ id: item.id, z: z++ }));
  }
  const next = ordered.map((item) => ({ ...item }));
  const walk =
    action === "forward"
      ? next
          .map((item, index) => ({ id: item.id, index }))
          .filter((entry) => selected.has(entry.id))
          .reverse()
      : next
          .map((item, index) => ({ id: item.id, index }))
          .filter((entry) => selected.has(entry.id));
  for (const entry of walk) {
    const neighbor = action === "forward" ? entry.index + 1 : entry.index - 1;
    if (neighbor < 0 || neighbor >= next.length) continue;
    const other = next[neighbor];
    const current = next[entry.index];
    if (!other || !current || selected.has(other.id)) continue;
    if (other.z !== current.z) {
      next[entry.index] = { ...current, z: other.z };
      next[neighbor] = { ...other, z: current.z };
      continue;
    }
    /* 新建展示的 z 都是 0。只给选中项 +1 会越过这一整层，
       所以同一层按现在的顺序改成相邻的 z，只和紧挨着的那一个交换。 */
    let start = Math.min(entry.index, neighbor);
    let end = Math.max(entry.index, neighbor);
    while (start > 0 && next[start - 1]?.z === current.z) start -= 1;
    while (end + 1 < next.length && next[end + 1]?.z === current.z) end += 1;
    const sequence = next.slice(start, end + 1);
    const from = entry.index - start;
    const to = neighbor - start;
    const moved = sequence[from];
    const beside = sequence[to];
    if (!moved || !beside) continue;
    sequence[from] = beside;
    sequence[to] = moved;
    for (let offset = 0; offset < sequence.length; offset += 1) {
      const item = sequence[offset];
      if (!item) continue;
      const index = next.findIndex((candidate) => candidate.id === item.id);
      const sitting = index < 0 ? undefined : next[index];
      if (!sitting) continue;
      next[index] = { ...sitting, z: current.z + offset };
    }
  }
  return next
    .filter((item, index) => item.z !== ordered[index]?.z)
    .map((item) => ({ id: item.id, z: item.z }));
}

/**
 * 删掉的展示如果还装着孩子，孩子先回到这次不会删的最近祖先。
 * 坐标按删之前的白板位置换算，屏幕位置不变。一起删掉的孩子不用移。
 */
export function detachChildren(
  items: readonly ArrangeItem[],
  removingIds: readonly string[],
): {
  id: string;
  parentId: string | null;
  x: number;
  y: number;
  locked: boolean;
}[] {
  const removing = new Set(removingIds);
  const byId = indexById(items);
  const parentOf = (id: string) => byId.get(id)?.parentId ?? null;
  return items.flatMap((item) => {
    if (removing.has(item.id) || !item.parentId || !removing.has(item.parentId))
      return [];
    const seen = new Set<string>();
    let parent: string | null = item.parentId;
    while (parent && removing.has(parent) && !seen.has(parent)) {
      seen.add(parent);
      parent = parentOf(parent);
    }
    if (parent && seen.has(parent)) parent = null;
    const board = boardOrigin(item.id, byId);
    const parentBoard = parent ? boardOrigin(parent, byId) : { x: 0, y: 0 };
    return [
      {
        id: item.id,
        parentId: parent,
        x: board.x - parentBoard.x,
        y: board.y - parentBoard.y,
        locked: Boolean(item.locked),
      },
    ];
  });
}

export function framePlan(
  items: readonly ArrangeItem[],
  selectedIds: readonly string[],
) {
  const byId = indexById(items);
  const chosen = topLevelIds(
    selectedIds,
    (id) => byId.get(id)?.parentId ?? null,
  ).flatMap((id) => {
    const item = byId.get(id);
    return item && !item.locked ? [item] : [];
  });
  if (chosen.length < 1) return null;
  const rects = chosen.map((item) => {
    const origin = boardOrigin(item.id, byId);
    return { ...origin, width: item.width, height: item.height };
  });
  const bounds = selectionBounds(
    rects.map((item) => ({
      id: "",
      x: item.x,
      y: item.y,
      width: item.width,
      height: item.height,
    })),
  );
  const frame = {
    x: bounds.x - FRAME_PAD,
    y: bounds.y - FRAME_PAD,
    width: bounds.width + FRAME_PAD * 2,
    height: bounds.height + FRAME_PAD * 2,
  };
  return {
    frame,
    children: chosen.map((item) => {
      const origin = boardOrigin(item.id, byId);
      return { id: item.id, x: origin.x - frame.x, y: origin.y - frame.y };
    }),
  };
}

export function unframePlan(items: readonly ArrangeItem[], frameId: string) {
  const byId = indexById(items);
  const frame = byId.get(frameId);
  if (!frame) return null;
  const parentBoard = frame.parentId
    ? boardOrigin(frame.parentId, byId)
    : { x: 0, y: 0 };
  const children = items.filter((item) => item.parentId === frameId);
  return {
    frameId,
    children: children.map((child) => {
      const board = boardOrigin(child.id, byId);
      return {
        id: child.id,
        parentId: frame.parentId,
        x: board.x - parentBoard.x,
        y: board.y - parentBoard.y,
        locked: Boolean(child.locked),
      };
    }),
  };
}

export function withinCommandLimit(count: number): boolean {
  return count <= ARRANGE_COMMAND_LIMIT;
}

/** 成框：新建框对象、框展示，再改每个子展示的父框。 */
export function frameCommandCount(childCount: number): number {
  return 2 + childCount;
}

/**
 * 解除框：每个未锁定子展示一条更新，锁定的要先解锁再改坐标再锁回去，
 * 最后删掉框展示。框对象留下。
 */
export function unframeCommandCount(
  children: readonly { locked?: boolean }[],
): number {
  return 1 + children.reduce((sum, child) => sum + (child.locked ? 3 : 1), 0);
}

export type MenuAction =
  | "edit"
  | "duplicate"
  | "clone"
  | "align-left"
  | "align-center-x"
  | "align-right"
  | "align-top"
  | "align-center-y"
  | "align-bottom"
  | "distribute-x"
  | "distribute-y"
  | "front"
  | "back"
  | "forward"
  | "backward"
  | "lock"
  | "unlock"
  | "frame"
  | "unframe"
  | "remove"
  | "delete-object"
  | "paste"
  | "paste-clone"
  | "select-all";

export type MenuEntry = {
  id: MenuAction;
  label: string;
  disabled?: boolean;
  hint?: string;
};

const ALIGN_ENTRIES: MenuEntry[] = [
  { id: "align-left", label: "左对齐" },
  { id: "align-center-x", label: "水平居中" },
  { id: "align-right", label: "右对齐" },
  { id: "align-top", label: "上对齐" },
  { id: "align-center-y", label: "垂直居中" },
  { id: "align-bottom", label: "下对齐" },
];

export function componentMenu(input: {
  alignCount: number;
  targetLocked: boolean;
  targetIsFrame: boolean;
  canFrame: boolean;
}): MenuEntry[] {
  const distribute: MenuEntry[] = [
    {
      id: "distribute-x",
      label: "水平等间距",
      ...(input.alignCount < 3
        ? { disabled: true, hint: "至少选中 3 个展示才能等间距分布。" }
        : {}),
    },
    {
      id: "distribute-y",
      label: "垂直等间距",
      ...(input.alignCount < 3
        ? { disabled: true, hint: "至少选中 3 个展示才能等间距分布。" }
        : {}),
    },
  ];
  return [
    { id: "edit", label: "编辑" },
    { id: "duplicate", label: "再放一份" },
    { id: "clone", label: "复制为独立对象" },
    ...(input.alignCount >= 2 ? [...ALIGN_ENTRIES, ...distribute] : []),
    { id: "front", label: "置顶" },
    { id: "back", label: "置底" },
    { id: "forward", label: "上移一层" },
    { id: "backward", label: "下移一层" },
    input.targetLocked
      ? { id: "unlock", label: "解锁" }
      : { id: "lock", label: "锁定" },
    {
      id: "frame",
      label: "成框",
      ...(input.canFrame
        ? {}
        : {
            disabled: true,
            hint: "锁定的展示不能放进框。请先解锁，或改选未锁定的展示。",
          }),
    },
    ...(input.targetIsFrame
      ? [{ id: "unframe" as const, label: "解除框" }]
      : []),
    { id: "remove", label: "移除展示" },
    { id: "delete-object", label: "彻底删除对象" },
  ];
}

export function paneMenu(): MenuEntry[] {
  return [
    { id: "paste", label: "粘贴" },
    { id: "paste-clone", label: "粘贴为独立副本" },
    { id: "select-all", label: "全选" },
  ];
}
