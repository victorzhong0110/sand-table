// v3 界面数据缓存的守护：工作空间隔离与过期响应。
//
// 用注入假 tool 的方式测 store（不起真服务，快且稳）。
// 判据来自 T21 卡片的「交接与边界验收」：
// 切工作空间时旧库的内容一条都不能留下，在途的响应不能把新库的修订号带偏。

import assert from "node:assert/strict";
import { test } from "node:test";
import { V3Store } from "../board/v3/store.ts";

const objectRow = (id: string, rev: number) => ({
  id,
  type: "base.note",
  typeVersion: 1,
  title: id,
  data: {},
  source: null,
  version: 1,
  createdAt: 0,
  createdBy: "human",
  updatedAt: 0,
  updatedBy: "human",
  rev,
  deleted: false,
});

const presentationRow = (
  id: string,
  boardId: string,
  objectId: string,
  rev: number,
) => ({
  id,
  boardId,
  objectId,
  parentId: null,
  x: 0,
  y: 0,
  width: 280,
  height: 180,
  z: 0,
  locked: false,
  appearance: {},
  version: 1,
  updatedAt: 0,
  updatedBy: "human",
  rev,
  deleted: false,
});

const boardContents = (
  boardId: string,
  workspaceId: string,
  revision: number,
  objects: unknown[],
  presentations: unknown[],
) => ({
  revision,
  board: { ...(objectRow(boardId, revision) as object), type: "base.board" },
  objects,
  presentations,
  relations: [],
  settings: [],
  packs: [],
  workspaceId,
});

const changes = (
  workspaceId: string,
  revision: number,
  objects: unknown[] = [],
  presentations: unknown[] = [],
) => ({
  revision,
  objects,
  presentations,
  relations: [],
  settings: [],
  packs: [],
  workspaceId,
});

/** 一个能自己决定什么时候兑现的响应。 */
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

test("切工作空间后旧库的对象与展示一条都不留在缓存里", async () => {
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    if (name !== "app_board") throw Error("不该调这个工具：" + name);
    if (args.boardId === "boardA")
      return boardContents(
        "boardA",
        "wsA",
        5,
        [objectRow("oA", 5)],
        [presentationRow("pA", "boardA", "oA", 5)],
      );
    return boardContents(
      "boardB",
      "wsB",
      2,
      [objectRow("oB", 2)],
      [presentationRow("pB", "boardB", "oB", 2)],
    );
  };
  const store = new V3Store(tool);
  await store.load("boardA", { workspaceId: "wsA" });
  assert.equal(store.cache.objects.has("oA"), true);
  await store.load("boardB", { workspaceId: "wsB" });
  assert.equal(
    store.cache.objects.has("oA"),
    false,
    "旧工作空间的对象不该留下",
  );
  assert.equal(
    store.cache.presentations.has("pA"),
    false,
    "旧工作空间的展示不该留下",
  );
  assert.equal(store.cache.objects.has("oB"), true);
  assert.equal(store.cache.revision, 2);
});

test("请求要带上工作空间编号", async () => {
  const seen: Record<string, unknown>[] = [];
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    seen.push({ name, ...args });
    if (name === "app_board") return boardContents("boardA", "wsA", 1, [], []);
    return changes("wsA", 1);
  };
  const store = new V3Store(tool);
  await store.load("boardA", { workspaceId: "wsA" });
  await store.sync();
  assert.equal(seen[0].workspaceId, "wsA", "app_board 要带工作空间编号");
  assert.equal(seen[1].workspaceId, "wsA", "app_changes 要带工作空间编号");
  assert.equal(seen[1].since, 1, "增量要从当前修订号开始");
});

test("旧工作空间在途的增量不并进新库，也不带偏修订号", async () => {
  const inFlight = deferred<unknown>();
  let phase: "a" | "b" = "a";
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    if (name === "app_board") {
      if (args.boardId === "boardA")
        return boardContents(
          "boardA",
          "wsA",
          5,
          [objectRow("oA", 5)],
          [presentationRow("pA", "boardA", "oA", 5)],
        );
      return boardContents(
        "boardB",
        "wsB",
        2,
        [objectRow("oB", 2)],
        [presentationRow("pB", "boardB", "oB", 2)],
      );
    }
    if (name === "app_changes") {
      /* 切库之前发出去的那条：在旧库上一直挂着。 */
      if (phase === "a") return inFlight.promise;
      return changes("wsB", 3, [objectRow("oB2", 3)]);
    }
    throw Error("不该调这个工具：" + name);
  };
  const store = new V3Store(tool);
  await store.load("boardA", { workspaceId: "wsA" });
  const pending = store.sync();
  phase = "b";
  await store.load("boardB", { workspaceId: "wsB" });
  /* 旧库的在途增量这时才回来。 */
  inFlight.resolve(changes("wsA", 105, [objectRow("oA-LATE", 105)]));
  await pending;
  assert.equal(
    store.cache.objects.has("oA-LATE"),
    false,
    "旧工作空间的行不该合进新库",
  );
  assert.equal(
    store.cache.objects.has("oA"),
    false,
    "旧工作空间的对象不该留下",
  );
  assert.equal(store.cache.revision, 2, "修订号不该被旧库带偏");
  /* 切完之后新工作空间的增量要能收到。 */
  const changed = await store.sync();
  assert.equal(changed, true, "新工作空间的增量要能收到");
  assert.equal(store.cache.objects.has("oB2"), true);
  assert.equal(store.cache.revision, 3);
});

test("同一个工作空间里连续装载两次，先发出去的那条响应要丢掉", async () => {
  const inFlight = deferred<unknown>();
  let boards = 0;
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    if (name === "app_board") {
      boards += 1;
      /* 第一次装载卡住，第二次先回来。 */
      if (boards === 1) return inFlight.promise;
      return boardContents(
        "boardA",
        "wsA",
        7,
        [objectRow("oA", 7)],
        [presentationRow("pA", "boardA", "oA", 7)],
      );
    }
    if (name === "app_changes") return changes("wsA", 8, [objectRow("oA2", 8)]);
    throw Error("不该调这个工具：" + name);
  };
  const store = new V3Store(tool);
  const first = store.load("boardA", { workspaceId: "wsA" });
  const second = store.load("boardA", { workspaceId: "wsA" });
  await second;
  /* 第一次装载的响应这时才回来：它是上一轮的，丢掉。 */
  inFlight.resolve(
    boardContents(
      "boardA",
      "wsA",
      3,
      [objectRow("oA-OLD", 3)],
      [presentationRow("pA-OLD", "boardA", "oA-OLD", 3)],
    ),
  );
  await first;
  assert.equal(
    store.cache.objects.has("oA-OLD"),
    false,
    "过期的一轮装载不该把内容合进来",
  );
  assert.equal(store.cache.objects.has("oA"), true);
  assert.equal(store.cache.revision, 7, "修订号该是最后一次装载的");
});

test("同一个工作空间里进子白板再回来，父白板的对象仍然在", async () => {
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    if (name !== "app_board") throw Error("不该调这个工具：" + name);
    if (args.boardId === "boardSub")
      return boardContents(
        "boardSub",
        "wsA",
        4,
        [objectRow("oSub", 4)],
        [presentationRow("pSub", "boardSub", "oSub", 4)],
      );
    return boardContents(
      "boardA",
      "wsA",
      5,
      [objectRow("oA", 5)],
      [presentationRow("pA", "boardA", "oA", 5)],
    );
  };
  const store = new V3Store(tool);
  await store.load("boardA", { workspaceId: "wsA" });
  await store.load("boardSub", { workspaceId: "wsA" });
  assert.equal(
    store.cache.objects.has("oA"),
    true,
    "进子白板以后父白板的对象要留着",
  );
  assert.equal(store.cache.objects.has("oSub"), true);
  assert.equal(store.cache.boardId, "boardSub");
});

test("服务端回带的工作空间编号对不上时，那条响应要丢掉", async () => {
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    if (name === "app_board") return boardContents("boardA", "wsA", 1, [], []);
    if (name === "app_changes")
      /* 服务端说这是另一个工作空间的结果。 */
      return {
        ...changes("wsOTHER", 99, [objectRow("oX", 99)]),
        workspaceId: "wsOTHER",
      };
    throw Error("不该调这个工具：" + name);
  };
  const store = new V3Store(tool);
  await store.load("boardA", { workspaceId: "wsA" });
  const changed = await store.sync();
  assert.equal(changed, false, "别的工作空间的增量不该合进来");
  assert.equal(store.cache.objects.has("oX"), false);
  assert.equal(store.cache.revision, 1, "修订号不该被别的工作空间带偏");
});

test("客户端不知道工作空间编号时，响应不该被丢掉，编号要学过来", async () => {
  const seen: Record<string, unknown>[] = [];
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    seen.push({ name, ...args });
    if (name === "app_board")
      return boardContents("boardA", "wsA", 1, [objectRow("oA", 1)], []);
    return changes("wsA", 2, [objectRow("oA2", 2)]);
  };
  const store = new V3Store(tool);
  /* 客户端一开始不知道工作空间编号（服务端还没回带过）。 */
  await store.load("boardA");
  const changed = await store.sync();
  assert.equal(changed, true, "服务端回带了编号的响应不该被丢掉");
  assert.equal(store.cache.objects.has("oA2"), true);
  assert.equal(store.workspaceId, "wsA", "服务端回带的编号要学过来");
  /* 学过来之后，后续请求就带上它了。 */
  await store.sync();
  assert.equal(seen.at(-1)?.workspaceId, "wsA", "后面的请求要带上工作空间编号");
});
