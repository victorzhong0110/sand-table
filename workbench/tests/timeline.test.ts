import { test } from "node:test";
import assert from "node:assert/strict";
import { History, migrateHistoryState } from "../core/history.ts";
import type { HistoryEntry, Patch } from "../core/objects.ts";

let seq = 0;

/** 实体快照。value 为 null 表示该实体在此刻不存在（core/store.ts 的 applySnapshot 语义）。 */
const snap = (
  target: "object" | "presentation" | "relation",
  id: string,
  value: unknown,
) => ({ target, id, value });

/** batch 补丁：一个撤销单位可以覆盖多个实体。 */
const batch = (
  id: string,
  before: ReturnType<typeof snap>[],
  after: ReturnType<typeof snap>[],
): Patch => ({ target: "batch", id, before, after });

/** 单目标补丁。 */
const single = (
  target: Patch["target"],
  id: string,
  before: unknown,
  after: unknown,
): Patch => ({ target, id, before, after });

const entry = (
  intentId: string,
  patch: Patch,
  extra?: { kind?: string; label?: string; author?: string },
): HistoryEntry => ({
  id: `e${++seq}`,
  intentId,
  label: extra?.label ?? `意图 ${intentId}`,
  at: 1000 + seq,
  author: extra?.author ?? "human",
  ...(extra?.kind === undefined ? {} : { kind: extra.kind }),
  patch,
});

/** 撤销单位里的实体快照。History 输出一律是 batch 形状。 */
const snapshots = (patch: Patch, side: "before" | "after") => {
  const raw = side === "before" ? patch.before : patch.after;
  if (Array.isArray(raw))
    return raw as { target: string; id: string; value: unknown }[];
  return [{ target: patch.target, id: patch.id, value: raw }];
};

/**
 * 模拟板面：实体 id → 值。value 为 null 即删除该实体。
 * 应用顺序与 core/store.ts 一致：先应用 undone 的 before，再应用 redone 的 after。
 */
class FakeBoard {
  values = new Map<string, unknown>();
  apply(patch: Patch, side: "before" | "after") {
    for (const item of snapshots(patch, side)) {
      if (item.value === null) this.values.delete(item.id);
      else this.values.set(item.id, item.value);
    }
  }
  get(key: string) {
    return this.values.get(key);
  }
  get size() {
    return this.values.size;
  }
}

/** 按 store.ts 的接法应用一次跳转。 */
const applyJump = (
  board: FakeBoard,
  moved: { undone: HistoryEntry[]; redone: HistoryEntry[] },
) => {
  for (const e of moved.undone) board.apply(e.patch, "before");
  for (const e of moved.redone) board.apply(e.patch, "after");
};

/** 记录一条编辑并把它的效果应用到板面。 */
const recordOn = (h: History, board: FakeBoard, e: HistoryEntry) => {
  h.record(e);
  board.apply(e.patch, "after");
};

/** 撤销一步并把回退应用到板面。 */
const undoOn = (h: History, board: FakeBoard) => {
  const undone = h.undo();
  if (undone) board.apply(undone.patch, "before");
  return undone;
};

/** 跳到某条记录并把路径重放应用到板面。 */
const jumpOn = (h: History, board: FakeBoard, id: string) => {
  const moved = h.jumpTo(id);
  assert.ok(moved, `记录 ${id} 必须能跳到`);
  applyJump(board, moved);
  return moved!;
};

// ————————————————————————————————————————————
// T1 撤销后新编辑不丢旧历史
// ————————————————————————————————————————————

test("T1 撤销后新编辑不丢旧历史：被撤销那条仍能跳回去", () => {
  const h = new History();
  const board = new FakeBoard();
  const e1 = entry("i1", single("object", "o1", null, "A"));
  const e2 = entry("i2", single("object", "o2", null, "B"));
  recordOn(h, board, e1);
  recordOn(h, board, e2);
  assert.equal(board.size, 2);

  // 撤销 e2，再做一个新编辑：新编辑从 e1 分叉出去。
  undoOn(h, board);
  assert.equal(board.size, 1, "撤销后 o2 没了");
  const e3 = entry("i3", single("object", "o3", null, "C"));
  recordOn(h, board, e3);
  assert.equal(board.size, 2, "新编辑落在 e1 之后");
  assert.equal(h.records().length, 3, "旧记录一条都没丢");

  // 跳回被撤销的那条：板面回到「e2 刚发生时的样子」。
  jumpOn(h, board, e2.id);
  assert.equal(board.get("o1"), "A");
  assert.equal(board.get("o2"), "B", "e2 的效果必须还在");
  assert.equal(board.get("o3"), undefined, "分叉出去的 e3 不该混进来");
  assert.equal(h.state.cursorId, e2.id, "游标落在跳到的记录上");
});

// ————————————————————————————————————————————
// T2 任意记录都能跳到
// ————————————————————————————————————————————

test("T2 任意记录都能跳到：板面内容等于该记录刚发生时的样子", () => {
  const h = new History();
  const board = new FakeBoard();
  const ids: string[] = [];
  for (let i = 1; i <= 5; i++) {
    const e = entry(`i${i}`, single("object", `o${i}`, null, `v${i}`));
    ids.push(e.id);
    recordOn(h, board, e);
  }
  // 逐条跳回：跳到第 k 条时，板面上应当只有 o1..ok。
  for (let k = 5; k >= 1; k--) {
    jumpOn(h, board, ids[k - 1]);
    assert.equal(board.size, k, `跳到第 ${k} 条后板面上应有 ${k} 个对象`);
    for (let i = 1; i <= k; i++)
      assert.equal(board.get(`o${i}`), `v${i}`, `o${i} 的内容要对`);
  }
  // 再逐条往前跳回去，内容也要对。
  for (let k = 2; k <= 5; k++) {
    jumpOn(h, board, ids[k - 1]);
    assert.equal(board.size, k);
    assert.equal(board.get(`o${k}`), `v${k}`);
  }
});

// ————————————————————————————————————————————
// T3 跨分支跳转正确
// ————————————————————————————————————————————

test("T3 跨分支跳转正确：两条分支来回跳，两边内容各自正确", () => {
  const h = new History();
  const board = new FakeBoard();
  const e1 = entry("i1", single("object", "o1", null, "A"));
  const e2 = entry("i2", single("object", "o2", null, "B"));
  const e3 = entry("i3", single("object", "o3", null, "C"));
  recordOn(h, board, e1);
  recordOn(h, board, e2);
  recordOn(h, board, e3);

  // 撤销 e3，从 e2 分叉出另一条路。
  undoOn(h, board);
  const e4 = entry("i4", single("object", "o4", null, "D"));
  const e5 = entry("i5", single("object", "o5", null, "E"));
  recordOn(h, board, e4);
  recordOn(h, board, e5);
  assert.equal(board.size, 4, "分支 B 上是 o1 o2 o4 o5");

  // 跳回分支 A 的 e3：o3 回来，o4 o5 退掉。
  jumpOn(h, board, e3.id);
  assert.equal(board.get("o3"), "C");
  assert.equal(board.get("o4"), undefined, "另一条分支的内容不能串过来");
  assert.equal(board.get("o5"), undefined);

  // 再跳回分支 B 的 e5：o3 退掉，o4 o5 回来。
  jumpOn(h, board, e5.id);
  assert.equal(board.get("o3"), undefined);
  assert.equal(board.get("o4"), "D");
  assert.equal(board.get("o5"), "E");
  assert.equal(board.size, 4);
});

test("T3 跳转的顺序：undone 是新到旧，redone 是旧到新", () => {
  const h = new History();
  const e1 = entry("i1", single("object", "o1", null, "A"));
  const e2 = entry("i2", single("object", "o2", null, "B"));
  const e3 = entry("i3", single("object", "o3", null, "C"));
  h.record(e1);
  h.record(e2);
  h.record(e3);

  const back = h.jumpTo(e1.id)!;
  assert.deepEqual(
    back.undone.map((e) => e.id),
    [e3.id, e2.id],
    "回退段必须新到旧",
  );
  assert.deepEqual(back.redone, [], "往回跳没有前滚段");

  const forward = h.jumpTo(e3.id)!;
  assert.deepEqual(forward.undone, [], "往前跳没有回退段");
  assert.deepEqual(
    forward.redone.map((e) => e.id),
    [e2.id, e3.id],
    "前滚段必须旧到新",
  );
});

test("跳到不存在的记录返回 undefined，不静默成功", () => {
  const h = new History();
  h.record(entry("i1", single("object", "o1", null, "A")));
  assert.equal(h.jumpTo("不存在的记录"), undefined);
});

// ————————————————————————————————————————————
// T4 一次意图仍然是一步
// ————————————————————————————————————————————

test("T4 一次意图仍然是一步：连续三次输入一次撤销全回退", () => {
  const h = new History();
  const board = new FakeBoard();
  h.record(entry("typing", single("object", "o1", "a", "ab")));
  h.record(entry("typing", single("object", "o1", "ab", "abc")));
  h.record(entry("typing", single("object", "o1", "abc", "abcd")));
  board.apply(h.state.entries[0].patch, "after");
  assert.equal(h.records().length, 1, "一个意图只占一条记录");
  assert.equal(board.get("o1"), "abcd");

  const undone = undoOn(h, board);
  assert.equal(board.get("o1"), "a", "一次撤销回到最初状态");
  assert.equal(undone!.patch.target, "batch");
  assert.equal(h.undo(), undefined, "没有更多可撤销的了");
});

test("T4 撤销/重做会打断意图分组：新编辑不并入被撤销的意图", () => {
  const h = new History();
  const drag = entry("drag", single("object", "o1", 0, 1));
  h.record(drag);
  h.record(entry("other", single("object", "o2", 1, 2)));
  h.undo();
  h.record(entry("drag", single("object", "o1", 1, 5)));
  const records = h.records();
  assert.equal(records.length, 3, "被撤销的意图与新编辑是两个撤销单位");
  const merged = records.find((r) => r.id === drag.id)!;
  assert.equal(
    merged.label,
    drag.label,
    "旧记录不被改写（合并只发生在连续同意图时）",
  );
});

// ————————————————————————————————————————————
// T5 撤销不震荡
// ————————————————————————————————————————————

test("T5 撤销不震荡：连续两次 undo 拿到两条不同记录", () => {
  const h = new History();
  const a = entry("i1", single("object", "o1", 0, 1));
  const b = entry("i2", single("object", "o2", 1, 2));
  const c = entry("i3", single("object", "o3", 2, 3));
  h.record(a);
  h.record(b);
  h.record(c);

  assert.equal(h.undo()!.id, c.id);
  assert.equal(h.undo()!.id, b.id, "再次 undo 必须取到更早的条目");
  assert.equal(h.undo()!.id, a.id);
  assert.equal(h.undo(), undefined);
  assert.equal(h.canUndo, false);
  assert.equal(h.canRedo, true, "还有没重做的记录");
});

test("T5 undo→redo→undo 结果一致", () => {
  const h = new History();
  const a = entry("i1", single("object", "o1", 0, 1));
  const b = entry("i2", single("object", "o2", 1, 2));
  h.record(a);
  h.record(b);

  const undone = h.undo()!;
  assert.equal(undone.id, b.id);
  const redone = h.redo()!;
  assert.equal(redone.id, b.id, "重做回到同一条");
  const again = h.undo()!;
  assert.equal(again.id, undone.id, "再撤销还是同一条");
  assert.equal(h.state.cursorId, a.id);
});

test("重做走最近创建的那条分支", () => {
  const h = new History();
  const e1 = entry("i1", single("object", "o1", null, "A"));
  const e2 = entry("i2", single("object", "o2", null, "B"));
  h.record(e1);
  h.record(e2);
  h.undo();
  // 从 e1 分叉出一条新路（比 e2 新）。
  const e3 = entry("i3", single("object", "o3", null, "C"));
  h.record(e3);
  h.undo();
  const redone = h.redo()!;
  assert.equal(redone.id, e3.id, "重做回到你上次走的那条路");
});

// ————————————————————————————————————————————
// T6 外部效果仍不入栈
// ————————————————————————————————————————————

test("T6 外部效果仍不入栈：被拒绝且出现在 refused 里", () => {
  const h = new History();
  h.record(
    entry("publish-pr", single("object", "o1", null, { id: "o1" }), {
      kind: "publish",
      author: "agent",
    }),
  );
  assert.equal(h.canUndo, false, "外部效果不得进入白板撤销栈（I12）");
  assert.equal(h.records().length, 0);
  assert.equal(h.refused.length, 1);
  assert.equal(h.refused[0].entry.kind, "publish");
  assert.match(h.refused[0].reason, /I12/);

  h.record(
    entry("edit", single("object", "o2", null, { id: "o2" }), {
      kind: "edit-object",
    }),
  );
  assert.equal(h.canUndo, true, "白板内编辑照常进撤销栈");
  assert.equal(h.records().length, 1);
  assert.equal(h.refused.length, 1, "拒绝列表不受后续记录影响");
});

test("T6 被拒绝的外部效果不会顶掉已有的历史", () => {
  const h = new History();
  const e1 = entry("edit", single("object", "o1", 0, 1), {
    kind: "edit-object",
  });
  h.record(e1);
  h.undo();
  assert.equal(h.canRedo, true);
  h.record(
    entry("publish", single("object", "o2", null, { id: "o2" }), {
      kind: "publish",
    }),
  );
  assert.equal(h.canRedo, true, "被拒绝的外部效果不得动到已有历史");
  assert.equal(h.records().length, 1, "老记录还在");
  assert.equal(h.redo()!.id, e1.id, "还能重做回去");
});

test("严格模式下未声明动作种类的条目不进撤销栈", () => {
  const h = new History(undefined, { requireKind: true });
  h.record(entry("i1", single("object", "o1", 0, 1)));
  assert.equal(h.canUndo, false);
  assert.equal(h.refused.length, 1);
  assert.match(h.refused[0].reason, /kind/);

  const loose = new History();
  loose.record(entry("i1", single("object", "o1", 0, 1)));
  assert.equal(loose.canUndo, true, "默认模式下未声明 kind 仍可撤销");
  assert.equal(loose.unclassified.length, 1, "未分类的条目要能被看见");
});

// ————————————————————————————————————————————
// T7 迁移不丢记录
// ————————————————————————————————————————————

test("T7 迁移不丢记录：v1 的 undo + redo 全部落进 v2，且都能跳到", () => {
  const a = entry("i1", single("object", "o1", null, "A"));
  const b = entry("i2", single("object", "o2", null, "B"));
  const c = entry("i3", single("object", "o3", null, "C"));
  const migrated = migrateHistoryState({ undo: [a, b], redo: [c] });
  assert.equal(migrated.version, 2);
  assert.equal(migrated.entries.length, 3, "v1 的 undo + redo 一条都不能少");
  assert.equal(migrated.cursorId, b.id, "游标落在 undo 栈最后一条");
  assert.equal(migrated.entries[0].parentId, undefined, "第一条是根");
  assert.equal(migrated.entries[1].parentId, a.id, "undo 栈串成一条链");
  assert.equal(
    migrated.entries[2].parentId,
    b.id,
    "redo 栈的记录挂在游标之下，成为分支",
  );

  // 迁移后每一条都还能跳到。
  const h = new History(migrated);
  const board = new FakeBoard();
  // 板面状态 = 游标路径上的那些记录（v1 的 undo 栈）；c 还在重做栈里，没生效。
  for (const e of migrated.entries) {
    if (e.id === a.id || e.id === b.id) board.apply(e.patch, "after");
  }
  assert.equal(board.size, 2);
  jumpOn(h, board, a.id);
  assert.equal(board.size, 1, "跳到第一条后只剩它自己");
  jumpOn(h, board, c.id);
  assert.equal(board.size, 3, "跳到最后一条，三个都在");
});

test("T7 迁移后重做顺序与 v1 一致", () => {
  const a = entry("i1", single("object", "o1", null, "A"));
  const b = entry("i2", single("object", "o2", null, "B"));
  const c = entry("i3", single("object", "o3", null, "C"));
  // v1：撤销过 c 与 b，redo 栈是 [c, b]（末尾是下一个要重做的）。
  const h = new History(migrateHistoryState({ undo: [a], redo: [c, b] }));
  assert.equal(h.redo()!.id, b.id, "先重做 b");
  assert.equal(h.redo()!.id, c.id, "再重做 c");
  assert.equal(h.redo(), undefined);
});

// ————————————————————————————————————————————
// T8 裁剪不破坏游标
// ————————————————————————————————————————————

test("T8 裁剪不破坏游标：裁剪后游标仍有效、被分叉的旧分支被裁掉、历史仍可跳", () => {
  const h = new History(undefined, { limit: 6 });
  const board = new FakeBoard();
  const spine: HistoryEntry[] = [];
  // 主干：6 条连续编辑。
  for (let i = 0; i < 6; i++) {
    const e = entry(`s${i}`, single("object", `o${i}`, null, `v${i}`));
    spine.push(e);
    recordOn(h, board, e);
  }
  // 退回去，从中间分叉出一条新路。
  undoOn(h, board);
  undoOn(h, board);
  undoOn(h, board);
  const branch: HistoryEntry[] = [];
  for (let i = 0; i < 8; i++) {
    const e = entry(`b${i}`, single("object", `b${i}`, null, `bv${i}`));
    branch.push(e);
    recordOn(h, board, e);
  }

  const ids = h.records().map((r) => r.id);
  assert.ok(
    !ids.includes(spine[3].id) &&
      !ids.includes(spine[4].id) &&
      !ids.includes(spine[5].id),
    "被分叉取代的那段旧分支要从叶子上裁掉",
  );
  for (const e of branch) assert.ok(ids.includes(e.id), "当前分支一条都不能少");
  const cursor = h.state.cursorId;
  assert.ok(cursor, "裁剪后游标必须仍然有效");
  assert.ok(
    h.records().some((r) => r.id === cursor),
    "游标指向的记录必须还在",
  );
  assert.equal(h.canUndo, true);

  // 裁剪后历史仍可跳：跳回主干第一条，板面内容要对得上。
  jumpOn(h, board, spine[0].id);
  assert.equal(board.get("o0"), "v0");
  assert.equal(board.get("o1"), undefined, "跳回第一条后 o1 还没生效");
  assert.equal(board.get("b0"), undefined, "分支上的内容不能串过来");
});

test("已知取舍：线性历史里每条记录都在游标路径上，按规格不能裁", () => {
  // 规格第 7 节：裁剪只从叶子开始，且绝不裁剪当前游标所在路径上的记录。
  // 一条没有分叉的线性历史里，路径就是全部，所以条数会超过上限——
  // 上限约束的是分支增长，不是线性增长。这条测试把这个取舍钉住，
  // 免得以后有人以为是裁剪坏了。
  const h = new History(undefined, { limit: 3 });
  for (let i = 0; i < 8; i++)
    h.record(entry(`i${i}`, single("object", `o${i}`, null, `v${i}`)));
  assert.equal(h.records().length, 8);
  assert.equal(h.state.cursorId, h.records()[7].id, "游标仍在最后一条");
});

test("T8 裁剪只动叶子：游标路径上的记录一条都不少", () => {
  const h = new History(undefined, { limit: 3 });
  const e1 = entry("i1", single("object", "o1", null, "A"));
  const e2 = entry("i2", single("object", "o2", null, "B"));
  const e3 = entry("i3", single("object", "o3", null, "C"));
  h.record(e1);
  h.record(e2);
  h.record(e3);
  // 从 e2 分叉，制造一个可裁的叶子。
  h.undo();
  const e4 = entry("i4", single("object", "o4", null, "D"));
  h.record(e4);
  h.record(entry("i5", single("object", "o5", null, "E")));
  const ids = h.records().map((r) => r.id);
  assert.ok(ids.includes(e1.id), "根不能被裁");
  assert.ok(ids.includes(e2.id), "游标路径上的记录不能被裁");
  assert.ok(ids.includes(e4.id), "游标所在分支不能被裁");
});

// ————————————————————————————————————————————
// 视图与持久化形状
// ————————————————————————————————————————————

test("state 是 v2 形状：version + entries + cursorId，且是副本", () => {
  const h = new History();
  const e1 = entry("i1", single("object", "o1", null, "A"));
  h.record(e1);
  const state = h.state;
  assert.equal(state.version, 2);
  assert.equal(state.entries.length, 1);
  assert.equal(state.cursorId, e1.id);
  assert.equal(state.entries[0].seq, 0);

  state.entries.push({ ...e1, id: "偷偷加的", seq: 9 });
  assert.equal(h.state.entries.length, 1, "state 必须是副本");
});

test("落盘再读回仍能跳到旧记录（v2 状态的往返）", () => {
  const h = new History();
  const board = new FakeBoard();
  const e1 = entry("i1", single("object", "o1", null, "A"));
  const e2 = entry("i2", single("object", "o2", null, "B"));
  recordOn(h, board, e1);
  recordOn(h, board, e2);
  h.undo();

  // 存盘 → 读回 → 还能跳。
  const restored = new History(JSON.parse(JSON.stringify(h.state)));
  const board2 = new FakeBoard();
  board2.apply(restored.state.entries[0].patch, "after");
  jumpOn(restored, board2, e1.id);
  assert.equal(board2.get("o1"), "A");
  assert.equal(board2.get("o2"), undefined, "被撤销的那条在读回后仍可跳回去");
  assert.equal(restored.state.cursorId, e1.id);
});

test("records() 标出当前位置、可撤销路径、还能前滚的与旧分支", () => {
  const h = new History();
  const e1 = entry("i1", single("object", "o1", null, "A"));
  const e2 = entry("i2", single("object", "o2", null, "B"));
  const e3 = entry("i3", single("object", "o3", null, "C"));
  h.record(e1);
  h.record(e2);
  h.record(e3);
  h.undo();
  const e4 = entry("i4", single("object", "o4", null, "D"));
  h.record(e4);

  const records = h.records();
  const byId = new Map(records.map((r) => [r.id, r]));
  assert.equal(byId.get(e4.id)!.current, true, "e4 是当前位置");
  assert.equal(byId.get(e4.id)!.onPath, true);
  assert.equal(byId.get(e2.id)!.onPath, true, "祖先在可撤销路径上");
  assert.equal(byId.get(e1.id)!.onPath, true);
  assert.equal(byId.get(e3.id)!.branch, true, "e3 是被分叉取代的旧分支");
  assert.equal(byId.get(e3.id)!.onPath, false);
  assert.equal(byId.get(e3.id)!.ahead, false);
  assert.equal(byId.get(e4.id)!.parentId, e2.id, "父指针指向它分叉自的那条");
});

test("记录格式错误的历史条目时立刻报错", () => {
  const h = new History();
  assert.throws(() => h.record(undefined as unknown as HistoryEntry));
  assert.throws(
    () =>
      h.record({
        id: "x",
        intentId: "",
        label: "x",
        at: 1,
        author: "human",
        patch: { target: "object", id: "o1", before: null, after: null },
      } as unknown as HistoryEntry),
    /intentId/,
  );
  assert.throws(
    () =>
      h.record({
        id: "x",
        intentId: "i1",
        label: "x",
        at: 1,
        author: "human",
      } as unknown as HistoryEntry),
    /patch/,
  );
  assert.throws(
    () =>
      h.record({
        id: "x",
        intentId: "i1",
        label: "x",
        at: 1,
        author: "human",
        patch: { target: "batch", id: "b", before: "不是数组", after: [] },
      } as unknown as HistoryEntry),
    /batch/,
  );
  assert.equal(h.records().length, 0);
});
