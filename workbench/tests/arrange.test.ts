import assert from "node:assert/strict";
import { test } from "node:test";
import { toCommands } from "../board/data-client/adapter.ts";
import type {
  V3ObjectRow,
  V3PresentationRow,
} from "../board/data-client/store.ts";
import {
  align,
  alignSelection,
  boardOrigin,
  componentMenu,
  detachChildren,
  distribute,
  frameCommandCount,
  framePlan,
  paneMenu,
  restack,
  topLevelIds,
  unframeCommandCount,
  unframePlan,
  withinCommandLimit,
  type ArrangeItem,
  type ArrangeRect,
} from "../board/canvas/arrange.ts";

const rects: ArrangeRect[] = [
  { id: "a", x: 0, y: 0, width: 100, height: 40 },
  { id: "b", x: 30, y: 10, width: 40, height: 80 },
  { id: "c", x: 10, y: 50, width: 60, height: 20 },
];

function at(items: { id: string; x: number; y: number }[], id: string) {
  const found = items.find((item) => item.id === id);
  assert.ok(found);
  return found;
}

test("六种对齐都以选区外框为基准", () => {
  const left = align(rects, "left");
  assert.equal(at(left, "a").x, 0);
  assert.equal(at(left, "b").x, 0);
  assert.equal(at(left, "c").x, 0);
  assert.equal(at(left, "b").y, 10);

  const right = align(rects, "right");
  assert.equal(at(right, "a").x, 0);
  assert.equal(at(right, "b").x, 60);
  assert.equal(at(right, "c").x, 40);

  const centerX = align(rects, "center-x");
  assert.equal(at(centerX, "a").x, 0);
  assert.equal(at(centerX, "b").x, 30);
  assert.equal(at(centerX, "c").x, 20);

  const top = align(rects, "top");
  assert.equal(at(top, "a").y, 0);
  assert.equal(at(top, "b").y, 0);
  assert.equal(at(top, "c").y, 0);
  assert.equal(at(top, "c").x, 10);

  const bottom = align(rects, "bottom");
  assert.equal(at(bottom, "a").y, 50);
  assert.equal(at(bottom, "b").y, 10);
  assert.equal(at(bottom, "c").y, 70);

  const centerY = align(rects, "center-y");
  assert.equal(at(centerY, "a").y, 25);
  assert.equal(at(centerY, "b").y, 5);
  assert.equal(at(centerY, "c").y, 35);
});

test("分布至少 3 个，首尾不动，中间等间距", () => {
  assert.equal(
    distribute(
      [
        { id: "a", x: 0, y: 0, width: 10, height: 10 },
        { id: "b", x: 40, y: 0, width: 10, height: 10 },
      ],
      "x",
    ),
    null,
  );
  assert.equal(
    distribute(
      [
        { id: "a", x: 0, y: 0, width: 10, height: 10 },
        { id: "b", x: 0, y: 40, width: 10, height: 10 },
      ],
      "y",
    ),
    null,
  );
  const horizontal = distribute(
    [
      { id: "a", x: 0, y: 0, width: 10, height: 10 },
      { id: "b", x: 20, y: 5, width: 10, height: 10 },
      { id: "c", x: 100, y: 8, width: 10, height: 10 },
    ],
    "x",
  );
  assert.ok(horizontal);
  assert.equal(at(horizontal, "a").x, 0);
  assert.equal(at(horizontal, "b").x, 50);
  assert.equal(at(horizontal, "b").y, 5);
  assert.equal(at(horizontal, "c").x, 100);

  const vertical = distribute(
    [
      { id: "a", x: 1, y: 0, width: 10, height: 10 },
      { id: "b", x: 2, y: 20, width: 10, height: 10 },
      { id: "c", x: 3, y: 100, width: 10, height: 10 },
    ],
    "y",
  );
  assert.ok(vertical);
  assert.equal(at(vertical, "a").y, 0);
  assert.equal(at(vertical, "b").y, 50);
  assert.equal(at(vertical, "c").y, 100);
});

test("锁定的展示不被对齐挪走", () => {
  const items: ArrangeItem[] = rects.map((item) => ({
    ...item,
    parentId: null,
    z: 0,
    locked: item.id === "a",
  }));
  const moved = alignSelection(items, ["a", "b", "c"], "left");
  assert.equal(
    moved.find((item) => item.id === "a"),
    undefined,
  );
  assert.equal(at(moved, "b").x, 0);
  assert.equal(at(moved, "c").x, 0);
});

test("选区里同时有祖先和子项时只变换最高层", () => {
  const items: ArrangeItem[] = [
    {
      id: "p",
      parentId: null,
      x: 0,
      y: 0,
      width: 100,
      height: 80,
      z: 0,
    },
    {
      id: "c",
      parentId: "p",
      x: 10,
      y: 10,
      width: 20,
      height: 20,
      z: 0,
    },
    {
      id: "s",
      parentId: null,
      x: 200,
      y: 0,
      width: 20,
      height: 20,
      z: 0,
    },
  ];
  assert.deepEqual(
    topLevelIds(["p", "c", "s"], (id) => {
      return items.find((item) => item.id === id)?.parentId ?? null;
    }),
    ["p", "s"],
  );
  const moved = alignSelection(items, ["p", "c", "s"], "left");
  assert.deepEqual(moved, [{ id: "s", x: 0, y: 0 }]);
});

test("跨父框先换成白板坐标，对齐后再换回相对坐标", () => {
  const items: ArrangeItem[] = [
    {
      id: "outer",
      parentId: null,
      x: 100,
      y: 50,
      width: 200,
      height: 200,
      z: 0,
    },
    {
      id: "child",
      parentId: "outer",
      x: 10,
      y: 10,
      width: 20,
      height: 20,
      z: 0,
    },
    {
      id: "root",
      parentId: null,
      x: 0,
      y: 0,
      width: 20,
      height: 20,
      z: 0,
    },
  ];
  const byId = new Map(items.map((item) => [item.id, item]));
  assert.deepEqual(boardOrigin("child", byId), { x: 110, y: 60 });
  const moved = alignSelection(items, ["child", "root"], "left");
  assert.deepEqual(moved, [{ id: "child", x: -100, y: 10 }]);
});

test("成框再解除，框内坐标换算后屏幕位置不变", () => {
  const before: ArrangeItem[] = [
    {
      id: "outer",
      parentId: null,
      x: 100,
      y: 50,
      width: 200,
      height: 200,
      z: 0,
    },
    {
      id: "child",
      parentId: "outer",
      x: 10,
      y: 20,
      width: 30,
      height: 40,
      z: 1,
    },
  ];
  const byBefore = new Map(before.map((item) => [item.id, item]));
  const screenBefore = boardOrigin("child", byBefore);
  const plan = framePlan(before, ["child"]);
  assert.ok(plan);
  assert.equal(plan.frame.x, screenBefore.x - 24);
  assert.equal(plan.frame.y, screenBefore.y - 24);
  assert.equal(plan.frame.width, 30 + 48);
  assert.equal(plan.frame.height, 40 + 48);
  const child = plan.children[0];
  assert.ok(child);
  assert.equal(plan.frame.x + child.x, screenBefore.x);
  assert.equal(plan.frame.y + child.y, screenBefore.y);

  const framed: ArrangeItem[] = [
    ...before,
    {
      id: "frame",
      parentId: null,
      x: plan.frame.x,
      y: plan.frame.y,
      width: plan.frame.width,
      height: plan.frame.height,
      z: 0,
    },
    {
      ...before[1]!,
      parentId: "frame",
      x: child.x,
      y: child.y,
    },
  ];
  const undone = unframePlan(framed, "frame");
  assert.ok(undone);
  const restored = undone.children[0];
  assert.ok(restored);
  assert.equal(restored.parentId, null);
  assert.equal(restored.x, screenBefore.x);
  assert.equal(restored.y, screenBefore.y);
  assert.equal(restored.locked, false);
});

test("解除嵌套框时子项回到原来的父框", () => {
  const items: ArrangeItem[] = [
    {
      id: "outer",
      parentId: null,
      x: 100,
      y: 40,
      width: 300,
      height: 300,
      z: 0,
    },
    {
      id: "inner",
      parentId: "outer",
      x: 10,
      y: 20,
      width: 80,
      height: 80,
      z: 0,
    },
    {
      id: "child",
      parentId: "inner",
      x: 5,
      y: 6,
      width: 20,
      height: 20,
      z: 0,
      locked: true,
    },
  ];
  const byId = new Map(items.map((item) => [item.id, item]));
  const screen = boardOrigin("child", byId);
  const plan = unframePlan(items, "inner");
  assert.ok(plan);
  const child = plan.children[0];
  assert.ok(child);
  assert.equal(child.parentId, "outer");
  assert.equal(child.locked, true);
  assert.equal(boardOrigin("outer", byId).x + child.x, screen.x);
  assert.equal(boardOrigin("outer", byId).y + child.y, screen.y);
  assert.equal(unframeCommandCount(plan.children), 4);
});

test("成框跳过锁定展示，层级按整组计算", () => {
  const items: ArrangeItem[] = [
    { id: "a", parentId: null, x: 0, y: 0, width: 10, height: 10, z: 0 },
    {
      id: "b",
      parentId: null,
      x: 30,
      y: 0,
      width: 10,
      height: 10,
      z: 1,
      locked: true,
    },
  ];
  const plan = framePlan(items, ["a", "b"]);
  assert.ok(plan);
  assert.deepEqual(
    plan.children.map((item) => item.id),
    ["a"],
  );
  assert.equal(plan.frame.x, -24);
  assert.equal(frameCommandCount(plan.children.length), 3);
  assert.equal(framePlan(items, ["b"]), null);

  const stack = [
    { id: "a", z: 0 },
    { id: "b", z: 1 },
    { id: "c", z: 2 },
  ];
  assert.deepEqual(restack(stack, ["b"], "front"), [{ id: "b", z: 3 }]);
  assert.deepEqual(restack(stack, ["c"], "back"), [{ id: "c", z: -1 }]);
  assert.deepEqual(restack(stack, ["b", "c"], "back"), [
    { id: "b", z: -2 },
    { id: "c", z: -1 },
  ]);
  assert.deepEqual(restack(stack, ["b"], "forward"), [
    { id: "b", z: 2 },
    { id: "c", z: 1 },
  ]);
  assert.deepEqual(restack(stack, ["b"], "backward"), [
    { id: "a", z: 1 },
    { id: "b", z: 0 },
  ]);
  assert.deepEqual(
    restack(
      [
        { id: "a", z: 0 },
        { id: "b", z: 0 },
      ],
      ["a"],
      "forward",
    ),
    [{ id: "a", z: 1 }],
  );
  assert.deepEqual(
    restack(
      [
        { id: "a", z: 0 },
        { id: "b", z: 0 },
        { id: "c", z: 0 },
      ],
      ["a"],
      "forward",
    ),
    [
      { id: "a", z: 1 },
      { id: "c", z: 2 },
    ],
  );
  assert.deepEqual(
    restack(
      [
        { id: "a", z: 0 },
        { id: "b", z: 0 },
        { id: "c", z: 0 },
      ],
      ["c"],
      "backward",
    ),
    [
      { id: "b", z: 2 },
      { id: "c", z: 1 },
    ],
  );
  const tied = [
    { id: "a", z: 0 },
    { id: "b", z: 0 },
    { id: "c", z: 0 },
  ];
  const raised = restack(tied, ["a"], "forward");
  const zOf = new Map(tied.map((item) => [item.id, item.z]));
  for (const item of raised) zOf.set(item.id, item.z);
  const order = [...zOf.entries()].sort(
    (left, right) => left[1] - right[1] || (left[0] < right[0] ? -1 : 1),
  );
  assert.deepEqual(
    order.map(([id]) => id),
    ["b", "a", "c"],
  );
});

test("删掉框时，还留着的孩子先回到不会删的祖先", () => {
  const items: ArrangeItem[] = [
    {
      id: "outer",
      parentId: null,
      x: 100,
      y: 40,
      width: 200,
      height: 200,
      z: 0,
    },
    {
      id: "inner",
      parentId: "outer",
      x: 30,
      y: 8,
      width: 40,
      height: 40,
      z: 0,
    },
    {
      id: "child",
      parentId: "inner",
      x: 4,
      y: 5,
      width: 10,
      height: 10,
      z: 0,
      locked: true,
    },
  ];
  const byId = new Map(items.map((item) => [item.id, item]));
  const screen = boardOrigin("child", byId);
  const moved = detachChildren(items, ["inner"]);
  assert.equal(moved.length, 1);
  const child = moved[0];
  assert.ok(child);
  assert.equal(child.parentId, "outer");
  assert.equal(child.locked, true);
  assert.equal(boardOrigin("outer", byId).x + child.x, screen.x);
  assert.equal(boardOrigin("outer", byId).y + child.y, screen.y);
  const both = detachChildren(items, ["outer", "inner"]);
  assert.deepEqual(both, [
    {
      id: "child",
      parentId: null,
      x: screen.x,
      y: screen.y,
      locked: true,
    },
  ]);
  assert.deepEqual(detachChildren(items, ["inner", "child"]), []);
});

test("超过 200 条命令不算可提交", () => {
  assert.equal(withinCommandLimit(200), true);
  assert.equal(withinCommandLimit(201), false);
  assert.equal(withinCommandLimit(frameCommandCount(198)), true);
  assert.equal(withinCommandLimit(frameCommandCount(199)), false);
});

test("两个展示可以对齐，等间距不可用；锁定时菜单写解锁", () => {
  const two = componentMenu({
    alignCount: 2,
    targetLocked: false,
    targetIsFrame: false,
    canFrame: true,
  });
  assert.equal(
    two.some((item) => item.label === "左对齐"),
    true,
  );
  const gap = two.find((item) => item.label === "水平等间距");
  assert.equal(gap?.disabled, true);
  assert.equal(
    componentMenu({
      alignCount: 1,
      targetLocked: false,
      targetIsFrame: false,
      canFrame: true,
    }).some((item) => item.label === "左对齐"),
    false,
  );
  assert.equal(
    componentMenu({
      alignCount: 1,
      targetLocked: true,
      targetIsFrame: false,
      canFrame: false,
    }).some((item) => item.label === "解锁"),
    true,
  );
  assert.equal(
    componentMenu({
      alignCount: 1,
      targetLocked: false,
      targetIsFrame: true,
      canFrame: true,
    }).some((item) => item.label === "解除框"),
    true,
  );
  assert.deepEqual(
    paneMenu().map((item) => item.label),
    ["粘贴", "粘贴为独立副本", "全选"],
  );
});

function presentation(
  partial: Pick<V3PresentationRow, "id"> & Partial<V3PresentationRow>,
): V3PresentationRow {
  return {
    boardId: "board",
    objectId: partial.objectId ?? partial.id,
    parentId: null,
    x: 0,
    y: 0,
    width: 20,
    height: 20,
    z: 0,
    locked: false,
    appearance: {},
    version: 1,
    updatedAt: 0,
    updatedBy: "",
    rev: 1,
    deleted: false,
    ...partial,
  };
}

function objectRow(id: string, type = "base.note"): V3ObjectRow {
  return {
    id,
    type,
    typeVersion: 1,
    title: id,
    data: {},
    source: null,
    version: 1,
    createdAt: 0,
    createdBy: "",
    updatedAt: 0,
    updatedBy: "",
    rev: 1,
    deleted: false,
  };
}

function ctxOf(
  presentations: V3PresentationRow[],
  objects: V3ObjectRow[] = [],
) {
  return {
    boardId: "board",
    objects: new Map(objects.map((item) => [item.id, item])),
    presentations: new Map(presentations.map((item) => [item.id, item])),
  };
}

test("排列命令跳过锁定展示，超过 200 条整批拒绝", () => {
  const ctx = ctxOf([
    presentation({ id: "free", x: 0, y: 0 }),
    presentation({ id: "locked", x: 0, y: 0, locked: true }),
  ]);
  assert.deepEqual(
    toCommands(
      {
        kind: "arrange",
        items: [
          { id: "free", x: 8, y: 9 },
          { id: "locked", x: 3, y: 4 },
        ],
      },
      ctx,
    ),
    [{ op: "presentation.update", id: "free", x: 8, y: 9 }],
  );
  const many = Array.from({ length: 201 }, (_, index) =>
    presentation({ id: `p${index}`, x: 0, y: 0 }),
  );
  assert.throws(
    () =>
      toCommands(
        {
          kind: "arrange",
          items: many.map((item) => ({ id: item.id, x: 1, y: 0 })),
        },
        ctxOf(many),
      ),
    /200/,
  );
});

test("成框写成相对坐标，解除框能把锁定子项解锁后再锁回去", () => {
  const ctx = ctxOf(
    [
      presentation({ id: "child", x: 10, y: 20 }),
      presentation({ id: "locked", x: 0, y: 0, locked: true }),
      presentation({ id: "frame", objectId: "frame-object", x: 0, y: 0 }),
      presentation({ id: "held", parentId: "frame", x: 4, y: 6, locked: true }),
    ],
    [objectRow("note"), objectRow("frame-object", "base.frame")],
  );
  assert.deepEqual(
    toCommands(
      {
        kind: "frame",
        frame: { x: -24, y: -4, width: 78, height: 88 },
        children: [
          { id: "child", x: 24, y: 24 },
          { id: "locked", x: 1, y: 1 },
        ],
      },
      ctx,
    ),
    [
      {
        op: "object.create",
        ref: "frameObject",
        type: "base.frame",
        title: "框",
        data: {},
      },
      {
        op: "presentation.create",
        ref: "frameView",
        boardId: "board",
        objectId: "@frameObject",
        x: -24,
        y: -4,
        width: 78,
        height: 88,
      },
      {
        op: "presentation.update",
        id: "child",
        parentId: "@frameView",
        x: 24,
        y: 24,
      },
    ],
  );
  assert.deepEqual(
    toCommands(
      {
        kind: "unframe",
        frameId: "frame",
        children: [{ id: "held", parentId: null, x: 12, y: 14, locked: true }],
      },
      ctx,
    ),
    [
      { op: "presentation.update", id: "held", locked: false },
      {
        op: "presentation.update",
        id: "held",
        parentId: null,
        x: 12,
        y: 14,
      },
      { op: "presentation.update", id: "held", locked: true },
      { op: "presentation.delete", id: "frame" },
    ],
  );
  assert.deepEqual(
    toCommands({ kind: "deleteObject", objectId: "note" }, ctx),
    [{ op: "object.delete", id: "note" }],
  );
  assert.deepEqual(
    toCommands({ kind: "remove", instanceIds: ["frame"] }, ctx),
    [
      { op: "presentation.update", id: "held", locked: false },
      {
        op: "presentation.update",
        id: "held",
        parentId: null,
        x: 4,
        y: 6,
      },
      { op: "presentation.update", id: "held", locked: true },
      { op: "presentation.delete", id: "frame" },
    ],
  );
  assert.deepEqual(
    toCommands({ kind: "deleteObject", objectId: "frame-object" }, ctx),
    [
      { op: "presentation.update", id: "held", locked: false },
      {
        op: "presentation.update",
        id: "held",
        parentId: null,
        x: 4,
        y: 6,
      },
      { op: "presentation.update", id: "held", locked: true },
      { op: "object.delete", id: "frame-object" },
    ],
  );
});
