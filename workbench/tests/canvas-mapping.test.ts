import assert from "node:assert/strict";
import { test } from "node:test";
import {
  openingViewport,
  pickEndpoint,
  relationChoices,
  renderSize,
  toFlowEdges,
  toFlowNodes,
  type MapPresentation,
  type MapRelation,
} from "../board/canvas/mapping.ts";

const board = "home";

function presentation(
  id: string,
  patch: Partial<MapPresentation> = {},
): MapPresentation {
  return {
    id,
    boardId: board,
    objectId: id,
    x: 10,
    y: 20,
    width: 280,
    height: 180,
    z: 1,
    ...patch,
  };
}

test("展示映射成节点，框内坐标保持相对值", () => {
  const nodes = toFlowNodes(
    [
      presentation("frame", { objectId: "frame-object", x: 40, y: 50 }),
      presentation("child", {
        objectId: "child-object",
        parentId: "frame",
        x: 12,
        y: 16,
        z: 3,
      }),
      presentation("gone", { deleted: true }),
      presentation("other", { boardId: "elsewhere" }),
    ],
    board,
    (objectId) => (objectId === "child-object" ? "note" : undefined),
  );
  assert.deepEqual(
    nodes.map((node) => node.id),
    ["frame", "child"],
  );
  const child = nodes.find((node) => node.id === "child");
  assert.equal(child?.parentId, "frame");
  assert.deepEqual(child?.position, { x: 12, y: 16 });
  assert.equal(child?.type, "note");
  assert.equal(child?.zIndex, 3);
  assert.equal(nodes[0]?.type, "generic");
  assert.equal(nodes[0]?.parentId, undefined);
});

test("折叠档位只改渲染尺寸，不改存储宽高", () => {
  const source = presentation("card", {
    width: 280,
    height: 180,
    appearance: { detail: "icon" },
  });
  const before = structuredClone(source);
  const [node] = toFlowNodes([source], board);
  assert.deepEqual(renderSize(280, 180, "label"), { width: 240, height: 48 });
  assert.deepEqual(renderSize(280, 180, "icon"), { width: 48, height: 48 });
  assert.equal(node?.width, 48);
  assert.equal(node?.height, 48);
  assert.equal(node?.data.storedWidth, 280);
  assert.equal(node?.data.storedHeight, 180);
  assert.deepEqual(source, before);
});

test("锁定的展示不能拖", () => {
  const [node] = toFlowNodes([presentation("card", { locked: true })], board);
  assert.equal(node?.draggable, false);
});

test("关系只连当前白板两端，多份展示不画笛卡尔积", () => {
  const presentations = [
    presentation("a2", { objectId: "a" }),
    presentation("a1", { objectId: "a" }),
    presentation("b2", { objectId: "b" }),
    presentation("b1", { objectId: "b" }),
    presentation("c1", { objectId: "c", boardId: "other" }),
  ];
  const relations: MapRelation[] = [
    { id: "r1", kind: "base.related", sourceId: "a", targetId: "b" },
    { id: "r2", kind: "base.related", sourceId: "a", targetId: "missing" },
    { id: "r3", kind: "base.related", sourceId: "a", targetId: "c" },
    {
      id: "r4",
      kind: "base.related",
      sourceId: "a",
      targetId: "b",
      deleted: true,
    },
  ];
  const plain = toFlowEdges(relations, presentations, board, []);
  assert.deepEqual(
    plain.map((edge) => [edge.id, edge.source, edge.target]),
    [["r1", "a1", "b1"]],
  );
  assert.equal(
    pickEndpoint(
      presentations.filter((item) => item.objectId === "a"),
      new Set(["a2"]),
    )?.id,
    "a2",
  );
  const selected = toFlowEdges(relations, presentations, board, ["b2"]);
  assert.equal(selected[0]?.source, "a1");
  assert.equal(selected[0]?.target, "b2");
  const both = toFlowEdges(relations, presentations, board, ["a2", "a1", "b2"]);
  assert.equal(both[0]?.source, "a1");
  assert.equal(both[0]?.target, "b2");
});

test("首页不 fitView，有内容的其他白板在没有镜头时 fitView", () => {
  assert.deepEqual(
    openingViewport({ camera: null, isHome: true, presentationCount: 3 }),
    { viewport: { x: 24, y: 24, zoom: 1 }, fit: false },
  );
  assert.deepEqual(
    openingViewport({
      camera: { x: 0, y: 0, zoom: 1 },
      isHome: true,
      presentationCount: 0,
    }),
    { viewport: { x: 24, y: 24, zoom: 1 }, fit: false },
  );
  assert.deepEqual(
    openingViewport({ camera: null, isHome: false, presentationCount: 2 }),
    { viewport: { x: 24, y: 24, zoom: 1 }, fit: true },
  );
  assert.deepEqual(
    openingViewport({
      camera: { x: 12, y: 40, zoom: 0.8 },
      isHome: false,
      presentationCount: 2,
    }),
    { viewport: { x: 12, y: 40, zoom: 0.8 }, fit: false },
  );
});

test("关系选择按两端类型过滤，通用关系仍然保留", () => {
  const kinds = [
    { kind: "base.related", title: "相关" },
    { kind: "base.about", title: "关于" },
    {
      kind: "novel.appears_in",
      title: "出现于",
      sourceTypes: ["novel.character"],
      targetTypes: ["novel.chapter"],
    },
  ];
  const choices = relationChoices(
    kinds,
    "base.note",
    "base.note",
    [{ kind: "base.about", direction: "out", targetTypes: ["base.note"] }],
    [],
  );
  assert.deepEqual(
    choices.map((item) => item.kind),
    ["base.related", "base.about"],
  );
  const blocked = relationChoices(
    kinds,
    "base.note",
    "base.note",
    [{ kind: "base.about", direction: "out", targetTypes: ["novel.chapter"] }],
    [],
  );
  assert.deepEqual(
    blocked.map((item) => item.kind),
    ["base.related"],
  );
});
