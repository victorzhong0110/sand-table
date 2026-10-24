// 时间线的树结构与路径计算。纯函数：不持有状态，不碰存储与 UI。
// 契约见 docs/architecture/history-timeline.zh-CN.md（第 2、3、7 节）。
//
// 模型：历史是一棵树，不是两个栈。
//
//        e1 ── e2 ── e3          ← 当前分支（游标在 e3）
//             \
//              e4 ── e5          ← 撤销 e3 后从 e2 分叉出来的新编辑
//
// 每条记录带 parentId（它发生在哪条记录之上），游标 cursorId 指向板面当前停在哪条之后。
// 新编辑从游标分叉，旧分支原样保留——所以任何一条记录都还能跳回去。
// 这正是双栈模型做不到的地方：v1 的 record() 会清空重做栈，被撤销的那段历史从此不可达。
//
// 本模块只回答「怎么算」：父子链、最近公共祖先、路径重放、容量裁剪。
// 状态与副作用在 core/history.ts。

import type { TimelineEntry } from "./objects.ts";

/** 树的索引：按 id 找条目、按父找子。 */
export type TimelineIndex = {
  /** id → 条目。 */
  byId: Map<string, TimelineEntry>;
  /** 父 id → 子节点（按 seq 升序：先创建的在前）。 */
  children: Map<string, TimelineEntry[]>;
  /** 没有父节点、或父节点不存在的条目（坏数据按根处理，不让整棵树崩掉）。 */
  roots: TimelineEntry[];
};

/**
 * 建索引。
 *
 * 父指针指向不存在的条目时按根处理：一条坏记录不该让整条时间线读不出来。
 */
export const indexTimeline = (entries: TimelineEntry[]): TimelineIndex => {
  const byId = new Map<string, TimelineEntry>();
  for (const entry of entries) byId.set(entry.id, entry);
  const children = new Map<string, TimelineEntry[]>();
  const roots: TimelineEntry[] = [];
  for (const entry of entries) {
    const parentId = entry.parentId;
    if (!parentId || !byId.has(parentId)) {
      roots.push(entry);
      continue;
    }
    const list = children.get(parentId);
    if (list) list.push(entry);
    else children.set(parentId, [entry]);
  }
  for (const list of children.values()) list.sort((a, b) => a.seq - b.seq);
  roots.sort((a, b) => a.seq - b.seq);
  return { byId, children, roots };
};

/**
 * 从某条记录一路往上到根的链：[自己, 父, 父的父…]。
 * 游标为空（还没开始）时返回空数组。
 *
 * 环状父指针（坏数据）由 seen 挡住：一条坏记录不能把调用方拖进死循环。
 */
export const chainUp = (index: TimelineIndex, id?: string): TimelineEntry[] => {
  if (!id) return [];
  const out: TimelineEntry[] = [];
  const seen = new Set<string>();
  let current = index.byId.get(id);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    out.push(current);
    current = current.parentId ? index.byId.get(current.parentId) : undefined;
  }
  return out;
};

/**
 * 游标位置的子节点。
 *
 * 游标为空表示板面还停在**第一条记录之前**（虚拟根），这时能往前的就是那些根节点。
 * 这一处很容易漏：漏了就变成「全部撤销之后没法重做回去」。
 */
export const childrenAt = (
  index: TimelineIndex,
  id?: string,
): TimelineEntry[] =>
  id === undefined ? index.roots : (index.children.get(id) ?? []);

/** 某条记录的全部后代（游标之后的、还能前滚回去的那些）。 */
export const descendantsOf = (
  index: TimelineIndex,
  id?: string,
): TimelineEntry[] => {
  const out: TimelineEntry[] = [];
  const seen = new Set<string>(id === undefined ? [] : [id]);
  const stack = [...childrenAt(index, id)];
  while (stack.length) {
    const entry = stack.pop();
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    out.push(entry);
    for (const child of index.children.get(entry.id) ?? []) stack.push(child);
  }
  return out;
};

/**
 * 某个节点最新的子节点：重做回到你上次走的那条路。
 * 分叉后同一个父节点下可能有多个子，取最近创建的那个（seq 最大）。
 * 游标为空（虚拟根）时取最新的根节点。
 */
export const latestChild = (
  index: TimelineIndex,
  id?: string,
): TimelineEntry | undefined => {
  const children = childrenAt(index, id);
  if (!children.length) return undefined;
  return [...children].sort((a, b) => a.seq - b.seq)[children.length - 1];
};

/** 路径重放的结果。顺序必须与 core/store.ts 的接法一致。 */
export type TimelinePath = {
  /**
   * 要回退的记录：从当前往回，**新到旧**。
   * store.ts 依次应用它们的 before 快照。
   */
  undone: TimelineEntry[];
  /**
   * 要前滚的记录：从分叉点往前，**旧到新**。
   * store.ts 依次应用它们的 after 快照。
   */
  redone: TimelineEntry[];
};

/**
 * 两个位置之间的路径重放：先沿父链回退到最近公共祖先，再沿子链前滚到目标。
 *
 * 顺序是这里最容易出错的地方：undone 必须是新→旧，redone 必须是旧→新。
 * 顺序错一次，板面就会串（上轮踩过：跳到「已撤销」那条记录时先把撤销栈撤完，
 * 结果变成「回到起点」而不是「回到它刚发生时的样子」）。
 *
 * 两个位置不在同一棵树上时（各自有根）：一边退到根，另一边从根前滚。
 */
export const pathBetween = (
  index: TimelineIndex,
  from?: string,
  to?: string,
): TimelinePath | undefined => {
  if (!to) return undefined;
  if (!index.byId.has(to)) return undefined;
  const fromChain = chainUp(index, from);
  const toChain = chainUp(index, to);
  const fromIds = new Set(fromChain.map((entry) => entry.id));
  // 最近公共祖先 = to 链上最深的、同时也在 from 链上的那条。
  let lcaAt = -1;
  for (let i = 0; i < toChain.length; i++) {
    if (fromIds.has(toChain[i].id)) {
      lcaAt = i;
      break;
    }
  }
  if (lcaAt < 0) {
    // 两棵不相连的树：各自退到根 / 从根前滚。
    return { undone: [...fromChain], redone: [...toChain].reverse() };
  }
  const lca = toChain[lcaAt].id;
  const lcaFrom = fromChain.findIndex((entry) => entry.id === lca);
  const undone = lcaFrom > 0 ? fromChain.slice(0, lcaFrom) : [];
  const redone = lcaAt > 0 ? toChain.slice(0, lcaAt).reverse() : [];
  return { undone, redone };
};

/** 按 seq 升序（创建顺序）。面板与持久化都用它保证顺序稳定。 */
export const sortBySeq = (entries: TimelineEntry[]): TimelineEntry[] =>
  [...entries].sort((a, b) => a.seq - b.seq);

/** 容量裁剪的结果。 */
export type TimelinePrune = {
  entries: TimelineEntry[];
  cursorId?: string;
};

/**
 * 容量裁剪：只从**叶子**开始裁，绝不裁掉游标所在路径上的记录。
 *
 * 规则（docs/architecture/history-timeline.zh-CN.md 第 7 节）：
 *   - 裁剪只从叶子开始（没有子节点的记录），先裁最老的叶子——
 *     被分叉取代的旧分支就是最老的那批。
 *   - 游标所在的整条线（祖先 + 游标 + 游标之后的「还能前滚回去」那段）都受保护。
 *   - 裁剪后游标必须仍然有效；若游标指向被裁掉的记录，把游标上移到最近的祖先。
 *
 * 已知取舍：一条**没有分叉**的线性历史里，每条记录都在游标路径上，
 * 按规则一条也不能裁，于是条数会超过上限——上限约束的是分支增长，不是线性增长。
 * 这条取舍写在这里，免得后来的人以为裁剪坏了。
 */
export const pruneTimeline = (
  entries: TimelineEntry[],
  limit: number,
  cursorId?: string,
): TimelinePrune => {
  if (!Number.isFinite(limit) || limit <= 0 || entries.length <= limit)
    return { entries, cursorId };
  const index = indexTimeline(entries);
  const protectedIds = new Set<string>();
  for (const entry of chainUp(index, cursorId)) protectedIds.add(entry.id);
  for (const entry of descendantsOf(index, cursorId))
    protectedIds.add(entry.id);

  // 每个节点还剩几个子节点：删掉一个叶子要把父节点的计数减一，
  // 父节点因此可能变成新的叶子，可以继续往里裁（这就是「从叶子开始」）。
  const childCount = new Map<string, number>();
  for (const entry of entries) {
    if (!entry.parentId) continue;
    childCount.set(entry.parentId, (childCount.get(entry.parentId) ?? 0) + 1);
  }

  const kept = new Set(entries.map((entry) => entry.id));
  while (kept.size > limit) {
    let leaf: TimelineEntry | undefined;
    for (const entry of entries) {
      if (!kept.has(entry.id) || protectedIds.has(entry.id)) continue;
      if ((childCount.get(entry.id) ?? 0) > 0) continue;
      if (!leaf || entry.seq < leaf.seq) leaf = entry;
    }
    if (!leaf) break;
    kept.delete(leaf.id);
    if (leaf.parentId)
      childCount.set(
        leaf.parentId,
        Math.max(0, (childCount.get(leaf.parentId) ?? 1) - 1),
      );
  }

  const next = entries.filter((entry) => kept.has(entry.id));
  let nextCursor = cursorId;
  if (nextCursor && !kept.has(nextCursor)) {
    // 理论上不会发生（游标受保护）：真发生了就把游标上移到最近的祖先。
    nextCursor = nearestAncestor(index, nextCursor, kept);
  }
  return { entries: next, cursorId: nextCursor };
};

/** 某个 id 在保留集合里最近的祖先；没有就返回 undefined。 */
const nearestAncestor = (
  index: TimelineIndex,
  id: string,
  kept: Set<string>,
): string | undefined => {
  let current = index.byId.get(id);
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    const parentId = current.parentId;
    if (!parentId) return undefined;
    if (kept.has(parentId)) return parentId;
    current = index.byId.get(parentId);
  }
  return undefined;
};
