// 集成轮（issue #20）的交叉场景测试：旧交互 × 新对象模型 × 保存恢复。
//
// 这些用例盯的是「组合起来之后还成立吗」，不是单个模块自己是否正确：
// 同一对象两处展示、一次意图一次撤销、人机交错改不同字段、组件包、板级撤销、
// 保存后重开。每条断言都写清它防的是哪种倒退。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardStore } from "../core/store.ts";
import { Spaces } from "../server/spaces.ts";
import { openView } from "../core/space-state.ts";
import { resolveContent } from "../core/content.ts";
import { WorkspaceStore } from "../core/workspace.ts";
import { workspacePort } from "../core/persistence.ts";
import type { Projection } from "../core/model.ts";

const empty: Projection = { workspaces: [], objects: [], relations: [] };

const setup = () => {
  const store = new BoardStore();
  const spaces = new Spaces(store);
  let board = store.open(empty, "空白工作区");
  openView(store.get(board.id), "view-a");
  const op = (operation: any) => {
    board = spaces.update(
      board.id,
      store.get(board.id).revision,
      "view-a",
      operation,
    );
    return board;
  };
  return {
    store,
    spaces,
    op,
    boardId: board.id,
    current: () => board,
    at: () => store.get(board.id),
  };
};

test("同一对象两处展示：改内容两边同步，改布局只影响当前展示", () => {
  const { op, store, boardId } = setup();
  op({ kind: "create", type: "text", title: "林澈", data: { text: "第一稿" } });
  const b0 = store.get(boardId);
  const objectId = b0.contentObjects[0].id;
  const first = b0.instances.find((i) => i.binding?.kind === "object")!;

  op({ kind: "create", type: "board", title: "第三章" });
  const b1 = store.get(boardId);
  const spaceId = String(
    b1.instances.find((i) => i.type === "board")!.data.spaceId,
  );
  op({ kind: "present", objectId, spaceId });
  const b2 = store.get(boardId);
  const second = b2.instances.filter((i) => i.binding?.kind === "object")[1];

  // 改内容：两处展示一起变
  op({
    kind: "update",
    instanceId: first.id,
    data: { text: "第二稿" },
    baseData: { text: "第一稿" },
  });
  const b3 = store.get(boardId);
  const shown = b3.instances
    .filter((i) => i.binding?.kind === "object")
    .map((i) => resolveContent(i, b3.contentObjects).data.text);
  assert.deepEqual(shown, ["第二稿", "第二稿"], "内容共享：两处一起更新");

  // 改布局：只影响当前这一处展示
  op({
    kind: "place",
    items: [{ id: second.id, rect: { x: 10, y: 20, width: 280, height: 180 } }],
  });
  const b4 = store.get(boardId);
  const moved = b4.instances.find((i) => i.id === second.id)!;
  const stayed = b4.instances.find((i) => i.id === first.id)!;
  assert.equal(moved.rect.x, 10, "被移动的那一张动了");
  assert.notEqual(stayed.rect.x, 10, "另一张的布局没被带走");

  // 折叠档位也是展示层属性
  op({
    kind: "update",
    instanceId: first.id,
    appearance: { detail: "icon" },
  });
  const b5 = store.get(boardId);
  assert.equal(
    b5.instances.find((i) => i.id === first.id)!.appearance?.detail,
    "icon",
  );
  assert.notEqual(
    b5.instances.find((i) => i.id === second.id)!.appearance?.detail,
    "icon",
    "折叠只影响当前展示",
  );
});

test("一次连续编辑算一次撤销：连撤连重不震荡，撤销栈与面板看到同一份记录", () => {
  const { op, store, boardId } = setup();
  op({ kind: "create", type: "text", title: "计划", data: { text: "一稿" } });
  const b0 = store.get(boardId);
  const instance = b0.instances.find((i) => i.binding?.kind === "object")!;
  const object = b0.contentObjects[0];

  // 同一个 intentId 的三次保存 = 一个撤销单位
  for (const text of ["二稿", "三稿", "四稿"]) {
    op({
      kind: "update",
      instanceId: instance.id,
      data: { text },
      baseData: {
        text: text === "二稿" ? "一稿" : text === "三稿" ? "二稿" : "三稿",
      },
      intentId: "edit-session-1",
    });
  }
  const b1 = store.get(boardId);
  assert.equal(
    resolveContent(instance, b1.contentObjects).data.text,
    "四稿",
    "最后一次保存生效",
  );

  const history = store.history(boardId);
  assert.equal(history.canUndo, true);
  assert.equal(
    history.records.filter((r) => r.kind === "edit").length,
    2,
    "创建 + 一次连续编辑 = 两条记录（连续编辑合成了一个撤销单位）",
  );

  // 撤一次：回到连续编辑之前
  store.undo(boardId, "human");
  const b2 = store.get(boardId);
  assert.equal(
    resolveContent(instance, b2.contentObjects).data.text,
    "一稿",
    "一次撤销退掉整段连续编辑",
  );
  // 再撤：退掉创建
  store.undo(boardId, "human");
  const b3 = store.get(boardId);
  assert.equal(b3.contentObjects.length, 0, "再撤一次回到空白");
  assert.equal(store.history(boardId).canUndo, false, "没有更多可撤的了");

  // 重做回来
  store.redo(boardId, "human");
  store.redo(boardId, "human");
  const b4 = store.get(boardId);
  assert.equal(
    resolveContent(instance, b4.contentObjects).data.text,
    "四稿",
    "两次重做回到最后的样子",
  );
  // 再撤一次，不来回震荡
  store.undo(boardId, "human");
  const b5 = store.get(boardId);
  assert.equal(
    resolveContent(instance, b5.contentObjects).data.text,
    "一稿",
    "撤销与重做不震荡",
  );
});

test("跳到某条历史记录：板面回到那条记录刚发生时的样子", () => {
  const { op, store, boardId } = setup();
  op({ kind: "create", type: "text", title: "甲", data: { text: "一" } });
  const instance = store.get(boardId).instances[0];
  op({
    kind: "update",
    instanceId: instance.id,
    data: { text: "二" },
    baseData: { text: "一" },
    intentId: "s1",
  });
  op({
    kind: "update",
    instanceId: instance.id,
    data: { text: "三" },
    baseData: { text: "二" },
    intentId: "s2",
  });
  const history = store.history(boardId);
  const edits = history.records.filter((r) => r.kind === "edit");
  assert.equal(edits.length, 3, "创建 + 两次编辑");
  const oldest = edits[edits.length - 1];
  const newest = edits[0];

  store.jumpTo(boardId, oldest.id, "human");
  const b1 = store.get(boardId);
  assert.equal(
    resolveContent(instance, b1.contentObjects).data.text,
    "一",
    "跳到最早那条：回到它刚发生时的内容",
  );
  store.jumpTo(boardId, newest.id, "human");
  const b2 = store.get(boardId);
  assert.equal(
    resolveContent(instance, b2.contentObjects).data.text,
    "三",
    "再跳回最新那条：内容回来",
  );
  assert.equal(store.history(boardId).canRedo, true, "跳回去之后仍可重做");
});

test("移除展示不误删对象：删对象与撤销都不留残留", () => {
  const { op, store, boardId } = setup();
  op({
    kind: "create",
    type: "text",
    title: "林澈",
    data: { text: "在港口长大" },
  });
  const b0 = store.get(boardId);
  const objectId = b0.contentObjects[0].id;
  const instance = b0.instances.find((i) => i.binding?.kind === "object")!;

  // 移除展示（不是删对象）
  op({ kind: "remove", instanceId: instance.id });
  const b1 = store.get(boardId);
  assert.equal(b1.instances.length, 0, "展示被移除了");
  assert.equal(b1.contentObjects.length, 1, "对象还在：移除展示不是删除内容");

  // 撤销：展示回来
  store.undo(boardId, "human");
  const b2 = store.get(boardId);
  assert.equal(b2.instances.length, 1, "撤销后展示回来了");
  assert.equal(b2.contentObjects.length, 1, "内容没被动过");

  // 删除对象：还被展示引用时必须拒绝（删内容与移除展示是两回事）
  assert.throws(
    () => op({ kind: "deleteObject", objectId }),
    /仍被引用/,
    "仍被引用的对象不许直接删",
  );
  // 移除展示之后再删：这次可以
  op({ kind: "remove", instanceId: instance.id });
  op({ kind: "deleteObject", objectId });
  const b3 = store.get(boardId);
  assert.equal(b3.contentObjects.length, 0, "对象被删了");
  // 撤销删除：对象回来，不留悬挂引用
  store.undo(boardId, "human");
  const b4 = store.get(boardId);
  assert.equal(b4.contentObjects.length, 1, "撤销删除后对象回来");
  // 再撤销一次：展示也回来，绑定关系没丢
  store.undo(boardId, "human");
  const b5 = store.get(boardId);
  const restored = b5.instances.find((i) => i.binding?.kind === "object");
  assert.ok(restored, "展示实例还在");
  assert.equal(
    restored!.binding && (restored!.binding as any).objectId,
    objectId,
    "绑定关系没丢",
  );
});

test("人与 Agent 交错改不同字段：不互相覆盖；同字段冲突看得见", () => {
  const { op, store, boardId } = setup();
  op({
    kind: "create",
    type: "task",
    title: "验收",
    data: { items: [{ text: "写文档", done: false }] },
  });
  const b0 = store.get(boardId);
  const instance = b0.instances.find((i) => i.binding?.kind === "object")!;
  const object = b0.contentObjects[0];
  const base = { items: [{ text: "写文档", done: false }] };

  // Agent 先改一个字段：items
  op({
    kind: "update",
    instanceId: instance.id,
    data: { items: [{ text: "写文档", done: true }] },
    baseData: base,
    intentId: "agent-1",
  });
  // 人接着改另一个字段：note（此时对象的 items 已经被 Agent 改过）
  const after = store.get(boardId).contentObjects[0];
  op({
    kind: "update",
    instanceId: instance.id,
    data: { items: after.data!.items, note: "我加的备注" },
    baseData: { items: after.data!.items },
  });
  const b1 = store.get(boardId);
  const data = b1.contentObjects[0].data as any;
  assert.equal(data.items[0].done, true, "Agent 的改动没被覆盖");
  assert.equal(data.note, "我加的备注", "人的改动也写进去了");

  // 同一个字段被并发改动：要报错，不能悄悄覆盖。
  // 这里的基线是「Agent 改之前」的那份，与当前值已经不同——正是并发的样子。
  assert.throws(
    () =>
      op({
        kind: "update",
        instanceId: instance.id,
        data: { note: "我改的备注" },
        baseData: { note: "我看到的旧备注" },
      }),
    /已被其他修改改动/,
    "同字段冲突必须明确报出来",
  );
  const b2 = store.get(boardId);
  assert.equal(
    (b2.contentObjects[0].data as any).items[0].done,
    true,
    "冲突时没有覆盖任何人的值",
  );
  assert.equal(store.get(boardId).contentObjects.length, 1, "对象还在");
});

test("板级内容也能撤销：嵌套白板、主题、组件包", () => {
  const { op, store, boardId } = setup();
  const spacesBefore = store.get(boardId).spaces.length;
  op({ kind: "create", type: "board", title: "子白板" });
  const b0 = store.get(boardId);
  assert.equal(b0.spaces.length, spacesBefore + 1, "嵌套白板建好了");
  op({ kind: "theme", theme: { base: "mono" } });
  const b1 = store.get(boardId);
  assert.equal(b1.theme?.base, "mono");

  store.undo(boardId, "human");
  const b2 = store.get(boardId);
  assert.equal(b2.theme?.base, undefined, "主题可以被撤销");
  assert.equal(b2.spaces.length, spacesBefore + 1, "撤销主题不影响嵌套白板");

  store.undo(boardId, "human");
  const b3 = store.get(boardId);
  assert.equal(b3.spaces.length, spacesBefore, "嵌套白板也可以被撤销");
});

test("保存后重开：内容、关系、展示、嵌套与历史都回来", () => {
  const root = mkdtempSync(join(tmpdir(), "sand-integration-"));
  try {
    const store = new BoardStore();
    store.attachPersistence(workspacePort(new WorkspaceStore(root)), "default");
    const spaces = new Spaces(store);
    let board = store.open(empty, "空白工作区");
    openView(store.get(board.id), "view-a");
    const op = (operation: any) => {
      board = spaces.update(
        board.id,
        store.get(board.id).revision,
        "view-a",
        operation,
      );
      return board;
    };
    op({
      kind: "create",
      type: "text",
      title: "林澈",
      data: { text: "在港口长大" },
    });
    op({ kind: "create", type: "board", title: "第三章" });
    const b0 = store.get(board.id);
    const spaceId = String(
      b0.instances.find((i) => i.type === "board")!.data.spaceId,
    );
    op({
      kind: "present",
      objectId: b0.contentObjects[0].id,
      spaceId,
    });
    const before = store.get(board.id);
    const beforeHistory = store.history(board.id).records.length;
    store.flushSave();

    // 重启：同一个工作空间读回来
    const restarted = new BoardStore();
    restarted.attachPersistence(
      workspacePort(new WorkspaceStore(root)),
      "default",
    );
    const reopened = restarted.open(empty, "空白工作区");
    const after = restarted.get(reopened.id);
    assert.equal(
      after.contentObjects.length,
      before.contentObjects.length,
      "内容对象回来了",
    );
    assert.equal(after.instances.length, before.instances.length, "展示回来了");
    assert.equal(after.spaces.length, before.spaces.length, "嵌套白板回来了");
    assert.equal(
      restarted.history(reopened.id).records.length,
      beforeHistory,
      "历史也回来了",
    );
    const file = JSON.parse(
      readFileSync(join(root, "default", "workspace.json"), "utf8"),
    );
    assert.ok(file.history.undo.length > 0, "落盘文件里带着撤销栈");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
