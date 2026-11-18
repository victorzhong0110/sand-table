import assert from "node:assert/strict";
import { test } from "node:test";
import { V3Store } from "../board/data-client/store.ts";
import { createBindings } from "../board/views/bindings.ts";

const slot = {
  key: "source",
  label: "来源",
  kind: "demo.source",
  direction: "out",
  many: true,
} as const;
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("订阅只观察绑定对象、关系和包，取消后不再通知", async () => {
  let revision = 1;
  let changes: Record<string, unknown> = {};
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    if (name === "app_board")
      return {
        workspaceId: args.workspaceId ?? "a",
        revision,
        board: { id: "board", type: "base.board" },
        objects: [],
        presentations: [],
        relations: [],
        settings: [],
        packs: [],
      };
    if (name === "app_changes")
      return {
        workspaceId: "a",
        revision,
        objects: [],
        relations: [],
        settings: [],
        packs: [],
        ...changes,
      };
    if (name === "app_bindings")
      return {
        workspaceId: "a",
        revision,
        items: [{ id: "target", data: {} }],
        nextCursor: null,
      };
    throw Error(name);
  };
  const store = new V3Store(call);
  await store.load("board", { workspaceId: "a" });
  const bindings = createBindings(store, call, "reader", [slot]);
  let count = 0;
  const stop = bindings.subscribe("source", () => count++);
  await tick();
  revision++;
  changes = { objects: [{ id: "unrelated", rev: revision, deleted: false }] };
  await store.sync();
  assert.equal(count, 0);
  revision++;
  changes = { objects: [{ id: "target", rev: revision, deleted: false }] };
  await store.sync();
  assert.equal(count, 1);
  await tick();
  revision++;
  changes = {
    relations: [
      {
        id: "link",
        sourceId: "reader",
        targetId: "target",
        kind: "demo.source",
        rev: revision,
        deleted: true,
      },
    ],
  };
  await store.sync();
  assert.equal(count, 2);
  stop();
  revision++;
  changes = { packs: [{ id: "demo", rev: revision, deleted: false }] };
  await store.sync();
  assert.equal(count, 2);
  bindings.dispose();
});

test("乱序、旧修订和切换工作空间后的响应不能回填", async () => {
  const deferred: ((value: unknown) => void)[] = [];
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    if (name === "app_board")
      return {
        workspaceId: args.workspaceId,
        revision: 5,
        board: { id: "board", type: "base.board" },
        objects: [],
        presentations: [],
        relations: [],
        settings: [],
        packs: [],
      };
    if (name === "app_bindings")
      return new Promise((resolve) => deferred.push(resolve));
    throw Error(name);
  };
  const store = new V3Store(call);
  await store.load("board", { workspaceId: "a" });
  const bindings = createBindings(store, call, "reader", [slot]);
  const old = bindings.read("source");
  const latest = bindings.read("source");
  deferred[1]!({ workspaceId: "a", revision: 5, items: [], nextCursor: null });
  assert.equal((await latest).revision, 5);
  deferred[0]!({ workspaceId: "a", revision: 5, items: [], nextCursor: null });
  await assert.rejects(old, /过期/);
  const outdated = bindings.read("source");
  deferred[2]!({ workspaceId: "a", revision: 4, items: [], nextCursor: null });
  await assert.rejects(outdated, /过期/);
  const switched = bindings.read("source");
  await store.load("board", { workspaceId: "b" });
  deferred[3]!({ workspaceId: "a", revision: 5, items: [], nextCursor: null });
  await assert.rejects(switched, /过期/);
  await assert.rejects(bindings.read("source"), /过期/);
});

test("读取组件的包被停用时释放会话", async () => {
  let revision = 1;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    if (name === "app_board")
      return {
        workspaceId: args.workspaceId,
        revision,
        board: { id: "board", type: "base.board" },
        objects: [
          { id: "reader", type: "demo.reader", rev: 1, deleted: false },
        ],
        presentations: [{ id: "p", objectId: "reader", boardId: "board" }],
        relations: [],
        settings: [],
        packs: [],
      };
    if (name === "app_changes")
      return {
        workspaceId: "a",
        revision,
        objects: [],
        relations: [],
        settings: [],
        packs: [{ id: "demo", enabled: false, deleted: false, rev: revision }],
      };
    if (name === "app_bindings")
      return { workspaceId: "a", revision, items: [], nextCursor: null };
    throw Error(name);
  };
  const store = new V3Store(call);
  await store.load("board", { workspaceId: "a" });
  const bindings = createBindings(store, call, "reader", [slot]);
  bindings.subscribe("source", () => {});
  await tick();
  revision++;
  await store.sync();
  await assert.rejects(bindings.read("source"), /过期/);
});
