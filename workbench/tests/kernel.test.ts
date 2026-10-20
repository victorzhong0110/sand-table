// 通用工作空间内核的集成测试：内容共享、布局独立、撤销分组、持久化往返。
// 契约见 docs/architecture/workspace-kernel.zh-CN.md 第 4 节的 I1–I15。
// 这些用例不依赖 Git 仓库，也不依赖 AI：原生内容本身就是一等数据。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
  return { store, spaces, op, boardId: board.id, current: () => board };
};

test("原生内容是一等数据：没有仓库也能创建、搜索、读回", () => {
  const { store, op, boardId } = setup();
  op({
    kind: "create",
    type: "text",
    title: "人物：林澈",
    data: { text: "在港口长大，怕水。" },
  });
  const b = store.get(boardId);
  assert.equal(b.contentObjects.length, 1, "内容进入对象，不是留在卡片里");
  const object = b.contentObjects[0];
  assert.equal(object.kind, "native");
  assert.equal(object.title, "人物：林澈");
  assert.equal(object.version, 1);
  assert.equal(object.source?.origin, "human");
  // 卡片只保留呈现，内容来自对象
  const instance = b.instances.find((i) => i.binding?.kind === "object");
  assert.ok(instance, "组件绑定到内容对象");
  assert.deepEqual(instance!.data, {}, "实例不再自带内容副本");
  const resolved = resolveContent(instance!, b.contentObjects);
  assert.equal(resolved.title, "人物：林澈");
  assert.equal(resolved.data.text, "在港口长大，怕水。");

  // 统一读回：原生内容能被搜索到
  const listed = store.listObjects(boardId, { text: "港口" });
  assert.equal(listed.objects.length, 1);
  assert.equal(listed.objects[0].kind, "native");
  assert.equal(listed.counts.native, 1);
});

test("同一对象在两块白板各有一份展示：内容共享，布局独立", () => {
  const { store, op, boardId } = setup();
  op({ kind: "create", type: "text", title: "林澈", data: { text: "第一稿" } });
  const b0 = store.get(boardId);
  const objectId = b0.contentObjects[0].id;

  // 新建第二块白板，并在上面再放一份展示
  op({ kind: "create", type: "board", title: "第三章" });
  const b1 = store.get(boardId);
  const spaceId = b1.spaces.at(-1)!.id;
  op({ kind: "present", objectId, spaceId: spaceId } as any);
  const b2 = store.get(boardId);
  const presentations = b2.instances.filter(
    (i) => i.binding?.kind === "object" && i.binding.objectId === objectId,
  );
  assert.equal(presentations.length, 2, "同一个对象有两处展示");
  assert.equal(
    new Set(presentations.map((i) => i.spaceId)).size,
    2,
    "两处展示在不同白板上",
  );

  // 改内容 → 两处都变
  const object = b2.contentObjects.find((o) => o.id === objectId)!;
  op({
    kind: "update",
    instanceId: presentations[0].id,
    data: { text: "第二稿" },
    expectedVersion: object.version,
  });
  const b3 = store.get(boardId);
  for (const p of b3.instances.filter(
    (i) => i.binding?.kind === "object" && i.binding.objectId === objectId,
  ))
    assert.equal(
      resolveContent(p, b3.contentObjects).data.text,
      "第二稿",
      "内容共享：两处展示一起更新",
    );

  // 移动其中一处 → 另一处不动
  const before = b3.instances
    .filter((i) => i.binding?.objectId === objectId)
    .map((i) => i.rect.x);
  op({
    kind: "place",
    items: [
      {
        id: presentations[0].id,
        rect: { ...presentations[0].rect, x: 777 },
      },
    ],
  });
  const b4 = store.get(boardId);
  const after = b4.instances
    .filter((i) => i.binding?.objectId === objectId)
    .map((i) => i.rect.x);
  assert.ok(after.includes(777), "被移动的展示确实移动了");
  assert.ok(after.includes(before[1] ?? before[0]), "另一处布局不受影响");
});

test("「再放一份展示」与「复制出独立对象」是两件事", () => {
  const { store, op, boardId } = setup();
  op({ kind: "create", type: "text", title: "林澈", data: { text: "原文" } });
  const b0 = store.get(boardId);
  const objectId = b0.contentObjects[0].id;
  const instance = b0.instances.find((i) => i.binding?.objectId === objectId)!;

  op({ kind: "copyObject", instanceId: instance.id });
  const b1 = store.get(boardId);
  assert.equal(b1.contentObjects.length, 2, "复制出独立对象");
  const clone = b1.contentObjects.find((o) => o.id !== objectId)!;
  assert.equal(clone.version, 1, "副本是新的对象，版本从头开始");

  // 改副本不影响原对象
  op({
    kind: "update",
    instanceId: b1.instances.find((i) => i.binding?.objectId === clone.id)!.id,
    data: { text: "改过的副本" },
    expectedVersion: clone.version,
  });
  const b2 = store.get(boardId);
  assert.equal(
    b2.contentObjects.find((o) => o.id === objectId)!.data!.text,
    "原文",
    "副本与原对象互不影响",
  );
});

test("移除展示不等于删除对象；删除被引用的对象必须显式策略", () => {
  const { store, op, boardId } = setup();
  op({ kind: "create", type: "text", title: "林澈", data: { text: "原文" } });
  const b0 = store.get(boardId);
  const objectId = b0.contentObjects[0].id;
  const instance = b0.instances.find((i) => i.binding?.objectId === objectId)!;

  op({ kind: "remove", instanceId: instance.id });
  const b1 = store.get(boardId);
  assert.equal(
    b1.contentObjects.filter((o) => o.id === objectId).length,
    1,
    "移除展示不删除对象",
  );

  // 仍然被引用时默认拒绝删除
  op({ kind: "present", objectId });
  assert.throws(
    () => op({ kind: "deleteObject", objectId, onReferenced: "refuse" }),
    /引用/,
    "被引用的对象不能静默删除",
  );
  op({ kind: "deleteObject", objectId, onReferenced: "detach" });
  const b2 = store.get(boardId);
  assert.equal(b2.contentObjects.filter((o) => o.id === objectId).length, 0);
  assert.equal(
    b2.instances.filter((i) => i.binding?.objectId === objectId).length,
    0,
    "detach 明确移除了引用",
  );
});

test("版本冲突被检出，不静默覆盖", () => {
  const { store, op, boardId } = setup();
  op({ kind: "create", type: "text", title: "林澈", data: { text: "一稿" } });
  const b0 = store.get(boardId);
  const object = b0.contentObjects[0];
  const instance = b0.instances.find((i) => i.binding?.objectId === object.id)!;
  assert.throws(
    () =>
      op({
        kind: "update",
        instanceId: instance.id,
        data: { text: "抢写" },
        expectedVersion: object.version + 5,
      }),
    /版本/,
    "过期版本写入被拒绝",
  );
  assert.equal(
    store.get(boardId).contentObjects[0].data!.text,
    "一稿",
    "被拒绝的写入没有生效",
  );
});

test("撤销按用户意图分组；连续撤销与重做不震荡", () => {
  const { store, op, boardId } = setup();
  op({ kind: "create", type: "text", title: "林澈", data: { text: "一稿" } });
  const b0 = store.get(boardId);
  const objectId = b0.contentObjects[0].id;
  const instance = b0.instances.find((i) => i.binding?.objectId === objectId)!;

  // 同一意图的连续编辑算一个撤销单位
  op({
    kind: "update",
    instanceId: instance.id,
    data: { text: "二稿" },
    expectedVersion: 1,
    intentId: "intent-1",
  });
  op({
    kind: "update",
    instanceId: instance.id,
    data: { text: "三稿" },
    expectedVersion: 2,
    intentId: "intent-1",
  });
  assert.equal(store.get(boardId).contentObjects[0].data!.text, "三稿");

  op({ kind: "undo" });
  assert.equal(
    store.get(boardId).contentObjects[0].data!.text,
    "一稿",
    "一次撤销回到该意图的最开始",
  );
  op({ kind: "redo" });
  assert.equal(store.get(boardId).contentObjects[0].data!.text, "三稿");
  op({ kind: "undo" });
  assert.equal(
    store.get(boardId).contentObjects[0].data!.text,
    "一稿",
    "重做之后还能再次撤销，不会震荡",
  );
});

test("审计日志与撤销栈是两个概念", () => {
  const { store, op, boardId } = setup();
  op({ kind: "create", type: "text", title: "林澈", data: { text: "一稿" } });
  const before = store.get(boardId);
  const auditBefore = before.audit.length;
  const undoDepth = before.history.undo.length;
  assert.ok(undoDepth > 0, "新建内容进入撤销栈");
  assert.ok(auditBefore > 0, "新建内容也进审计");

  op({ kind: "undo" });
  const after = store.get(boardId);
  assert.equal(after.history.undo.length, undoDepth - 1, "撤销栈少了一项");
  assert.ok(
    after.audit.length > auditBefore,
    "撤销本身也进审计日志（只追加）",
  );
  assert.ok(
    after.audit.some((a) => a.via === "undo"),
    "审计记录标注了这是撤销触发的",
  );
  assert.equal(
    after.history.redo.length,
    1,
    "被撤销的条目在重做栈里，不在撤销栈里",
  );
});

test("语义关系与展示关系分离", () => {
  const { store, op, boardId } = setup();
  op({ kind: "create", type: "text", title: "林澈", data: { text: "一稿" } });
  op({ kind: "create", type: "text", title: "港口", data: { text: "场景" } });
  const b0 = store.get(boardId);
  const [a, c] = b0.contentObjects;
  const layoutBefore = b0.instances.map((i) => i.rect);

  op({ kind: "relate", source: a.id, target: c.id, relation: "先于" });
  const b1 = store.get(boardId);
  assert.equal(b1.objectRelations.length, 1);
  assert.equal(b1.objectRelations[0].status, "confirmed");
  assert.equal(b1.objectRelations[0].kind, "先于");
  assert.deepEqual(
    b1.instances.map((i) => i.rect),
    layoutBefore,
    "建关系不改布局",
  );

  // 推测性关系必须显式标注
  op({
    kind: "relate",
    source: c.id,
    target: a.id,
    relation: "可能导致",
    status: "inferred",
  });
  const b2 = store.get(boardId);
  assert.equal(b2.objectRelations[1].status, "inferred");
});

test("工作空间落盘后重开仍在：重启不该清空作品", () => {
  const root = mkdtempSync(join(tmpdir(), "sand-kernel-"));
  try {
    const workspaces = new WorkspaceStore(root);
    const port = workspacePort(workspaces);
    const store = new BoardStore();
    store.attachPersistence(port, "default");
    const spaces = new Spaces(store);
    let board = store.open(empty, "空白工作区");
    openView(store.get(board.id), "view-a");
    spaces.update(board.id, store.get(board.id).revision, "view-a", {
      kind: "create",
      type: "text",
      title: "林澈",
      data: { text: "在港口长大" },
    });
    store.flushSave();
    assert.ok(!store.lastSaveError, "保存没有失败");

    // 换一个新的 store 实例，模拟重启
    const restarted = new BoardStore();
    restarted.attachPersistence(workspacePort(new WorkspaceStore(root)), "default");
    const reopened = restarted.open(empty, "空白工作区");
    const restored = restarted.get(reopened.id);
    assert.equal(restored.contentObjects.length, 1, "重启后内容还在");
    assert.equal(restored.contentObjects[0].title, "林澈");
    assert.equal(
      restored.contentObjects[0].data!.text,
      "在港口长大",
    );
    assert.equal(
      restored.instances.filter((i) => i.binding?.kind === "object").length,
      1,
      "展示实例也恢复了",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("保存失败必须可观察，不能显示虚假的「已保存」", () => {
  const store = new BoardStore();
  store.attachPersistence(
    {
      save() {
        throw Error("disk is full");
      },
      load() {
        return undefined;
      },
    },
    "default",
  );
  const board = store.open(empty, "空白工作区");
  store.createContent(
    store.get(board.id),
    { type: "text", title: "林澈" },
    "human",
  );
  store.flushSave();
  assert.equal(store.lastSaveError, "disk is full");
  assert.ok(!store.lastSaveError === false, "失败原因被保留");
});
