import { test } from "node:test";
import assert from "node:assert/strict";
import * as content from "../board/data-client/content.ts";
import {
  canNest,
  cloneObject,
  createObject,
  deleteObject,
  DuplicateRelationError,
  ObjectNotFoundError,
  presentationsFor,
  ReferencedObjectError,
  relate,
  resolveContent,
  StaleVersionError,
  unlink,
  updateObject,
} from "../board/data-client/content.ts";
import type { ObjectState } from "../board/data-client/content.ts";
import type { Rect } from "../board/data-client/objects.ts";

const rect = (over: Partial<Rect> = {}): Rect => ({
  x: 0,
  y: 0,
  width: 240,
  height: 120,
  pinned: false,
  ...over,
});

const presentation = (input: {
  id: string;
  spaceId: string;
  objectId?: string;
  /** 代码投影实例的旧字段：只写 objectId，不写 binding。 */
  legacyObjectId?: string;
  /** 显式声明为本地内容（不绑定对象）。 */
  local?: boolean;
  title?: string;
  data?: Record<string, unknown>;
  rect?: Partial<Rect>;
}) => ({
  id: input.id,
  spaceId: input.spaceId,
  type: "note",
  ...(input.objectId === undefined
    ? {}
    : { binding: { kind: "object" as const, objectId: input.objectId } }),
  ...(input.legacyObjectId === undefined
    ? {}
    : { objectId: input.legacyObjectId }),
  ...(input.local === undefined ? {} : { binding: { kind: "local" as const } }),
  title: input.title ?? "本地标题",
  data: input.data ?? {},
  rect: rect(input.rect),
  updatedAt: 1000,
  author: "human",
});

const note = (
  id: string,
  over: {
    now?: number;
    title?: string;
    data?: Record<string, unknown>;
    source?: {
      origin: "human" | "imported" | "ai-generated" | "ai-inferred";
      basis?: string;
      external?: { kind: "file"; uri: string };
    };
  } = {},
) =>
  createObject({
    id,
    type: "note",
    title: over.title ?? `${id} 标题`,
    body: `${id} 正文`,
    data: over.data ?? { text: "初稿" },
    source: over.source ?? { origin: "human", author: "vic" },
    now: over.now ?? 1000,
    author: "vic",
  });

test("createObject: kind 默认 native、version 从 1 起、时间戳取 now、来源原样记录", () => {
  const data = { tags: ["a"], nested: { count: 1 } };
  const source = { origin: "human" as const, author: "vic", basis: "手写" };
  const obj = createObject({
    id: "obj-1",
    type: "note",
    title: "第一稿",
    body: "正文",
    data,
    source,
    now: 1000,
    author: "vic",
  });
  assert.equal(obj.kind, "native");
  assert.equal(obj.version, 1);
  assert.equal(obj.typeVersion, 1);
  assert.equal(obj.createdAt, 1000);
  assert.equal(obj.updatedAt, 1000);
  assert.equal(obj.author, "vic");
  assert.equal(obj.body, "正文");
  assert.deepEqual(obj.source, source);
  // 写入时深拷贝：调用方之后改自己的 data 不会污染对象
  data.tags.push("b");
  assert.deepEqual(obj.data, { tags: ["a"], nested: { count: 1 } });
  // 可选字段不写就不出现（不塞 undefined 占位）
  const bare = createObject({
    id: "obj-2",
    type: "note",
    title: "空对象",
    now: 5,
    author: "vic",
  });
  assert.equal("body" in bare, false);
  assert.equal("data" in bare, false);
  assert.equal("source" in bare, false);
  // kind / typeVersion 可显式覆盖
  const code = createObject({
    id: "obj-3",
    type: "symbol",
    title: "f",
    kind: "code",
    typeVersion: 3,
    now: 7,
    author: "index",
  });
  assert.equal(code.kind, "code");
  assert.equal(code.typeVersion, 3);
});

test("updateObject: 版本不匹配抛 StaleVersionError，匹配时 version 自增且不改输入", () => {
  const obj = note("obj-1");
  const objects = [obj];
  assert.throws(
    () => updateObject(objects, "obj-1", { title: "改" }, 99, 2000, "vic"),
    (err: unknown) => {
      assert.ok(err instanceof StaleVersionError);
      assert.equal((err as StaleVersionError).expectedVersion, 99);
      assert.equal((err as StaleVersionError).currentVersion, 1);
      assert.equal((err as StaleVersionError).id, "obj-1");
      return true;
    },
  );
  // 冲突时不静默覆盖
  assert.equal(objects[0].title, "obj-1 标题");
  assert.equal(objects[0].version, 1);
  const updated = updateObject(
    objects,
    "obj-1",
    { title: "第二稿", body: "v2", data: { text: "v2" } },
    1,
    2000,
    "agent",
  );
  assert.equal(updated.version, 2);
  assert.equal(updated.title, "第二稿");
  assert.equal(updated.body, "v2");
  assert.deepEqual(updated.data, { text: "v2" });
  assert.equal(updated.createdAt, 1000);
  assert.equal(updated.updatedAt, 2000);
  assert.equal(updated.author, "agent");
  // 纯函数：输入数组没有被改写
  assert.equal(objects[0].version, 1);
  assert.equal(objects[0].title, "obj-1 标题");
  // 版本号继续自增
  const again = updateObject(
    [updated],
    "obj-1",
    { title: "第三稿" },
    2,
    3000,
    "vic",
  );
  assert.equal(again.version, 3);
  // 目标不存在
  assert.throws(
    () => updateObject(objects, "missing", { title: "x" }, 1, 1, "vic"),
    ObjectNotFoundError,
  );
});

test("updateObject: 新版本不与旧版本共享可变 data/source（只改标题也不共享）", () => {
  const original = note("obj-1", {
    data: { nested: { count: 1 }, list: [1] },
    source: {
      origin: "human",
      basis: "手写",
      external: { kind: "file", uri: "a.ts" },
    },
  });
  const updated = updateObject(
    [original],
    "obj-1",
    { title: "只改标题" },
    1,
    2000,
    "vic",
  );
  // 引用必须不同
  assert.notEqual(updated.data, original.data);
  assert.notEqual(updated.source, original.source);
  assert.notEqual(
    (updated.data as { nested: unknown }).nested,
    (original.data as { nested: unknown }).nested,
  );
  assert.notEqual(
    (updated.source as { external?: unknown }).external,
    (original.source as { external?: unknown }).external,
  );
  // 改新版本不污染旧版本（撤销快照里的 before 不会被改坏）
  (updated.data as { nested: { count: number } }).nested.count = 99;
  (updated.source as { basis?: string }).basis = "篡改";
  assert.equal(
    (original.data as { nested: { count: number } }).nested.count,
    1,
  );
  assert.equal((original.source as { basis?: string }).basis, "手写");
  // 改旧版本也不污染新版本
  (original.data as { nested: { count: number } }).nested.count = 42;
  assert.equal(
    (updated.data as { nested: { count: number } }).nested.count,
    99,
  );
  // 内容一致但互不影响
  assert.deepEqual(updated.data, { nested: { count: 99 }, list: [1] });
  assert.deepEqual(original.data, { nested: { count: 42 }, list: [1] });
});

test("cloneObject: 产出独立副本，改副本不影响原对象", () => {
  const original = note("obj-1", {
    data: { nested: { count: 1 }, list: [1, 2] },
    source: {
      origin: "human",
      basis: "手写",
      external: { kind: "file", uri: "a.ts" },
    },
  });
  const objects = [original];
  const copy = cloneObject(objects, "obj-1", "obj-2", 2000, "agent");
  assert.equal(copy.id, "obj-2");
  assert.equal(copy.version, 1);
  assert.equal(copy.createdAt, 2000);
  assert.equal(copy.updatedAt, 2000);
  assert.equal(copy.author, "agent");
  assert.equal(copy.type, original.type);
  assert.equal(copy.typeVersion, original.typeVersion);
  assert.deepEqual(copy.source, original.source);
  // 深拷贝：嵌套结构不共享引用
  assert.notEqual(copy.data, original.data);
  assert.notEqual(
    (copy.data as { nested: unknown }).nested,
    (original.data as { nested: unknown }).nested,
  );
  assert.notEqual(
    (copy.source as { external?: unknown }).external,
    (original.source as { external?: unknown }).external,
  );
  (copy.data as { nested: { count: number } }).nested.count = 99;
  (copy.source as { basis?: string }).basis = "副本改的";
  assert.equal(
    (original.data as { nested: { count: number } }).nested.count,
    1,
  );
  assert.equal((original.source as { basis?: string }).basis, "手写");
  // 改副本不影响原对象
  const updatedCopy = updateObject(
    [copy],
    "obj-2",
    { title: "副本改过", data: { nested: { count: 7 } } },
    1,
    3000,
    "agent",
  );
  assert.equal(updatedCopy.title, "副本改过");
  assert.equal(original.title, "obj-1 标题");
  assert.equal(original.version, 1);
  assert.deepEqual(original.data, { nested: { count: 1 }, list: [1, 2] });
  // 复制不是「再放一份展示」：新对象有自己的 id
  assert.notEqual(copy.id, original.id);
});

test("deleteObject: refuse 在被引用时拒绝，detach 移除引用后删除并返回 id 列表", () => {
  const obj = note("obj-1");
  const other = note("obj-2");
  const p1 = presentation({ id: "p-1", spaceId: "board-a", objectId: "obj-1" });
  const p2 = presentation({ id: "p-2", spaceId: "board-b", objectId: "obj-1" });
  const relation = relate([], {
    id: "r-1",
    source: "obj-1",
    target: "obj-2",
    kind: "导致",
    now: 10,
    author: "vic",
  })[0];
  const state: ObjectState = {
    objects: [obj, other],
    presentations: [p1, p2],
    relations: [relation],
  };
  assert.throws(
    () => deleteObject(state, "obj-1", { onReferenced: "refuse" }),
    (err: unknown) => {
      assert.ok(err instanceof ReferencedObjectError);
      assert.equal((err as ReferencedObjectError).id, "obj-1");
      assert.deepEqual((err as ReferencedObjectError).presentationIds, [
        "p-1",
        "p-2",
      ]);
      assert.deepEqual((err as ReferencedObjectError).relationIds, ["r-1"]);
      return true;
    },
  );
  // 拒绝时状态原样不动
  assert.equal(state.objects.length, 2);
  assert.equal(state.presentations.length, 2);
  assert.equal(state.relations.length, 1);
  // detach：移除引用后删除，并报告被移除的 id
  const result = deleteObject(state, "obj-1", { onReferenced: "detach" });
  assert.deepEqual(result.removed.presentationIds, ["p-1", "p-2"]);
  assert.deepEqual(result.removed.relationIds, ["r-1"]);
  assert.deepEqual(
    result.state.objects.map((o) => o.id),
    ["obj-2"],
  );
  assert.deepEqual(result.state.presentations, []);
  assert.deepEqual(result.state.relations, []);
  // 纯函数：传入的 state 不被改写
  assert.equal(state.objects.length, 2);
  assert.equal(state.presentations.length, 2);
  // 没有引用时可以直接删
  const lonely: ObjectState = {
    objects: [obj],
    presentations: [],
    relations: [],
  };
  const gone = deleteObject(lonely, "obj-1", { onReferenced: "refuse" });
  assert.deepEqual(gone.state.objects, []);
  assert.deepEqual(gone.removed, { presentationIds: [], relationIds: [] });
  // 目标不存在
  assert.throws(
    () => deleteObject(lonely, "missing", { onReferenced: "detach" }),
    ObjectNotFoundError,
  );
});

test("deleteObject: 只有关系引用（无展示实例）时 refuse 同样拒绝", () => {
  const obj = note("obj-1");
  const other = note("obj-2");
  const relation = relate([], {
    id: "r-1",
    source: "obj-2",
    target: "obj-1",
    kind: "支持",
    now: 10,
    author: "vic",
  })[0];
  const state: ObjectState = {
    objects: [obj, other],
    presentations: [],
    relations: [relation],
  };
  assert.throws(
    () => deleteObject(state, "obj-1", { onReferenced: "refuse" }),
    (err: unknown) => {
      assert.ok(err instanceof ReferencedObjectError);
      assert.deepEqual((err as ReferencedObjectError).presentationIds, []);
      assert.deepEqual((err as ReferencedObjectError).relationIds, ["r-1"]);
      return true;
    },
  );
  const detached = deleteObject(state, "obj-1", { onReferenced: "detach" });
  assert.deepEqual(detached.removed.relationIds, ["r-1"]);
  assert.deepEqual(detached.state.relations, []);
  assert.deepEqual(
    detached.state.objects.map((o) => o.id),
    ["obj-2"],
  );
});

test("deleteObject: 代码投影实例（旧 objectId 字段）也算引用", () => {
  const obj = note("obj-1");
  const projection = presentation({
    id: "p-legacy",
    spaceId: "board-a",
    legacyObjectId: "obj-1",
  });
  const state: ObjectState = {
    objects: [obj],
    presentations: [projection],
    relations: [],
  };
  assert.throws(
    () => deleteObject(state, "obj-1", { onReferenced: "refuse" }),
    (err: unknown) => {
      assert.ok(err instanceof ReferencedObjectError);
      assert.deepEqual((err as ReferencedObjectError).presentationIds, [
        "p-legacy",
      ]);
      return true;
    },
  );
  const detached = deleteObject(state, "obj-1", { onReferenced: "detach" });
  assert.deepEqual(detached.removed.presentationIds, ["p-legacy"]);
  assert.deepEqual(detached.state.presentations, []);
});

test("relate: status 默认 confirmed，推测关系必须显式 inferred；unlink 移除关系", () => {
  const relations = relate([], {
    id: "r-1",
    source: "obj-1",
    target: "obj-2",
    kind: "参与",
    now: 10,
    author: "vic",
  });
  assert.equal(relations.length, 1);
  assert.equal(relations[0].status, "confirmed");
  assert.equal(relations[0].kind, "参与");
  assert.equal(relations[0].createdAt, 10);
  assert.equal(relations[0].author, "vic");
  const withInferred = relate(relations, {
    id: "r-2",
    source: "obj-1",
    target: "obj-3",
    kind: "导致",
    status: "inferred",
    basis: "同名推测",
    attributes: { confidence: 0.4 },
    now: 20,
    author: "agent",
  });
  assert.equal(withInferred.length, 2);
  assert.equal(withInferred[1].status, "inferred");
  assert.equal(withInferred[1].basis, "同名推测");
  assert.deepEqual(withInferred[1].attributes, { confidence: 0.4 });
  // 纯函数：原数组不变
  assert.equal(relations.length, 1);
  // unlink
  const after = unlink(withInferred, "r-1");
  assert.deepEqual(
    after.map((r) => r.id),
    ["r-2"],
  );
  assert.equal(withInferred.length, 2);
  // 删不存在的 id 是幂等的
  assert.equal(unlink(after, "r-1").length, 1);
  // 同一 id 不静默覆盖
  assert.throws(
    () =>
      relate(withInferred, {
        id: "r-1",
        source: "a",
        target: "b",
        kind: "支持",
        now: 30,
        author: "vic",
      }),
    DuplicateRelationError,
  );
});

test("relate: attributes / evidence 写入时深拷贝，调用方改自己的输入不影响关系", () => {
  const attributes = { confidence: 0.4, tags: ["x"] };
  const evidence = [{ kind: "file" as const, uri: "a.ts" }];
  const relations = relate([], {
    id: "r-1",
    source: "obj-1",
    target: "obj-2",
    kind: "支持",
    attributes,
    evidence,
    now: 10,
    author: "vic",
  });
  assert.notEqual(relations[0].attributes, attributes);
  assert.notEqual(relations[0].evidence, evidence);
  attributes.confidence = 0.99;
  attributes.tags.push("y");
  evidence[0].uri = "b.ts";
  assert.deepEqual(relations[0].attributes, { confidence: 0.4, tags: ["x"] });
  assert.deepEqual(relations[0].evidence, [{ kind: "file", uri: "a.ts" }]);
});

test("resolveContent: 绑定对象时取对象内容，未绑定时取本地 title/data", () => {
  const obj = note("obj-1", { title: "对象标题", data: { text: "对象内容" } });
  const bound = presentation({
    id: "p-1",
    spaceId: "board-a",
    objectId: "obj-1",
    title: "过期本地标题",
    data: { view: "full" },
  });
  const resolved = resolveContent(bound, [obj]);
  assert.equal(resolved.title, "对象标题");
  assert.equal(resolved.body, "obj-1 正文");
  assert.deepEqual(resolved.data, { text: "对象内容" });
  assert.equal(resolved.objectId, "obj-1");
  assert.deepEqual(resolved.source, { origin: "human", author: "vic" });
  // 实例自身的 data 只是视图配置，不进入内容
  assert.equal((resolved.data as { view?: unknown }).view, undefined);
  // 未绑定：取本地内容
  const local = presentation({
    id: "p-2",
    spaceId: "board-a",
    title: "本地标题",
    data: { text: "本地内容" },
  });
  const localResolved = resolveContent(local, [obj]);
  assert.equal(localResolved.title, "本地标题");
  assert.deepEqual(localResolved.data, { text: "本地内容" });
  assert.equal(localResolved.objectId, undefined);
  assert.equal(localResolved.body, undefined);
  assert.equal(localResolved.source, undefined);
  // 显式声明 local 的展示实例不绑定对象
  const declared = presentation({
    id: "p-2b",
    spaceId: "board-a",
    local: true,
    title: "声明本地",
    data: { text: "本地内容" },
  });
  const declaredResolved = resolveContent(declared, [obj]);
  assert.equal(declaredResolved.objectId, undefined);
  assert.equal(declaredResolved.title, "声明本地");
  // 代码投影实例（旧 objectId 字段）同样从对象取内容
  const projection = presentation({
    id: "p-2c",
    spaceId: "board-a",
    legacyObjectId: "obj-1",
    title: "投影标题",
    data: { view: "icon" },
  });
  const projectionResolved = resolveContent(projection, [obj]);
  assert.equal(projectionResolved.objectId, "obj-1");
  assert.equal(projectionResolved.title, "对象标题");
  // 绑定指向已删除对象：回退本地内容，但保留悬空 id 以便识别引用失效
  const dangling = presentation({
    id: "p-3",
    spaceId: "board-a",
    objectId: "gone",
    title: "悬空标题",
    data: { text: "残留" },
  });
  const danglingResolved = resolveContent(dangling, [obj]);
  assert.equal(danglingResolved.objectId, "gone");
  assert.equal(danglingResolved.title, "悬空标题");
});

test("resolveContent: 返回内容快照，改快照不改对象（不能绕过 version 就地改写）", () => {
  const obj = note("obj-1", { data: { nested: { count: 1 } } });
  const bound = presentation({
    id: "p-1",
    spaceId: "board-a",
    objectId: "obj-1",
  });
  const resolved = resolveContent(bound, [obj]);
  // 内容一致
  assert.deepEqual(resolved.data, obj.data);
  // 但不是同一份引用：改快照不污染对象
  assert.notEqual(resolved.data, obj.data);
  (resolved.data as { nested: { count: number } }).nested.count = 99;
  assert.equal((obj.data as { nested: { count: number } }).nested.count, 1);
  // 未绑定时同样返回快照
  const local = presentation({
    id: "p-2",
    spaceId: "board-a",
    data: { text: "本地" },
  });
  const localResolved = resolveContent(local, [obj]);
  assert.notEqual(localResolved.data, local.data);
  (localResolved.data as { text: string }).text = "被改";
  assert.equal((local.data as { text: string }).text, "本地");
});

test("展示实例之间互不污染：改一个实例的 data 不影响另一个实例与对象", () => {
  const obj = note("obj-1", { data: { text: "对象内容" } });
  const p1 = presentation({
    id: "p-1",
    spaceId: "board-a",
    objectId: "obj-1",
    data: { view: "full", tags: ["a"] },
  });
  const p2 = presentation({
    id: "p-2",
    spaceId: "board-b",
    objectId: "obj-1",
    data: { view: "icon", tags: ["b"] },
  });
  (p1.data as { tags: string[] }).tags.push("x");
  (p1.data as { view: string }).view = "label";
  // 另一个实例不受影响
  assert.deepEqual(p2.data, { view: "icon", tags: ["b"] });
  // 对象内容不受影响
  assert.deepEqual(obj.data, { text: "对象内容" });
  // 两个实例解析出的内容仍然一致（内容来自对象，不是实例）
  assert.deepEqual(
    resolveContent(p1, [obj]).data,
    resolveContent(p2, [obj]).data,
  );
});

test("presentationsFor: 同一对象在两块白板上有两个展示实例", () => {
  const obj = note("obj-1");
  const other = note("obj-2");
  const presentations = [
    presentation({ id: "p-1", spaceId: "board-a", objectId: "obj-1" }),
    presentation({ id: "p-2", spaceId: "board-b", objectId: "obj-1" }),
    presentation({ id: "p-3", spaceId: "board-a", objectId: "obj-2" }),
    presentation({ id: "p-4", spaceId: "board-a" }),
  ];
  const found = presentationsFor([obj, other], presentations, "obj-1");
  assert.deepEqual(
    found.map((p) => p.id),
    ["p-1", "p-2"],
  );
  assert.deepEqual(
    found.map((p) => p.spaceId),
    ["board-a", "board-b"],
  );
  assert.equal(
    presentationsFor([obj, other], presentations, "obj-2").length,
    1,
  );
  assert.equal(
    presentationsFor([obj, other], presentations, "obj-x").length,
    0,
  );
  // 代码投影实例（旧字段）也算这个对象的展示
  const withProjection = [
    ...presentations,
    presentation({
      id: "p-5",
      spaceId: "board-b",
      legacyObjectId: "obj-1",
    }),
  ];
  assert.deepEqual(
    presentationsFor([obj, other], withProjection, "obj-1").map((p) => p.id),
    ["p-1", "p-2", "p-5"],
  );
  // 对象被删除后仍返回悬空展示，便于上层识别引用失效
  assert.equal(presentationsFor([], withProjection, "obj-1").length, 3);
});

test("canNest: 自嵌套与祖先嵌套拒绝，兄弟嵌套允许", () => {
  const spaces = [
    { id: "root" },
    { id: "a", parentId: "root" },
    { id: "b", parentId: "a" },
    { id: "c", parentId: "root" },
  ];
  assert.equal(canNest(spaces, "a", "a"), false);
  assert.equal(canNest(spaces, "b", "a"), false);
  assert.equal(canNest(spaces, "b", "root"), false);
  assert.equal(canNest(spaces, "c", "a"), true);
  assert.equal(canNest(spaces, "root", "a"), true);
  assert.equal(canNest(spaces, "root", "new-child"), true);
  // 环形脏数据不导致死循环
  const cyclic = [
    { id: "x", parentId: "y" },
    { id: "y", parentId: "x" },
  ];
  assert.equal(canNest(cyclic, "x", "z"), true);
});

test("综合：改对象两处都变、移动其一另一个不动、移除展示不等于删除对象", () => {
  const obj = note("obj-1", { title: "草稿", data: { text: "v1" } });
  let objects = [obj];
  let presentations = [
    presentation({ id: "p-a", spaceId: "board-a", objectId: "obj-1" }),
    presentation({ id: "p-b", spaceId: "board-b", objectId: "obj-1" }),
  ];
  // 改对象 → 两个展示内容同步（I2）
  const updated = updateObject(
    objects,
    "obj-1",
    { title: "定稿", body: "v2", data: { text: "v2" } },
    obj.version,
    100,
    "vic",
  );
  objects = objects.map((o) => (o.id === "obj-1" ? updated : o));
  assert.deepEqual(
    presentations.map((p) => resolveContent(p, objects).title),
    ["定稿", "定稿"],
  );
  assert.deepEqual(
    presentations.map((p) => resolveContent(p, objects).data),
    [{ text: "v2" }, { text: "v2" }],
  );
  // 对象 ID 不随展示实例变化（I1）
  assert.equal(objects[0].id, "obj-1");
  assert.equal(resolveContent(presentations[0], objects).objectId, "obj-1");
  // 移动其中一个展示 → 另一个不动（I2：内容共享、布局独立）
  const moved = presentations.map((p) =>
    p.id === "p-a" ? { ...p, rect: rect({ x: 900 }) } : p,
  );
  assert.equal(moved[0].rect.x, 900);
  assert.equal(moved[1].rect.x, 0);
  assert.equal(resolveContent(moved[1], objects).title, "定稿");
  // 移除一个展示 ≠ 删除对象（I3）
  const afterRemoval = moved.filter((p) => p.id !== "p-a");
  assert.equal(afterRemoval.length, 1);
  assert.equal(objects.length, 1);
  assert.equal(resolveContent(afterRemoval[0], objects).title, "定稿");
  // 移除展示后再删对象：仍被剩下的展示引用
  const state: ObjectState = {
    objects,
    presentations: afterRemoval,
    relations: [],
  };
  assert.throws(
    () => deleteObject(state, "obj-1", { onReferenced: "refuse" }),
    (err: unknown) => {
      assert.ok(err instanceof ReferencedObjectError);
      assert.deepEqual((err as ReferencedObjectError).presentationIds, ["p-b"]);
      return true;
    },
  );
  assert.equal(state.objects.length, 1);
  // 显式 detach 才连带移除引用并删除
  const removed = deleteObject(state, "obj-1", { onReferenced: "detach" });
  assert.deepEqual(removed.removed.presentationIds, ["p-b"]);
  assert.deepEqual(removed.state.objects, []);
  assert.deepEqual(removed.state.presentations, []);
});

test("I5/I6: 模块不提供按位置建关系的入口，关系变更不影响展示实例", () => {
  const exported = Object.entries(content)
    .filter(([, value]) => typeof value === "function")
    .map(([name]) => name);
  const proximity = exported.filter((name) =>
    /proximity|near|adjacent|position|auto|derive|spatial/i.test(name),
  );
  assert.deepEqual(proximity, []);
  const obj = note("obj-1");
  const p = presentation({ id: "p-1", spaceId: "board-a", objectId: "obj-1" });
  const state: ObjectState = {
    objects: [obj],
    presentations: [p],
    relations: [],
  };
  // 移动展示实例不产生关系
  const moved = [{ ...p, rect: rect({ x: 400, y: 400 }) }];
  assert.deepEqual(state.relations, []);
  // 建关系 / 删关系不改变展示实例（I6）
  const withRelation = relate(state.relations, {
    id: "r-1",
    source: "obj-1",
    target: "obj-2",
    kind: "支持",
    now: 1,
    author: "vic",
  });
  assert.deepEqual(state.presentations, [p]);
  assert.deepEqual(moved, [{ ...p, rect: rect({ x: 400, y: 400 }) }]);
  const without = unlink(withRelation, "r-1");
  assert.deepEqual(without, []);
  assert.deepEqual(state.presentations, [p]);
});
