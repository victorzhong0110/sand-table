import { test } from "node:test";
import assert from "node:assert/strict";
import {
  History,
  appendAudit,
  externalEffectKinds,
  isExternalEffect,
} from "../core/history.ts";
import type { AuditEntry, HistoryEntry } from "../core/objects.ts";

let seq = 0;
const entry = (
  intentId: string,
  before: unknown,
  after: unknown,
  patchId = "o1",
): HistoryEntry => ({
  id: `e${++seq}`,
  intentId,
  label: `意图 ${intentId}`,
  at: 1000 + seq,
  author: "human",
  patch: { target: "object", id: patchId, before, after },
});

const audit = (id: string, via?: "undo" | "redo"): AuditEntry => ({
  id,
  at: 2000,
  actor: "human",
  actorKind: "human",
  action: via ?? "edit",
  via,
});

test("不同 intentId 的编辑各自是一个撤销单位，undo 三次回到初始状态", () => {
  const h = new History();
  let value = 0;
  const a = entry("i1", 0, 1);
  const b = entry("i2", 1, 2);
  const c = entry("i3", 2, 3);
  for (const e of [a, b, c]) {
    h.record(e);
    value = e.patch.after as number;
  }
  assert.equal(value, 3);
  assert.equal(h.canUndo, true);
  assert.equal(h.canRedo, false);
  assert.equal(h.state.undo.length, 3);
  assert.equal(h.state.redo.length, 0);

  const first = h.undo();
  assert.equal(first, c);
  assert.equal(first!.patch.before, 2);
  value = first!.patch.before as number;
  assert.equal(value, 2);

  const second = h.undo();
  assert.equal(second, b);
  value = second!.patch.before as number;
  assert.equal(value, 1);

  const third = h.undo();
  assert.equal(third, a);
  value = third!.patch.before as number;
  assert.equal(value, 0);

  assert.equal(h.canUndo, false);
  assert.equal(h.state.undo.length, 0);
  assert.equal(h.state.redo.length, 3);
});

test("同一 intentId 的连续变更合并为一个撤销单位，undo 一次回到最初 before", () => {
  const h = new History();
  const first = entry("drag", 0, 1);
  const second = entry("drag", 1, 2);
  const third = entry("drag", 2, 3);
  h.record(first);
  h.record(second);
  h.record(third);

  assert.equal(h.state.undo.length, 1);
  const merged = h.state.undo[0];
  assert.equal(merged.patch.before, 0, "合并后必须保留最早的 before");
  assert.equal(merged.patch.after, 3, "合并后必须覆盖最新的 after");
  assert.equal(merged.intentId, "drag");
  assert.equal(merged.id, first.id, "撤销单位的身份沿用最早那条");

  const undone = h.undo();
  assert.equal(undone!.patch.before, 0);
  assert.equal(undone!.patch.after, 3);
  assert.equal(h.undo(), undefined, "一个意图只占一个撤销单位");
  assert.equal(h.state.undo.length, 0);
});

test("不连续的同一 intentId 不合并，各算一个撤销单位", () => {
  const h = new History();
  h.record(entry("i1", 0, 1));
  h.record(entry("i2", 1, 2));
  h.record(entry("i1", 2, 3));
  assert.equal(h.state.undo.length, 3);
  const top = h.undo();
  assert.equal(top!.patch.before, 2, "后来的 i1 不得并入前面的 i1");
});

test("undo 后 redo 恢复，再 undo 能再次撤销，不来回震荡", () => {
  const h = new History();
  const a = entry("i1", 0, 1);
  const b = entry("i2", 1, 2);
  const c = entry("i3", 2, 3);
  h.record(a);
  h.record(b);
  h.record(c);

  assert.equal(h.undo(), c);
  assert.equal(h.state.undo.length, 2);
  assert.equal(h.state.redo.length, 1);
  assert.equal(h.state.redo[0], c);
  assert.equal(
    h.state.undo.includes(c),
    false,
    "撤销后该条目只能出现在 redo 栈",
  );

  assert.equal(h.undo(), b, "再次 undo 必须取到更早的条目");
  assert.equal(h.state.undo.length, 1);
  assert.equal(h.state.redo.length, 2);

  assert.equal(h.redo(), b, "redo 恢复最近被撤销的条目");
  assert.equal(h.state.undo.length, 2);
  assert.equal(h.state.redo.length, 1);
  assert.equal(h.state.undo.includes(b), true);

  assert.equal(h.undo(), b, "redo 之后必须能再次撤销它");
  assert.equal(h.undo(), a);
  assert.equal(h.undo(), undefined);
  assert.equal(h.canUndo, false);

  assert.equal(h.redo(), a, "重做按时间顺序回放");
  assert.equal(h.redo(), b);
  assert.equal(h.redo(), c);
  assert.equal(h.redo(), undefined);
  assert.equal(h.state.undo.length, 3);
  assert.equal(h.canRedo, false);
});

test("undo 之后产生新记录会清空重做栈", () => {
  const h = new History();
  h.record(entry("i1", 0, 1));
  h.record(entry("i2", 1, 2));
  h.undo();
  assert.equal(h.canRedo, true);
  assert.equal(h.state.redo.length, 1);

  h.record(entry("i3", 2, 3));
  assert.equal(h.canRedo, false);
  assert.equal(h.state.redo.length, 0);
  assert.equal(h.state.undo.length, 2);
});

test("clearRedo 显式丢弃重做栈", () => {
  const h = new History();
  h.record(entry("i1", 0, 1));
  h.undo();
  assert.equal(h.canRedo, true);
  h.clearRedo();
  assert.equal(h.canRedo, false);
  assert.equal(h.state.redo.length, 0);
});

test("撤销之后的新编辑不会并入被撤销的意图", () => {
  const h = new History();
  h.record(entry("drag", 0, 1));
  h.record(entry("other", 1, 2));
  h.undo();
  h.record(entry("drag", 1, 5));
  assert.equal(h.state.undo.length, 2, "被撤销的意图与新编辑是两个撤销单位");
  const top = h.undo();
  assert.equal(top!.patch.before, 1);
});

test("审计日志只追加不删除，撤销本身由调用方写进审计", () => {
  const h = new History();
  h.record(entry("i1", 0, 1));
  h.record(entry("i2", 1, 2));

  let log: AuditEntry[] = [];
  const first = audit("a1");
  log = appendAudit(log, first);
  assert.equal(log.length, 1);
  assert.equal(log[0], first);

  const undone = h.undo();
  assert.equal(undone!.intentId, "i2");
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

  assert.equal(
    log.length,
    3,
    "审计条目数与撤销栈长度是两回事",
  );
  assert.equal(h.state.undo.length, 1);
  assert.equal(h.state.redo.length, 1);
});

test("isExternalEffect 区分外部效果与白板内操作", () => {
  for (const kind of [
    "publish",
    "run-experiment",
    "send",
    "commit-external",
  ]) {
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
  assert.equal(h.state.undo.length, 0);
  assert.equal(h.state.redo.length, 0);
});

test("可以从持久化状态恢复，state 返回副本", () => {
  const a = entry("i1", 0, 1);
  const b = entry("i2", 1, 2);
  const c = entry("i3", 2, 3);
  const h = new History({ undo: [a, b], redo: [c] });
  assert.equal(h.canUndo, true);
  assert.equal(h.canRedo, true);
  assert.equal(h.state.undo.length, 2);
  assert.equal(h.state.redo.length, 1);
  assert.equal(h.undo(), b);

  const snapshot = h.state;
  snapshot.undo.push(entry("i4", 2, 9));
  snapshot.redo.length = 0;
  assert.equal(h.state.undo.length, 1, "state 必须是副本，外部改动不得影响内部状态");
  assert.equal(h.state.redo.length, 2);
});

test("记录格式错误的历史条目时立刻报错", () => {
  const h = new History();
  assert.throws(() => h.record(undefined as unknown as HistoryEntry));
  assert.throws(
    () => h.record({ intentId: "" } as unknown as HistoryEntry),
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
  assert.equal(h.state.undo.length, 0);
});
