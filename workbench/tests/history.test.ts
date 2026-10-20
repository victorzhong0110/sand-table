import { test } from "node:test";
import assert from "node:assert/strict";
import {
  History,
  appendAudit,
  externalEffectKinds,
  isExternalEffect,
  redoPath,
  undoPath,
} from "../core/history.ts";
import type { AuditEntry, HistoryEntry, Patch } from "../core/objects.ts";

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

const audit = (id: string, via?: "undo" | "redo"): AuditEntry => ({
  id,
  at: 2000,
  actor: "human",
  actorKind: "human",
  action: via ?? "edit",
  via,
});

/**
 * 撤销单位里的实体快照。History 输出一律是 batch 形状
 * （core/store.ts 的 applyPatch 只认快照数组）。
 */
const snapshots = (patch: Patch, side: "before" | "after") => {
  const raw = side === "before" ? patch.before : patch.after;
  // 输入可以是单目标形状；History 输出一律是 batch 形状。
  if (Array.isArray(raw))
    return raw as { target: string; id: string; value: unknown }[];
  return [{ target: patch.target, id: patch.id, value: raw }];
};

/** 撤销单位里第一个实体的值。 */
const valueOf = (patch: Patch, side: "before" | "after"): unknown =>
  snapshots(patch, side)[0]?.value;

/** 模拟 core/store.ts 的 applySnapshot：value 为 null 即删除。 */
const applyValues = (
  board: Map<string, unknown>,
  list: { id: string; value: unknown }[],
) => {
  for (const item of list) {
    if (item.value === null) board.delete(item.id);
    else board.set(item.id, item.value);
  }
};

/** 按补丁的一侧施加快照。 */
const apply = (
  board: Map<string, unknown>,
  patch: Patch,
  side: "before" | "after",
) => {
  applyValues(
    board,
    snapshots(patch, side).map((s) => ({ id: s.id, value: s.value })),
  );
};

test("不同 intentId 的编辑各自是一个撤销单位，undo 三次回到初始状态", () => {
  const h = new History();
  const board = new Map<string, unknown>();
  const a = entry("i1", single("object", "o1", null, { id: "o1", title: "A" }));
  const b = entry("i2", single("object", "o2", null, { id: "o2", title: "B" }));
  const c = entry("i3", single("object", "o3", null, { id: "o3", title: "C" }));
  for (const e of [a, b, c]) {
    h.record(e);
    apply(board, e.patch, "after");
  }
  assert.equal(board.size, 3, "三个意图各建了一个对象");
  assert.equal(h.canUndo, true);
  assert.equal(h.canRedo, false);
  assert.equal(undoPath(h.state).length, 3);
  assert.equal(redoPath(h.state).length, 0);

  const first = h.undo();
  assert.equal(first!.id, c.id);
  assert.equal(first!.patch.id, "o3");
  const second = h.undo();
  assert.equal(second!.id, b.id);
  assert.equal(second!.patch.id, "o2");
  const third = h.undo();
  assert.equal(third!.id, a.id);
  assert.equal(third!.patch.id, "o1");

  // 三次撤销回到起点：对象一个都不剩。
  apply(board, third!.patch, "before");
  apply(board, second!.patch, "before");
  apply(board, first!.patch, "before");
  assert.equal(board.size, 0, "三次 undo 必须把三个对象都清掉");

  assert.equal(h.canUndo, false);
  assert.equal(undoPath(h.state).length, 0);
  assert.equal(redoPath(h.state).length, 3);
});

test("同一 intentId 的连续变更合并为一个撤销单位，undo 一次回到最初 before", () => {
  const h = new History();
  const board = new Map<string, unknown>();
  const first = entry("typing", single("object", "o1", "a", "ab"));
  h.record(first);
  h.record(entry("typing", single("object", "o1", "ab", "abc")));
  h.record(entry("typing", single("object", "o1", "abc", "abcd")));
  applyValues(board, [{ id: "o1", value: "abcd" }]);

  assert.equal(undoPath(h.state).length, 1, "一个意图只占一个撤销单位");
  const merged = undoPath(h.state)[0];
  assert.equal(
    valueOf(merged.patch, "before"),
    "a",
    "合并后必须保留最早的 before",
  );
  assert.equal(
    valueOf(merged.patch, "after"),
    "abcd",
    "合并后必须覆盖最新的 after",
  );
  assert.equal(merged.intentId, "typing");
  assert.equal(merged.id, first.id, "撤销单位的身份沿用最早那条");

  const undone = h.undo();
  assert.equal(valueOf(undone!.patch, "before"), "a");
  apply(board, undone!.patch, "before");
  assert.equal(board.get("o1"), "a", "一次 undo 回到最初状态");
  assert.equal(h.undo(), undefined);
});

test("同一意图内创建两个对象：一次 undo 全部回退，redo 全部恢复", () => {
  const h = new History();
  const board = new Map<string, unknown>();
  const objectA = { id: "o1", title: "A" };
  const objectB = { id: "o2", title: "B" };
  h.record(
    entry(
      "agent-batch",
      batch(
        "o1",
        [snap("object", "o1", null)],
        [snap("object", "o1", objectA)],
      ),
    ),
  );
  h.record(
    entry(
      "agent-batch",
      batch(
        "o2",
        [snap("object", "o2", null)],
        [snap("object", "o2", objectB)],
      ),
    ),
  );
  applyValues(board, [
    { id: "o1", value: objectA },
    { id: "o2", value: objectB },
  ]);
  assert.equal(board.size, 2);

  assert.equal(
    undoPath(h.state).length,
    1,
    "同一意图的多条 record 合并为一个单位",
  );
  const undone = h.undo();
  assert.equal(undone!.patch.target, "batch", "多实体必须用 batch 表达");
  const before = undone!.patch.before as { id: string; value: unknown }[];
  const after = undone!.patch.after as { id: string; value: unknown }[];
  assert.equal(before.length, 2, "合并后必须覆盖两个实体");
  assert.equal(after.length, 2, "合并后必须覆盖两个实体");
  assert.deepEqual(
    before.map((s) => s.id).sort(),
    ["o1", "o2"],
    "两个实体都要在撤销快照里",
  );
  assert.ok(
    before.every((s) => s.value === null),
    "before 取各实体最早值：两个对象在意图开始时都不存在",
  );
  assert.deepEqual(after.find((s) => s.id === "o1")!.value, objectA);
  assert.deepEqual(after.find((s) => s.id === "o2")!.value, objectB);

  applyValues(board, before);
  assert.equal(board.size, 0, "一次 undo 必须把两个对象都回退，不能只回退一半");

  const redone = h.redo();
  const redoneAfter = redone!.patch.after as { id: string; value: unknown }[];
  assert.equal(redoneAfter.length, 2, "redo 必须把两个对象都恢复");
  applyValues(board, redoneAfter);
  assert.equal(board.size, 2, "redo 不能永久丢失另一个对象");
  assert.deepEqual(board.get("o1"), objectA);
  assert.deepEqual(board.get("o2"), objectB);
});

test("同一意图内同一实体被改多次：合并后 before 取最早、after 取最新", () => {
  const h = new History();
  h.record(
    entry(
      "agent-batch",
      batch(
        "o1",
        [snap("object", "o1", { title: "A" })],
        [snap("object", "o1", { title: "B" })],
      ),
    ),
  );
  h.record(
    entry(
      "agent-batch",
      batch(
        "o1",
        [snap("object", "o1", { title: "B" })],
        [snap("object", "o1", { title: "C" })],
      ),
    ),
  );
  const merged = undoPath(h.state)[0];
  const before = merged.patch.before as { id: string; value: unknown }[];
  const after = merged.patch.after as { id: string; value: unknown }[];
  assert.equal(before.length, 1);
  assert.deepEqual(before[0].value, { title: "A" }, "before 取最早值");
  assert.deepEqual(after[0].value, { title: "C" }, "after 取最新值");
});

test("同一意图内混合单目标补丁与 batch 补丁：合并成覆盖全部实体的 batch", () => {
  const h = new History();
  h.record(entry("mixed", single("object", "o1", null, { id: "o1" })));
  h.record(
    entry(
      "mixed",
      batch(
        "p1",
        [snap("presentation", "p1", null)],
        [snap("presentation", "p1", { id: "p1" })],
      ),
    ),
  );
  const merged = undoPath(h.state)[0];
  assert.equal(merged.patch.target, "batch");
  const before = merged.patch.before as { target: string; id: string }[];
  assert.equal(before.length, 2);
  assert.deepEqual(before.map((s) => `${s.target}:${s.id}`).sort(), [
    "object:o1",
    "presentation:p1",
  ]);
});

test("不连续的同一 intentId 不合并，各算一个撤销单位", () => {
  const h = new History();
  h.record(entry("i1", single("object", "o1", 0, 1)));
  h.record(entry("i2", single("object", "o2", 1, 2)));
  h.record(entry("i1", single("object", "o3", 2, 3)));
  assert.equal(undoPath(h.state).length, 3);
  const top = h.undo();
  assert.equal(top!.patch.id, "o3", "后来的 i1 不得并入前面的 i1");
});

test("undo 后 redo 恢复，再 undo 能再次撤销，不来回震荡", () => {
  const h = new History();
  const a = entry("i1", single("object", "o1", 0, 1));
  const b = entry("i2", single("object", "o2", 1, 2));
  const c = entry("i3", single("object", "o3", 2, 3));
  h.record(a);
  h.record(b);
  h.record(c);

  assert.equal(h.undo()!.id, c.id);
  assert.equal(undoPath(h.state).length, 2);
  assert.equal(redoPath(h.state).length, 1);
  assert.equal(redoPath(h.state)[0].id, c.id);
  assert.equal(
    undoPath(h.state).some((e) => e.id === c.id),
    false,
    "撤销后该条目只能出现在 redo 栈",
  );

  assert.equal(h.undo()!.id, b.id, "再次 undo 必须取到更早的条目");
  assert.equal(undoPath(h.state).length, 1);
  assert.equal(redoPath(h.state).length, 2);

  assert.equal(h.redo()!.id, b.id, "redo 恢复最近被撤销的条目");
  assert.equal(undoPath(h.state).length, 2);
  assert.equal(
    undoPath(h.state).some((e) => e.id === b.id),
    true,
  );

  assert.equal(h.undo()!.id, b.id, "redo 之后必须能再次撤销它");
  assert.equal(h.undo()!.id, a.id);
  assert.equal(h.undo(), undefined);
  assert.equal(h.canUndo, false);

  assert.equal(h.redo()!.id, a.id, "重做按时间顺序回放");
  assert.equal(h.redo()!.id, b.id);
  assert.equal(h.redo()!.id, c.id);
  assert.equal(h.redo(), undefined);
  assert.equal(undoPath(h.state).length, 3);
  assert.equal(h.canRedo, false);
});

test("undo 之后产生新记录会清空重做栈", () => {
  const h = new History();
  h.record(entry("i1", single("object", "o1", 0, 1)));
  h.record(entry("i2", single("object", "o2", 1, 2)));
  h.undo();
  assert.equal(h.canRedo, true);
  assert.equal(redoPath(h.state).length, 1);

  h.record(entry("i3", single("object", "o3", 2, 3)));
  assert.equal(h.canRedo, false);
  assert.equal(redoPath(h.state).length, 0);
  assert.equal(undoPath(h.state).length, 2);
});

test("clearRedo 显式丢弃重做栈", () => {
  const h = new History();
  h.record(entry("i1", single("object", "o1", 0, 1)));
  h.undo();
  assert.equal(h.canRedo, true);
  h.clearRedo();
  assert.equal(h.canRedo, false);
  assert.equal(redoPath(h.state).length, 0);
});

test("撤销之后的新编辑不会并入被撤销的意图", () => {
  const h = new History();
  h.record(entry("drag", single("object", "o1", 0, 1)));
  h.record(entry("other", single("object", "o2", 1, 2)));
  h.undo();
  h.record(entry("drag", single("object", "o1", 1, 5)));
  assert.equal(
    undoPath(h.state).length,
    2,
    "被撤销的意图与新编辑是两个撤销单位",
  );
  assert.equal(valueOf(h.undo()!.patch, "before"), 1);
});

test("外部效果不进撤销栈，只留在拒绝列表里", () => {
  const h = new History();
  h.record(
    entry("publish-pr", single("object", "o1", null, { id: "o1" }), {
      kind: "publish",
      author: "agent",
    }),
  );
  assert.equal(h.canUndo, false, "外部效果不得进入白板撤销栈（I12）");
  assert.equal(undoPath(h.state).length, 0);
  assert.equal(redoPath(h.state).length, 0);
  assert.equal(h.refused.length, 1);
  assert.equal(h.refused[0].entry.kind, "publish");
  assert.match(h.refused[0].reason, /I12/);

  h.record(
    entry("edit", single("object", "o2", null, { id: "o2" }), {
      kind: "edit-object",
    }),
  );
  assert.equal(h.canUndo, true, "白板内编辑照常进撤销栈");
  assert.equal(undoPath(h.state).length, 1);
  assert.equal(undoPath(h.state)[0].kind, "edit-object");
  assert.equal(h.refused.length, 1, "拒绝列表不受后续记录影响");
});

test("外部效果被拒绝后不会进入重做栈，也不影响已有撤销栈", () => {
  const h = new History();
  h.record(
    entry("edit", single("object", "o1", 0, 1), { kind: "edit-object" }),
  );
  h.undo();
  assert.equal(h.canRedo, true);
  h.record(
    entry("publish", single("object", "o2", null, { id: "o2" }), {
      kind: "publish",
    }),
  );
  assert.equal(h.canRedo, true, "被拒绝的外部效果不得清空重做栈");
  assert.equal(redoPath(h.state).length, 1);
  assert.equal(undoPath(h.state).length, 0);
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

test("审计日志只追加不删除，撤销本身由调用方写进审计", () => {
  const h = new History();
  h.record(entry("i1", single("object", "o1", 0, 1)));
  h.record(entry("i2", single("object", "o2", 1, 2)));

  let log: AuditEntry[] = [];
  const first = audit("a1");
  log = appendAudit(log, first);
  assert.equal(log.length, 1);
  assert.equal(log[0], first);

  const undone = h.undo();
  assert.equal(undone!.patch.id, "o2");
  assert.equal(log.length, 1, "undo 本身不修改审计日志");

  log = appendAudit(log, audit("a2", "undo"));
  assert.equal(log.length, 2);
  assert.equal(log[1].via, "undo");
  assert.equal(log[1].id, "a2");

  const kept = [...log];
  log = appendAudit(log, audit("a3", "redo"));
  assert.equal(log.length, 3);
  assert.deepEqual(log.slice(0, 2), kept, "已有审计条目不得被删除或改写");
  assert.equal(log[2].via, "redo");

  assert.equal(log.length, 3, "审计条目数与撤销栈长度是两回事");
  assert.equal(undoPath(h.state).length, 1);
  assert.equal(redoPath(h.state).length, 1);
});

test("isExternalEffect 区分外部效果与白板内操作", () => {
  for (const kind of ["publish", "run-experiment", "send", "commit-external"]) {
    assert.equal(isExternalEffect(kind), true, `${kind} 是外部效果`);
    assert.equal(externalEffectKinds.includes(kind), true);
  }
  for (const kind of [
    "edit-object",
    "move",
    "resize",
    "fold",
    "create-presentation",
  ]) {
    assert.equal(isExternalEffect(kind), false, `${kind} 是白板内操作`);
    assert.equal(externalEffectKinds.includes(kind), false);
  }
  assert.equal(
    isExternalEffect("never-registered"),
    true,
    "未登记的 kind 按外部处理，白板撤销不得冒充外部回滚",
  );
});

test("空栈 undo/redo 返回 undefined，不抛错", () => {
  const h = new History();
  assert.equal(h.canUndo, false);
  assert.equal(h.canRedo, false);
  assert.equal(h.undo(), undefined);
  assert.equal(h.redo(), undefined);
  assert.equal(h.undo(), undefined);
  assert.equal(undoPath(h.state).length, 0);
  assert.equal(redoPath(h.state).length, 0);
});

test("可以从持久化状态恢复，state 返回副本", () => {
  const a = entry("i1", single("object", "o1", 0, 1));
  const b = entry("i2", single("object", "o2", 1, 2));
  const c = entry("i3", single("object", "o3", 2, 3));
  const h = new History({ undo: [a, b], redo: [c] });
  assert.equal(h.canUndo, true);
  assert.equal(h.canRedo, true);
  assert.equal(undoPath(h.state).length, 2);
  assert.equal(redoPath(h.state).length, 1);
  assert.equal(h.undo()!.id, b.id);

  /* v2 里没有双栈：直接往时间线上追加一条记录，游标停在它上面。 */
  const snapshot = h.state;
  snapshot.entries.push({
    ...entry("i4", single("object", "o4", 2, 9)),
    parentId: snapshot.cursorId,
    seq: snapshot.entries.length,
  });
  snapshot.cursorId = "i4";
  assert.equal(
    undoPath(h.state).length,
    1,
    "state 必须是副本，外部改动不得影响内部状态",
  );
  assert.equal(redoPath(h.state).length, 2);
});

test("记录后改写原条目不影响撤销栈", () => {
  const h = new History();
  const e = entry("i1", single("object", "o1", { title: "A" }, { title: "B" }));
  h.record(e);
  e.patch.after = { title: "被篡改" };
  e.label = "被篡改";
  const undone = h.undo()!;
  assert.equal(
    (valueOf(undone.patch, "after") as { title: string }).title,
    "B",
  );
  assert.equal(undone.label, "意图 i1");
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
  assert.throws(
    () =>
      h.record({
        id: "x",
        intentId: "i1",
        label: "x",
        at: 1,
        author: "human",
        patch: { target: "wat", id: "b", before: null, after: null },
      } as unknown as HistoryEntry),
    /target/,
  );
  assert.equal(undoPath(h.state).length, 0);
});
