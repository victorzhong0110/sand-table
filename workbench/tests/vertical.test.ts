// 纵向验证（issue #14）：小说与科研两个真实场景。
//
// 这些用例不是「界面上能画出来」的一次性演示，而是**可重复的自动测试**：
// 固定时钟、不依赖随机顺序，跑两遍结果一致。
// 每个场景都走真实写入路径——内容进对象、展示只管呈现与布局、关系独立于布局。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardStore } from "../core/store.ts";
import { Spaces } from "../server/spaces.ts";
import { openView } from "../core/space-state.ts";
import { resolveContent } from "../core/content.ts";
import {
  WorkspaceStore,
  collectExternalDependencies,
} from "../core/workspace.ts";
import { workspacePort } from "../core/persistence.ts";
import {
  checkDomainData,
  findObjectType,
  findRelationType,
  listTemplates,
  registerDomainPack,
} from "../core/domains.ts";
import type { Projection } from "../core/model.ts";
import type { ResourceReference, WorkspaceObject } from "../core/objects.ts";
import {
  checkNovelRelation,
  narrativeOrder,
  newNovelRelation,
  novelPack,
  storyOrder,
} from "../domains/novel/index.ts";
import {
  checkResearchRelation,
  citationToResource,
  newResearchRelation,
  pdfCitation,
  researchPack,
  staleCitations,
  verifyCitation,
} from "../domains/research/index.ts";
import type { ResearchCitation } from "../domains/research/index.ts";

// 领域包在进程内注册一次：注册表是单例，测试与真实启动走同一条路。
registerDomainPack(novelPack);
registerDomainPack(researchPack);

const empty: Projection = { workspaces: [], objects: [], relations: [] };

/** 固定时钟：断言不依赖真实时间戳，跑两遍结果一致。 */
const FIXED_NOW = 1_700_000_000_000;

type SetupOptions = {
  /** 给了就把工作空间落盘到这个目录。 */
  root?: string;
  /** 代码投影：混合场景用。 */
  projection?: Projection;
};

const setup = (options: SetupOptions = {}) => {
  const store = new BoardStore(() => FIXED_NOW);
  if (options.root)
    store.attachPersistence(
      workspacePort(new WorkspaceStore(options.root)),
      "default",
    );
  const spaces = new Spaces(store);
  const board = store.open(options.projection ?? empty, "纵向验证");
  openView(store.get(board.id), "view-a");
  const op = (operation: any) =>
    spaces.update(board.id, store.get(board.id).revision, "view-a", operation);
  return {
    store,
    spaces,
    op,
    boardId: board.id,
    /** 运行期的板（活对象）：改动会落进内核状态。 */
    at: () => store.get(board.id),
  };
};

/** 重开工作空间：模拟「关闭 → 重开」。 */
const reopen = (root: string) => {
  const store = new BoardStore(() => FIXED_NOW);
  store.attachPersistence(workspacePort(new WorkspaceStore(root)), "default");
  const board = store.open(empty, "纵向验证");
  return { store, boardId: board.id, at: () => store.get(board.id) };
};

/**
 * 按领域类型建对象。
 *
 * 领域规则先过一遍再写：这一步正是 core/spaces.ts 的 checkComponentData
 * 应当统一承担的那一环（#13 的接线点），现在由这里显式调用。
 */
const createTyped = (
  store: BoardStore,
  boardId: string,
  input: {
    type: string;
    title: string;
    data?: Record<string, unknown>;
    source?: WorkspaceObject["source"];
  },
) => {
  const data = input.data ?? {};
  const errors = checkDomainData(input.type, data);
  if (errors.length) throw new Error(`领域规则：${errors.join(" ")}`);
  return store.createContent(store.get(boardId), { ...input, data }, "human");
};

/**
 * 挂一条资源引用。
 *
 * 内核目前没有写路径（store 里没有 createResource），只能直接写板级状态。
 * 这是本轮暴露的缺口：资源引用不进撤销栈，也不计 contentRevision。
 */
const attachResource = (
  store: BoardStore,
  boardId: string,
  resource: ResourceReference,
) => {
  store.get(boardId).resources.push(resource);
};

// ————————————————————————————————————————————————————————————
// 小说场景
// ————————————————————————————————————————————————————————————

test("小说场景：同一人物在两块白板各有一张卡——改内容两处同步，移动只动一处", () => {
  const { store, op, boardId, at } = setup();

  // 1. 建对象：人物、事件、章节。
  const character = createTyped(store, boardId, {
    type: "character",
    title: "林澈",
    data: {
      name: "林澈",
      role: "主角",
      age: 27,
      traits: ["沉默", "记仇"],
      goal: "回到港口",
    },
  });
  const event = createTyped(store, boardId, {
    type: "event",
    title: "港口大火",
    data: {
      summary: "夜里烧掉了半条码头",
      storyTime: "第三年冬",
      narrativeOrder: 2,
      place: "港口",
    },
  });
  const chapter = createTyped(store, boardId, {
    type: "chapter",
    title: "第一章：回声",
    data: { summary: "林澈回到码头", narrativeOrder: 1, pov: "林澈" },
  });
  assert.equal(character.type, "character", "人物是一等对象");
  assert.equal(character.kind, "native");
  assert.equal(event.type, "event");
  assert.equal(chapter.type, "chapter");

  // 2. 两块白板：嵌套白板各自是一个 space。
  op({ kind: "create", type: "board", title: "第一幕" });
  op({ kind: "create", type: "board", title: "第三幕" });
  const spaceIds = at()
    .instances.filter((i) => i.type === "board")
    .map((i) => String(i.data.spaceId));
  assert.equal(spaceIds.length, 2, "两块嵌套白板建好了");

  // 同一人物在两块白板各放一份展示。
  op({ kind: "present", objectId: character.id, spaceId: spaceIds[0] });
  op({ kind: "present", objectId: character.id, spaceId: spaceIds[1] });
  const cards = at().instances.filter(
    (i) => i.binding?.kind === "object" && i.binding.objectId === character.id,
  );
  assert.equal(cards.length, 2, "两块白板各有一张卡");
  assert.notEqual(cards[0].spaceId, cards[1].spaceId, "两张卡在不同白板上");

  // 3. 改人物内容 → 两张卡同时更新。
  op({
    kind: "update",
    instanceId: cards[0].id,
    expectedVersion: character.version,
    data: {
      name: "林澈",
      role: "复仇者",
      age: 27,
      traits: ["沉默", "记仇"],
      goal: "回到港口",
    },
    baseData: {
      name: "林澈",
      role: "主角",
      age: 27,
      traits: ["沉默", "记仇"],
      goal: "回到港口",
    },
  });
  const afterEdit = at();
  const shown = afterEdit.instances
    .filter(
      (i) =>
        i.binding?.kind === "object" && i.binding.objectId === character.id,
    )
    .map((i) => resolveContent(i, afterEdit.contentObjects));
  assert.equal(shown.length, 2, "还是两张卡");
  assert.equal(shown[0].data.role, "复仇者", "第一张卡跟着改了");
  assert.equal(shown[1].data.role, "复仇者", "第二张卡也跟着改了");
  assert.equal(shown[0].data.name, "林澈", "没改的字段没被清空");
  assert.equal(shown[1].data.name, "林澈", "另一张卡的字段也没被清空");
  assert.equal(
    afterEdit.contentObjects.find((o) => o.id === character.id)!.version,
    2,
    "内容只升了一个版本",
  );

  // 4. 移动一张 → 另一张不动。
  const otherRect = { ...cards[1].rect };
  op({
    kind: "place",
    items: [
      {
        id: cards[0].id,
        rect: { x: 120, y: 80, width: 280, height: 180, pinned: false },
      },
    ],
  });
  const afterMove = at();
  const moved = afterMove.instances.find((i) => i.id === cards[0].id)!;
  const stayed = afterMove.instances.find((i) => i.id === cards[1].id)!;
  assert.equal(moved.rect.x, 120, "被移动的那张动了");
  assert.equal(moved.rect.y, 80, "被移动的那张动了");
  assert.deepEqual(stayed.rect, otherRect, "另一张的布局没被带走");
});

test("小说场景：情节关系区分已确认与推测，推测必须给依据", () => {
  const { store, op, boardId, at } = setup();

  const character = createTyped(store, boardId, {
    type: "character",
    title: "林澈",
    data: { name: "林澈", role: "主角" },
  });
  const fire = createTyped(store, boardId, {
    type: "event",
    title: "港口大火",
    data: { summary: "夜里烧掉了半条码头", narrativeOrder: 2 },
  });
  const flood = createTyped(store, boardId, {
    type: "event",
    title: "洪水",
    data: { summary: "三天后码头又淹了", narrativeOrder: 3 },
  });
  const chapterA = createTyped(store, boardId, {
    type: "chapter",
    title: "第一章：火",
    data: { narrativeOrder: 1 },
  });
  const chapterB = createTyped(store, boardId, {
    type: "chapter",
    title: "第五章：水",
    data: { narrativeOrder: 5 },
  });

  // 四种情节关系，外加一条推测关系。
  op({
    kind: "relate",
    source: character.id,
    target: fire.id,
    relation: "参与",
    status: "confirmed",
  });
  op({
    kind: "relate",
    source: fire.id,
    target: flood.id,
    relation: "导致",
    status: "confirmed",
  });
  op({
    kind: "relate",
    source: fire.id,
    target: flood.id,
    relation: "先于",
    status: "confirmed",
  });
  op({
    kind: "relate",
    source: chapterA.id,
    target: chapterB.id,
    relation: "埋设-回收",
    status: "confirmed",
  });
  op({
    kind: "relate",
    source: character.id,
    target: flood.id,
    relation: "先于",
    status: "inferred",
    basis: "作者笔记：洪水之前他就说过要发大水",
  });

  const relations = at().objectRelations;
  assert.equal(relations.length, 5, "五条关系");
  assert.deepEqual(
    new Set(relations.map((r) => r.kind)),
    new Set(["参与", "导致", "先于", "埋设-回收"]),
    "四种情节关系都在",
  );
  const inferred = relations.filter((r) => r.status === "inferred");
  assert.equal(inferred.length, 1, "推测关系单独标出来");
  assert.equal(
    inferred[0].basis,
    "作者笔记：洪水之前他就说过要发大水",
    "推测关系带着依据",
  );
  assert.notEqual(inferred[0].status, "confirmed", "推测不冒充已确认");
  assert.equal(
    relations.filter((r) => r.status === "confirmed").length,
    4,
    "已确认的关系不受影响",
  );

  // 领域规则：推测关系没有依据要被拒。
  // 注意：写路径目前不强制这条规则（统一校验入口还没接领域规则，
  // 关系级校验也没有注册表入口），这里是领域包自己的纯函数在把关。
  const errors = checkNovelRelation({ kind: "先于", status: "inferred" });
  assert.ok(errors.length > 0, "没有依据的推测关系要报错");
  assert.match(errors.join(" "), /依据/);
  assert.throws(
    () => newNovelRelation({ kind: "先于", status: "inferred" }),
    /依据/,
    "写不进去",
  );
  assert.deepEqual(
    newNovelRelation({ kind: "先于", status: "confirmed" }),
    { kind: "先于", status: "confirmed" },
    "已确认关系不需要依据",
  );
  assert.match(
    checkNovelRelation({ kind: "不认识的关系", status: "confirmed" }).join(" "),
    /未知/,
    "未声明的关系类型要被拒",
  );

  // 注册表查得到这四种关系，而且都允许推测。
  for (const kind of ["参与", "导致", "先于", "埋设-回收"]) {
    const spec = findRelationType(kind);
    assert.ok(spec, `注册表里有「${kind}」`);
    assert.equal(spec!.allowsInferred, true, `「${kind}」允许推测`);
  }
});

test("小说场景：故事时间与叙述顺序能各自表达（倒叙）", () => {
  const events = [
    { id: "e1", storyTime: "第三年冬", narrativeOrder: 2 },
    { id: "e2", storyTime: "第一年春", narrativeOrder: 1 },
    { id: "e3", storyTime: "第五年秋", narrativeOrder: 3 },
  ];
  assert.deepEqual(
    storyOrder(events).map((e) => e.id),
    ["e2", "e1", "e3"],
    "按故事发生时间排",
  );
  assert.deepEqual(
    narrativeOrder(events).map((e) => e.id),
    ["e2", "e1", "e3"],
    "按叙述顺序排",
  );

  // 倒叙：叙述顺序与故事时间不一致，两个维度都表达得出来。
  const flashback = [
    { id: "a", storyTime: "第五年秋", narrativeOrder: 1 },
    { id: "b", storyTime: "第一年春", narrativeOrder: 2 },
  ];
  assert.deepEqual(
    storyOrder(flashback).map((e) => e.id),
    ["b", "a"],
    "故事时间顺序",
  );
  assert.deepEqual(
    narrativeOrder(flashback).map((e) => e.id),
    ["a", "b"],
    "叙述顺序",
  );

  // 可重复：同样输入跑两遍一样，没有随机序。
  assert.deepEqual(
    storyOrder(events).map((e) => e.id),
    storyOrder(events).map((e) => e.id),
  );
  assert.deepEqual(
    narrativeOrder(events).map((e) => e.id),
    narrativeOrder(events).map((e) => e.id),
  );
});

test("小说场景：保存 → 关闭 → 重开，作品完整", async () => {
  const root = mkdtempSync(join(tmpdir(), "sand-vertical-novel-"));
  try {
    const { store, op, boardId, at } = setup({ root });

    const character = createTyped(store, boardId, {
      type: "character",
      title: "林澈",
      data: { name: "林澈", role: "主角", age: 27, traits: ["沉默"] },
    });
    const fire = createTyped(store, boardId, {
      type: "event",
      title: "港口大火",
      data: { summary: "夜里烧掉了半条码头", narrativeOrder: 1 },
    });
    op({ kind: "create", type: "board", title: "第一幕" });
    const spaceId = String(
      at().instances.find((i) => i.type === "board")!.data.spaceId,
    );
    op({ kind: "present", objectId: character.id, spaceId });
    op({
      kind: "relate",
      source: character.id,
      target: fire.id,
      relation: "参与",
      status: "confirmed",
    });
    op({
      kind: "relate",
      source: character.id,
      target: fire.id,
      relation: "先于",
      status: "inferred",
      basis: "作者笔记",
    });
    const before = at();
    const beforeCards = before.instances.filter(
      (i) =>
        i.binding?.kind === "object" && i.binding.objectId === character.id,
    ).length;
    await store.flushSave();

    // 关闭 → 重开。
    const reopened = reopen(root);
    const after = reopened.at();
    assert.equal(after.contentObjects.length, 2, "人物与事件都回来了");
    assert.equal(after.objectRelations.length, 2, "关系都回来了");
    assert.equal(after.spaces.length, 2, "总览 + 嵌套白板");
    const restored = after.contentObjects.find((o) => o.id === character.id)!;
    assert.equal((restored.data as any).name, "林澈", "人物内容完整");
    const restoredCards = after.instances.filter(
      (i) =>
        i.binding?.kind === "object" && i.binding.objectId === character.id,
    );
    assert.equal(restoredCards.length, beforeCards, "展示完整");
    const restoredRelations = after.objectRelations;
    assert.equal(
      restoredRelations.filter((r) => r.status === "inferred").length,
      1,
      "已确认与推测的区别没丢",
    );
    assert.equal(
      restoredRelations.find((r) => r.status === "inferred")!.basis,
      "作者笔记",
      "推测关系的依据还在",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ————————————————————————————————————————————————————————————
// 科研场景
// ————————————————————————————————————————————————————————————

test("科研场景：PDF 引用定位到页码并带指纹，支持 / 反驳关系带依据", () => {
  const { store, op, boardId, at } = setup();

  const hypothesis = createTyped(store, boardId, {
    type: "hypothesis",
    title: "剂量假设",
    data: {
      statement: "提高剂量能缩短恢复时间",
      scope: "成年患者",
      testable: true,
      variables: ["剂量", "恢复时间"],
    },
  });
  const citation = pdfCitation({
    uri: "file:///papers/chen-2024.pdf",
    page: 42,
    fingerprint: "sha256:aaa111",
    quote: "剂量每提高一档，恢复时间缩短 1.8 天（p < 0.01）",
    title: "陈 2024",
  });
  const evidence = createTyped(store, boardId, {
    type: "evidence",
    title: "陈 2024 第 42 页",
    data: {
      summary: "120 例样本中剂量与恢复时间显著相关",
      method: "文献摘录",
      strength: 0.8,
      citation,
    },
    source: {
      origin: "human",
      author: "human",
      external: { kind: "pdf", uri: citation.uri, fragment: citation.fragment },
      fingerprint: citation.fingerprint,
    },
  });
  const control = createTyped(store, boardId, {
    type: "evidence",
    title: "阴性对照",
    data: { summary: "对照组 20 例无显著差异", method: "观察", strength: 0.3 },
  });
  const conclusion = createTyped(store, boardId, {
    type: "conclusion",
    title: "相关结论",
    data: { statement: "剂量与恢复时间存在正相关", confidence: 0.6 },
  });

  // 1. 引用：页码级定位 + 来源 + 指纹。
  assert.equal(citation.fragment, "p.42", "引用定位到页");
  assert.equal(citation.status, "valid");
  const stored = at().contentObjects.find((o) => o.id === evidence.id)!;
  assert.equal(
    stored.source?.external?.fragment,
    "p.42",
    "对象来源里带着页码级定位",
  );
  assert.equal(
    stored.source?.external?.uri,
    "file:///papers/chen-2024.pdf",
    "对象来源里带着来源",
  );
  assert.equal(
    stored.source?.fingerprint,
    "sha256:aaa111",
    "对象来源里带着内容指纹",
  );
  assert.equal(
    (stored.data as any).citation.fragment,
    "p.42",
    "证据对象里带着这条引用",
  );

  const resource = citationToResource(citation, "res-chen-2024-p42");
  assert.equal(resource.kind, "pdf");
  assert.equal(resource.uri, "file:///papers/chen-2024.pdf");
  assert.equal(resource.fragment, "p.42");
  assert.equal(resource.fingerprint, "sha256:aaa111");
  assert.equal(resource.status, "valid");

  // 2. 关系：支持 / 反驳，各带依据。
  op({
    kind: "relate",
    source: evidence.id,
    target: hypothesis.id,
    relation: "支持",
    status: "confirmed",
    basis: "陈 2024 第 42 页：r = 0.83（p < 0.01）",
  });
  op({
    kind: "relate",
    source: control.id,
    target: hypothesis.id,
    relation: "反驳",
    status: "confirmed",
    basis: "对照组 n=20 无显著差异",
  });
  op({
    kind: "relate",
    source: evidence.id,
    target: conclusion.id,
    relation: "支持",
    status: "confirmed",
    basis: "同页的相关系数支持这条结论",
  });

  const relations = at().objectRelations;
  assert.equal(relations.length, 3, "三条论证关系");
  assert.deepEqual(
    new Set(relations.map((r) => r.kind)),
    new Set(["支持", "反驳"]),
    "支持与反驳都标出来了",
  );
  for (const relation of relations)
    assert.ok(
      relation.basis && relation.basis.trim(),
      `关系「${relation.kind}」带着依据`,
    );

  // 领域规则：没有依据的支持 / 反驳要被拒。
  const errors = checkResearchRelation({ kind: "支持", status: "confirmed" });
  assert.ok(errors.length > 0, "没有依据的支持关系要报错");
  assert.match(errors.join(" "), /依据/);
  assert.throws(
    () => newResearchRelation({ kind: "反驳", status: "confirmed" }),
    /依据/,
  );
  assert.deepEqual(
    newResearchRelation({
      kind: "支持",
      status: "confirmed",
      basis: "r = 0.83",
    }),
    { kind: "支持", status: "confirmed", basis: "r = 0.83" },
  );
  assert.match(
    checkResearchRelation({ kind: "随便什么关系", status: "confirmed" }).join(
      " ",
    ),
    /未知/,
    "未声明的关系类型要被拒",
  );
});

test("科研场景：外部内容变了能识别出来，不静默覆盖原记录", () => {
  const { store, boardId, at } = setup();

  const citation = pdfCitation({
    uri: "file:///papers/chen-2024.pdf",
    page: 42,
    fingerprint: "sha256:aaa111",
  });
  const evidence = createTyped(store, boardId, {
    type: "evidence",
    title: "陈 2024 第 42 页",
    data: {
      summary: "120 例样本中剂量与恢复时间显著相关",
      method: "文献摘录",
      strength: 0.8,
      citation,
    },
  });
  const stored = at().contentObjects.find((o) => o.id === evidence.id)!;
  const storedCitation = (stored.data as any).citation as ResearchCitation;

  // 外部内容变了：识别出来。
  const stale = verifyCitation(storedCitation, {
    found: true,
    fingerprint: "sha256:bbb222",
  });
  assert.equal(stale.status, "stale", "内容变了要标成过期");
  assert.equal(stale.fingerprint, "sha256:aaa111", "原指纹不被悄悄换掉");
  assert.equal(stale.observedFingerprint, "sha256:bbb222", "新指纹留痕");

  // 外部资源取不到了：识别出来。
  const missing = verifyCitation(storedCitation, { found: false });
  assert.equal(missing.status, "missing", "取不到要标成缺失");
  assert.equal(missing.fingerprint, "sha256:aaa111", "失效不等于内容被改写");

  // 复核本身不写数据：失效要显式写回才算数。
  assert.equal(storedCitation.status, "valid", "复核不静默改数据");
  assert.equal(
    at().contentObjects.find((o) => o.id === evidence.id)!.version,
    1,
    "对象版本没动",
  );
  assert.deepEqual(
    staleCitations(at().contentObjects),
    [],
    "失效清单此时是空的",
  );

  // 显式写回：这一步才改数据。
  const updated = store.updateContent(
    at(),
    evidence.id,
    { data: { ...(stored.data as any), citation: stale } },
    stored.version,
    "human",
  );
  assert.equal((updated.data as any).citation.status, "stale", "写回后才变");
  assert.equal(
    at().contentObjects.find((o) => o.id === evidence.id)!.version,
    2,
    "显式写回才升版本",
  );
  const found = staleCitations(at().contentObjects);
  assert.equal(found.length, 1, "失效的引用能被扫出来");
  assert.equal(found[0].objectId, evidence.id);
  assert.equal(found[0].citation.status, "stale");
  assert.equal(found[0].citation.fingerprint, "sha256:aaa111", "原记录还在");
});

test("科研场景：保存 → 关闭 → 重开，假设、证据、结论、引用与依据都完整", async () => {
  const root = mkdtempSync(join(tmpdir(), "sand-vertical-research-"));
  try {
    const { store, op, boardId, at } = setup({ root });

    const hypothesis = createTyped(store, boardId, {
      type: "hypothesis",
      title: "剂量假设",
      data: { statement: "提高剂量能缩短恢复时间", testable: true },
    });
    const citation = pdfCitation({
      uri: "file:///papers/chen-2024.pdf",
      page: 42,
      fingerprint: "sha256:aaa111",
      quote: "剂量每提高一档，恢复时间缩短 1.8 天",
    });
    const evidence = createTyped(store, boardId, {
      type: "evidence",
      title: "陈 2024 第 42 页",
      data: {
        summary: "120 例样本中剂量与恢复时间显著相关",
        method: "文献摘录",
        strength: 0.8,
        citation,
      },
      source: {
        origin: "human",
        author: "human",
        external: {
          kind: "pdf",
          uri: citation.uri,
          fragment: citation.fragment,
        },
        fingerprint: citation.fingerprint,
      },
    });
    const conclusion = createTyped(store, boardId, {
      type: "conclusion",
      title: "相关结论",
      data: { statement: "剂量与恢复时间存在正相关", confidence: 0.6 },
    });
    op({
      kind: "relate",
      source: evidence.id,
      target: hypothesis.id,
      relation: "支持",
      status: "confirmed",
      basis: "陈 2024 第 42 页：r = 0.83",
    });
    op({
      kind: "relate",
      source: evidence.id,
      target: conclusion.id,
      relation: "支持",
      status: "confirmed",
      basis: "同页的相关系数",
    });

    // 引用失效，写回状态，并登记一条资源引用。
    const stored = at().contentObjects.find((o) => o.id === evidence.id)!;
    const stale = verifyCitation(
      (stored.data as any).citation as ResearchCitation,
      {
        found: true,
        fingerprint: "sha256:bbb222",
      },
    );
    store.updateContent(
      at(),
      evidence.id,
      { data: { ...(stored.data as any), citation: stale } },
      stored.version,
      "human",
    );
    attachResource(
      store,
      boardId,
      citationToResource(stale, "res-chen-2024-p42"),
    );
    await store.flushSave();

    // 落盘文件里，这条 PDF 引用是登记在案的外部依赖，页码级定位没丢。
    const file = JSON.parse(
      readFileSync(join(root, "default", "workspace.json"), "utf8"),
    );
    const dependencies = collectExternalDependencies(file);
    const pdf = dependencies.find(
      (d) => d.uri === "file:///papers/chen-2024.pdf",
    );
    assert.ok(pdf, "PDF 被登记成外部依赖");
    assert.equal(pdf!.fragment, "p.42", "外部依赖带着页码级定位");

    // 关闭 → 重开。
    const reopened = reopen(root);
    const after = reopened.at();
    assert.equal(after.contentObjects.length, 3, "假设、证据、结论都回来了");
    assert.equal(after.objectRelations.length, 2, "论证关系都回来了");
    for (const relation of after.objectRelations)
      assert.ok(
        relation.basis && relation.basis.trim(),
        `关系「${relation.kind}」的依据还在`,
      );
    const restoredEvidence = after.contentObjects.find(
      (o) => o.id === evidence.id,
    )!;
    const restoredCitation = (restoredEvidence.data as any)
      .citation as ResearchCitation;
    assert.equal(restoredCitation.status, "stale", "失效状态还在");
    assert.equal(restoredCitation.fragment, "p.42", "页码级定位还在");
    assert.equal(restoredCitation.fingerprint, "sha256:aaa111", "原指纹还在");
    assert.equal(
      restoredEvidence.source?.fingerprint,
      "sha256:aaa111",
      "对象来源的指纹还在",
    );
    assert.equal(after.resources.length, 1, "资源引用也回来了");
    assert.equal(after.resources[0].status, "stale", "资源引用的状态也在");
    assert.equal(after.resources[0].fragment, "p.42");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ————————————————————————————————————————————————————————————
// 混合场景与注册表
// ————————————————————————————————————————————————————————————

test("混合场景：同一工作空间里科研类型与代码类型并存，不必迁到另一种「项目模式」", () => {
  const projection: Projection = {
    workspaces: [
      {
        id: "w1",
        label: "论文复现",
        head: "abc123",
        branch: "main",
        snapshot: "abc123",
        files: 3,
        omitted: [],
      },
    ],
    objects: [
      {
        id: "code-1",
        workspaceId: "w1",
        kind: "symbol",
        title: "analyze()",
        parentId: "file-1",
      },
    ],
    relations: [],
  };
  const { store, op, boardId, at } = setup({ projection });

  const hypothesis = createTyped(store, boardId, {
    type: "hypothesis",
    title: "剂量假设",
    data: { statement: "提高剂量能缩短恢复时间", testable: true },
  });
  const character = createTyped(store, boardId, {
    type: "character",
    title: "林澈",
    data: { name: "林澈" },
  });

  // 两种内容在同一块板、同一份列表里，谁也没变成谁。
  const listed = store.listObjects(boardId);
  assert.equal(listed.counts.native, 2, "科研与小说对象都在");
  assert.equal(listed.counts.code, 1, "代码对象也在");
  const hypothesisRow = listed.objects.find((o) => o.id === hypothesis.id)!;
  assert.equal(hypothesisRow.kind, "native");
  assert.equal(hypothesisRow.type, "hypothesis", "科研类型没被改写");
  const codeRow = listed.objects.find((o) => o.id === "code-1")!;
  assert.equal(codeRow.kind, "code", "代码对象还是代码对象");
  assert.equal(codeRow.type, "symbol");

  // 板上的展示：代码投影一张，科研对象一张，互不相干。
  const codeCard = at().instances.find((i) => i.objectId === "code-1")!;
  assert.ok(codeCard, "代码对象在板上有展示");
  op({ kind: "present", objectId: hypothesis.id });
  const codeRect = { ...codeCard.rect };
  const hypothesisCard = at().instances.find(
    (i) => i.binding?.kind === "object" && i.binding.objectId === hypothesis.id,
  )!;
  assert.ok(hypothesisCard, "科研对象也在同一块板上");

  // 改科研对象：代码展示一点没动。
  store.updateContent(
    at(),
    hypothesis.id,
    { data: { statement: "提高剂量能缩短恢复时间（修订）" } },
    1,
    "human",
  );
  const after = at();
  assert.deepEqual(
    after.instances.find((i) => i.id === codeCard.id)!.rect,
    codeRect,
    "改科研对象不动代码展示",
  );
  assert.equal(
    (after.contentObjects.find((o) => o.id === hypothesis.id)!.data as any)
      .statement,
    "提高剂量能缩短恢复时间（修订）",
    "科研对象改到了",
  );
  assert.equal(
    after.contentObjects.find((o) => o.id === character.id)!.type,
    "character",
    "小说对象不受影响",
  );
});

test("领域包注册后：类型、关系、模板都能被注册表查到，领域规则真的会跑", () => {
  assert.equal(findObjectType("character")?.title, "人物");
  assert.equal(findObjectType("event")?.title, "事件");
  assert.equal(findObjectType("chapter")?.title, "章节");
  assert.equal(findObjectType("hypothesis")?.title, "假设");
  assert.equal(findObjectType("evidence")?.title, "证据");
  assert.equal(findObjectType("conclusion")?.title, "结论");
  assert.equal(findRelationType("支持")?.title, "支持");
  assert.equal(findRelationType("反驳")?.title, "反驳");

  const templates = listTemplates();
  assert.ok(
    templates.some((t) => t.template.id === "novel-three-act"),
    "小说模板在册",
  );
  assert.ok(
    templates.some((t) => t.template.id === "research-hypothesis-evidence"),
    "科研模板在册",
  );

  // 领域规则：合法的数据通过，缺必填的报错。
  assert.deepEqual(checkDomainData("character", { name: "林澈" }), []);
  assert.ok(
    checkDomainData("character", { name: "" }).length > 0,
    "人物没姓名要报错",
  );
  assert.ok(
    checkDomainData("hypothesis", { statement: "" }).length > 0,
    "假设没陈述要报错",
  );
  assert.ok(
    checkDomainData("evidence", { summary: "有摘要" }).length === 0,
    "证据有摘要就通过",
  );
  assert.ok(
    checkDomainData("evidence", {
      summary: "有摘要",
      citation: {
        uri: "",
        fragment: "第 42 页",
        fingerprint: "",
        status: "valid",
      },
    }).length > 0,
    "引用没页码定位、没指纹要报错",
  );
});
