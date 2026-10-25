import assert from "node:assert/strict";
import { test } from "node:test";
import {
  breadcrumbIds,
  focusChoice,
  focusObject,
  frameCamera,
  motionDuration,
  normalizeStack,
  panIntoView,
  planJump,
  planReturn,
  pushFrame,
  type NavFrame,
} from "../board/canvas/navigation.ts";

const camera = { x: 10, y: 20, zoom: 1 };

function frame(partial: Partial<NavFrame> & { boardId: string }): NavFrame {
  return {
    camera,
    selection: [],
    enteredFrom: null,
    ...partial,
  };
}

test("路径从进入栈排到当前白板", () => {
  const stack = normalizeStack([
    "home",
    {
      boardId: "child",
      camera,
      selection: ["p"],
      enteredFrom: "card",
    },
  ]);
  assert.equal(stack[0]?.boardId, "home");
  assert.equal(stack[0]?.enteredFrom, null);
  assert.equal(stack[1]?.enteredFrom, "card");
  assert.deepEqual(breadcrumbIds(stack, "leaf"), ["home", "child", "leaf"]);
  assert.deepEqual(breadcrumbIds([], "home"), ["home"]);
});

test("多处展示时回到进入的那一处；来源删了就用原来的视角", () => {
  const home = frame({
    boardId: "home",
    selection: ["note", "second"],
    enteredFrom: "second",
    camera: { x: 80, y: 40, zoom: 1.2 },
  });
  const where = (id: string) =>
    id === "second" || id === "note" ? "home" : id === "gone" ? null : "other";
  const alive = new Set(["home"]);
  const back = planReturn({
    stack: [home],
    homeId: "home",
    aliveBoards: alive,
    presentationBoard: where,
    reduceMotion: false,
  });
  assert.ok(back);
  assert.equal(back.focusId, "second");
  assert.equal(back.shrink, true);
  assert.equal(back.duration, 240);
  assert.deepEqual(back.camera, home.camera);
  assert.deepEqual(back.selection, ["note", "second"]);

  const missing = planReturn({
    stack: [
      frame({
        boardId: "home",
        selection: ["note", "gone"],
        enteredFrom: "gone",
        camera: { x: 80, y: 40, zoom: 1.2 },
      }),
    ],
    homeId: "home",
    aliveBoards: alive,
    presentationBoard: where,
    reduceMotion: false,
  });
  assert.ok(missing);
  assert.equal(missing.shrink, false);
  assert.equal(missing.duration, 0);
  assert.equal(missing.focusId, null);
  assert.deepEqual(missing.camera, { x: 80, y: 40, zoom: 1.2 });
  assert.deepEqual(missing.selection, ["note"]);
  assert.notDeepEqual(missing.camera, { x: 0, y: 0, zoom: 1 });
});

test("父白板没了就退到最近还在的祖先，最后是首页", () => {
  const stack = [
    frame({
      boardId: "home",
      camera: { x: 3, y: 4, zoom: 1 },
      enteredFrom: null,
    }),
    frame({ boardId: "gone", enteredFrom: "x" }),
  ];
  const plan = planReturn({
    stack,
    homeId: "home",
    aliveBoards: new Set(["home"]),
    presentationBoard: () => null,
    reduceMotion: false,
  });
  assert.ok(plan);
  assert.equal(plan.boardId, "home");
  assert.deepEqual(plan.camera, { x: 3, y: 4, zoom: 1 });
  assert.equal(plan.shrink, false);
  const jump = planJump({
    stack: pushFrame(
      stack.slice(0, 1),
      frame({ boardId: "mid", enteredFrom: "a" }),
    ),
    currentId: "leaf",
    targetId: "home",
    homeId: "home",
    aliveBoards: new Set(["home", "mid"]),
    presentationBoard: (id) => (id === "a" ? "mid" : null),
    reduceMotion: false,
  });
  assert.ok(jump);
  assert.equal(jump.boardId, "home");
  assert.equal(jump.shrink, false);
  assert.equal(jump.duration, 0);
});

test("完全可见的组件不移动镜头，被挡住的只平移", () => {
  const area = { left: 0, top: 0, right: 200, bottom: 200 };
  const visible = { x: 10, y: 10, width: 40, height: 40 };
  const view = { x: 0, y: 0, zoom: 1 };
  assert.equal(panIntoView(view, visible, area), null);
  const hidden = { x: 400, y: 10, width: 40, height: 40 };
  const moved = panIntoView(view, hidden, area);
  assert.ok(moved);
  assert.equal(moved.zoom, view.zoom);
  assert.ok(moved.x < view.x);
  const fitted = frameCamera({ x: 0, y: 0, width: 100, height: 50 }, area);
  assert.ok(fitted.zoom > 1);
  assert.equal(motionDuration(view, view, true), 0);
  assert.equal(motionDuration(view, fitted, false) > 0, true);
});

test("当前白板多份展示选最近的可见者，别的白板留给人挑", () => {
  const here = focusChoice({
    currentBoardId: "home",
    camera: { x: 0, y: 0, zoom: 1 },
    viewport: { width: 300, height: 200 },
    presentations: [
      { id: "far", boardId: "home", x: 20, y: 20, width: 40, height: 20 },
      { id: "near", boardId: "home", x: 140, y: 80, width: 40, height: 20 },
      { id: "else", boardId: "other", x: 0, y: 0, width: 10, height: 10 },
    ],
  });
  assert.deepEqual(here, { kind: "here", presentationId: "near" });
  const choose = focusChoice({
    currentBoardId: "home",
    camera: { x: 0, y: 0, zoom: 1 },
    viewport: { width: 300, height: 200 },
    presentations: [
      { id: "b", boardId: "other", x: 0, y: 0, width: 10, height: 10 },
      { id: "a", boardId: "other", x: 30, y: 0, width: 10, height: 10 },
    ],
  });
  assert.equal(choose.kind, "choose");
  if (choose.kind === "choose") {
    assert.deepEqual(
      choose.options.map((item) => item.presentationId),
      ["a", "b"],
    );
  }
  assert.deepEqual(
    focusChoice({
      currentBoardId: "home",
      camera: { x: 0, y: 0, zoom: 1 },
      viewport: { width: 100, height: 100 },
      presentations: [],
    }),
    { kind: "none" },
  );
  const pinned = focusObject({
    objectId: "note",
    returnTo: "second",
    currentBoardId: "home",
    camera: { x: 0, y: 0, zoom: 1 },
    viewport: { width: 300, height: 200 },
    presentations: [
      {
        id: "first",
        objectId: "note",
        boardId: "home",
        x: 140,
        y: 80,
        width: 40,
        height: 20,
      },
      {
        id: "second",
        objectId: "note",
        boardId: "home",
        x: 20,
        y: 20,
        width: 40,
        height: 20,
      },
    ],
  });
  assert.deepEqual(pinned, { kind: "here", presentationId: "second" });
  assert.deepEqual(
    focusObject({
      objectId: "missing",
      currentBoardId: "home",
      camera: { x: 0, y: 0, zoom: 1 },
      viewport: { width: 100, height: 100 },
      presentations: [],
    }),
    { kind: "none" },
  );
});
