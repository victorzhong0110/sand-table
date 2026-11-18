import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServerV3 } from "../server/server.ts";
import { resultData } from "../board/data-client/results.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyCommands,
  createRegistry,
  openWorkspace,
  readObjects,
  undo,
  exportWorkspaceBundle,
  importWorkspaceBundle,
  isResourceRef,
  type Command,
  type ObjectSource,
} from "../kernel/index.ts";
import { builtinPacks } from "../packs/index.ts";
import {
  boardNamespace,
  createBoardProvider,
  BOARD_PROVIDER_ID,
} from "../resources/board-provider.ts";
import {
  createResourceRegistry,
  registerResourceEffect,
} from "../resources/registry.ts";
import { createResourceTools } from "../server/resource-tools.ts";
import type {
  ResourceProvider,
  ResourceRead,
  ResourceRef,
} from "../resources/types.ts";

const actor = { id: "resource-test", kind: "human" as const };
const ref: ResourceRef = {
  providerId: "drawing",
  namespace: "workspace-a",
  resourceId: "scene-1",
  revision: "rev-2",
  anchor: "element-3",
};
function registry() {
  const value = createRegistry();
  for (const pack of builtinPacks) value.registerPack(pack, "builtin");
  return value;
}
function setup() {
  const root = mkdtempSync(join(tmpdir(), "sand-resource-"));
  const types = registry();
  const opened = openWorkspace(root, "a", types);
  const session = { root, workspaceId: "a", registry: types, db: opened.db };
  const write = (commands: Command[]) =>
    applyCommands(session.db, types, { actor, commands });
  return {
    root,
    session,
    write,
    close() {
      session.db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
const available = (target: ResourceRef): ResourceRead => ({
  status: "available",
  ref: target,
  revision: target.revision ?? "current",
  title: "原图",
  summary: "原插件的有界摘要",
  capabilities: { read: true, open: true },
});
function provider(namespace = ref.namespace): ResourceProvider {
  return {
    describe: () => ({
      providerId: ref.providerId,
      namespace,
      title: "图形插件",
      capabilities: { read: true },
      idempotency: "none",
    }),
    read: available,
  };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("资源身份的字段边界、旧来源和互斥绑定统一检查", () => {
  const s = setup();
  try {
    for (const [field, max] of [
      ["providerId", 128],
      ["namespace", 512],
      ["resourceId", 512],
      ["revision", 256],
      ["anchor", 2048],
    ] as const) {
      assert.equal(isResourceRef({ ...ref, [field]: "x".repeat(max) }), true);
      assert.equal(
        isResourceRef({ ...ref, [field]: "x".repeat(max + 1) }),
        false,
      );
      assert.equal(isResourceRef({ ...ref, [field]: "" }), false);
    }
    for (const bad of [
      { ...ref, namespace: undefined },
      { ...ref, path: "/tmp/x" },
      { ...ref, revision: 2 },
    ]) {
      assert.throws(
        () =>
          s.write([
            {
              op: "object.create",
              type: "base.resource_reference",
              source: { origin: "human", resource: bad } as ObjectSource,
            },
          ]),
        /资源引用/,
      );
    }
    assert.throws(
      () =>
        s.write([
          {
            op: "object.create",
            type: "base.resource_reference",
            source: {
              origin: "human",
              resource: ref,
              external: { kind: "url", uri: "https://example.com" },
            },
          },
        ]),
      /同时绑定/,
    );
    const result = s.write([
      {
        op: "object.create",
        ref: "old",
        type: "base.note",
        source: { origin: "human" },
      },
      {
        op: "object.create",
        ref: "reference",
        type: "base.resource_reference",
        data: { note: "我的说明" },
        source: { origin: "human", resource: ref },
      },
    ]);
    const rows = readObjects(
      s.session.db,
      s.session.registry,
      [result.created.old, result.created.reference],
      {},
    ).objects;
    assert.equal(rows[0].source?.resource, undefined);
    assert.deepEqual(rows[1].source?.resource, ref);
    assert.throws(() =>
      s.write([
        {
          op: "object.create",
          type: "base.resource_reference",
          data: { resource: ref },
        },
      ]),
    );
    const version = rows[1].version;
    s.write([
      {
        op: "object.update",
        id: rows[1].id,
        expectedVersion: version,
        source: { origin: "human", resource: { ...ref, revision: "rev-3" } },
      },
    ]);
    assert.throws(
      () =>
        s.write([
          {
            op: "object.update",
            id: rows[1].id,
            expectedVersion: version,
            source: { origin: "human", resource: ref },
          },
        ]),
      /变化|版本|修改/,
    );
    undo(s.session.db, actor);
    assert.deepEqual(
      readObjects(s.session.db, s.session.registry, [rows[1].id], {}).objects[0]
        .source?.resource,
      ref,
    );
  } finally {
    s.close();
  }
});

test("保存重开与 T25 往返保留引用身份，导入拒绝双绑定且不安装提供者", async () => {
  const s = setup();
  try {
    const id = s.write([
      {
        op: "object.create",
        ref: "r",
        type: "base.resource_reference",
        data: { note: "本地说明" },
        source: { origin: "imported", resource: ref },
      },
    ]).created.r;
    const bundle = exportWorkspaceBundle(s.session.db);
    s.session.db.close();
    s.session.db = openWorkspace(s.root, "a", s.session.registry).db;
    assert.deepEqual(
      readObjects(s.session.db, s.session.registry, [id], {}).objects[0].source
        ?.resource,
      ref,
    );
    const report = importWorkspaceBundle(s.root, registry(), bundle.json);
    const imported = openWorkspace(s.root, report.workspaceId, registry());
    try {
      assert.deepEqual(
        readObjects(imported.db, registry(), [id], {}).objects[0].source
          ?.resource,
        ref,
      );
    } finally {
      imported.db.close();
    }
    const broken = JSON.parse(bundle.json);
    broken.objects.find(
      (row: { id: string }) => row.id === id,
    ).source.external = { kind: "url", uri: "https://example.com" };
    assert.throws(
      () => importWorkspaceBundle(s.root, registry(), JSON.stringify(broken)),
      /同时绑定/,
    );
    const resources = createResourceRegistry();
    assert.equal((await resources.read(ref)).status, "provider_missing");
    resources.dispose();
  } finally {
    s.close();
  }
});

test("注册生命周期、namespace 隔离与固定版本不回退", async () => {
  const r = createResourceRegistry();
  const p = provider();
  assert.equal((await r.read(ref)).status, "provider_missing");
  let cleanup: () => void = () => {};
  registerResourceEffect(
    {
      effect: (fn) => {
        cleanup = fn();
      },
    },
    r,
    p,
  );
  assert.equal((await r.read(ref)).status, "available");
  assert.equal(
    (await r.read({ ...ref, namespace: "other" })).status,
    "provider_missing",
  );
  cleanup();
  assert.equal((await r.read(ref)).status, "provider_missing");
  r.register({
    ...p,
    read: (target) => ({ ...available(target), revision: "newer" }),
  });
  assert.equal((await r.read(ref)).status, "version_unavailable");
  r.dispose();
  r.register(p);
  assert.equal((await r.read(ref)).status, "available");
  r.dispose();
});

test("提供者停用与重装拒绝旧响应；切换工作区释放订阅", async () => {
  const r = createResourceRegistry();
  let complete: (value: ResourceRead) => void = () => {};
  let unsubscribed = 0;
  const p = {
    ...provider(),
    read: () =>
      new Promise<ResourceRead>((resolve) => {
        complete = resolve;
      }),
    subscribe: () => () => {
      unsubscribed++;
    },
  };
  const remove = r.register(p);
  const values: ResourceRead[] = [];
  const stop = r.watch(ref, (value) => values.push(value));
  const old = complete;
  remove();
  r.register(p);
  old(available(ref));
  await tick();
  assert.equal(
    values.some((value) => value.status === "available"),
    false,
  );
  stop();
  assert.equal(unsubscribed, 2);
  complete(available(ref));
  await tick();
  assert.equal(
    values.some((value) => value.status === "available"),
    false,
  );
  r.dispose();
});

test("默认白板提供者复用版本、命令、撤销；操作编号去重不等同 intentId", async () => {
  const s = setup();
  try {
    const id = s.write([
      {
        op: "object.create",
        ref: "n",
        type: "base.note",
        data: { body: "原文" },
      },
    ]).created.n;
    const native: ResourceRef = {
      providerId: BOARD_PROVIDER_ID,
      namespace: boardNamespace(s.root, "a"),
      resourceId: id,
    };
    const p = createBoardProvider({
      ...s.session,
      namespace: native.namespace,
    });
    assert.equal(p.describe().idempotency, "process");
    assert.equal(
      (await p.read({ ...native, namespace: "b" })).status,
      "forbidden",
    );
    assert.equal(
      (await p.read({ ...native, revision: "999" })).status,
      "version_unavailable",
    );
    const original = await p.read(native);
    assert.equal(original.status, "available");
    const request = {
      operationId: "edit-1",
      expectedRevision: "1",
      actor,
      operation: { set: { body: "新正文" } },
    };
    const resources = createResourceRegistry();
    resources.register(p);
    const first = await resources.edit(native, request);
    assert.deepEqual(
      await resources.edit(native, {
        ...request,
        operation: { ...request.operation },
      }),
      first,
    );
    resources.dispose();
    assert.equal(
      readObjects(s.session.db, s.session.registry, [id], {}).objects[0]
        .version,
      2,
    );
    await assert.rejects(
      async () => p.edit!(native, { ...request, operation: { title: "异参" } }),
      /同一操作编号/,
    );
    undo(s.session.db, actor);
    assert.equal(
      readObjects(s.session.db, s.session.registry, [id], {}).objects[0].data
        .body,
      "原文",
    );
    await p.edit!(native, request);
    assert.equal(
      readObjects(s.session.db, s.session.registry, [id], {}).objects[0].data
        .body,
      "原文",
    );
  } finally {
    s.close();
  }
});

test("UI 和 Agent 从保存的引用解析同一版本，不接受客户端任意 locator", async () => {
  const s = setup();
  try {
    const id = s.write([
      {
        op: "object.create",
        ref: "r",
        type: "base.resource_reference",
        source: { origin: "human", resource: ref },
      },
    ]).created.r;
    const resources = createResourceTools(() => s.session);
    const remove = resources.register(provider());
    const args = {
      objectId: id,
      expectedVersion: 1,
      workspaceId: "a",
      action: "read" as const,
    };
    const ui = await resources.request(args);
    const agent = await resources.request({ objectId: id, action: "read" });
    assert.deepEqual(agent, ui);
    await assert.rejects(
      () => resources.request({ ...args, workspaceId: "other" }),
      /工作空间已切换/,
    );
    remove();
    const missing = await resources.request(args);
    assert.equal(
      "value" in missing && missing.value.status,
      "provider_missing",
    );
    assert.deepEqual(resources.binding(id).ref, ref);
    resources.dispose();
  } finally {
    s.close();
  }
});

test("资源打开拒绝可执行 URL 和跨资源回应", async () => {
  const r = createResourceRegistry();
  const p = provider();
  r.register({
    ...p,
    open: (target) => ({
      status: "available",
      ref: target,
      revision: target.revision!,
      route: { kind: "url", url: "javascript:alert(1)" },
    }),
  });
  assert.equal((await r.open(ref)).status, "forbidden");
  r.dispose();
  r.register({
    ...p,
    read: (target) => available({ ...target, resourceId: "another" }),
  });
  assert.equal((await r.read(ref)).status, "forbidden");
  r.dispose();
});

test("真实 MCP 工具面为 Agent 和 UI 返回同一引用快照", async () => {
  const root = mkdtempSync(join(tmpdir(), "sand-resource-mcp-"));
  const created = createServerV3({ workspaceRoot: root, workspaceId: "mcp" });
  const client = new Client({ name: "resource-protocol-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), created.server.connect(b)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const value = await client.callTool({ name, arguments: args });
    assert.ok(!value.isError, JSON.stringify(value));
    return resultData(value);
  };
  try {
    const remove = created.resources.register(provider());
    const changed = await call("app_edit", {
      commands: [
        {
          op: "object.create",
          ref: "r",
          type: "base.resource_reference",
          data: { note: "本地" },
          source: { origin: "human", resource: ref },
        },
      ],
    });
    const id = changed.created.r;
    const ui = await call("app_resource", {
      objectId: id,
      expectedVersion: 1,
      workspaceId: "mcp",
      action: "read",
    });
    const model = await call("sand_read", {
      ids: [id],
      resolveResources: true,
    });
    assert.deepEqual(model.resources[0].resource, ui);
    assert.equal(ui.value.status, "available");
    remove();
    assert.equal(
      (
        await call("app_resource", {
          objectId: id,
          expectedVersion: 1,
          workspaceId: "mcp",
          action: "read",
        })
      ).value.status,
      "provider_missing",
    );
    const bad = await client.callTool({
      name: "app_resource",
      arguments: {
        objectId: id,
        expectedVersion: 999,
        workspaceId: "mcp",
        action: "read",
        ref: { ...ref, resourceId: "private" },
      },
    });
    assert.equal(bad.isError, true);
  } finally {
    await client.close();
    created.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("资源响应到达前切换工作空间或改绑会被拒绝", async () => {
  const s = setup();
  const other = openWorkspace(s.root, "b", s.session.registry);
  let current = s.session;
  const service = createResourceTools(() => current);
  let complete: (v: ResourceRead) => void = () => {};
  try {
    const id = s.write([
      {
        op: "object.create",
        ref: "r",
        type: "base.resource_reference",
        source: { origin: "human", resource: ref },
      },
    ]).created.r;
    service.register({
      ...provider(),
      read: () =>
        new Promise<ResourceRead>((resolve) => {
          complete = resolve;
        }),
    });
    const reading = service.request({
      objectId: id,
      expectedVersion: 1,
      workspaceId: "a",
      action: "read",
    });
    current = { ...s.session, workspaceId: "b", db: other.db };
    service.sync();
    complete(available(ref));
    await assert.rejects(() => reading, /不存在|变化|工作空间/);
    current = s.session;
    service.sync();
    const rebound = service.request({
      objectId: id,
      expectedVersion: 1,
      workspaceId: "a",
      action: "read",
    });
    s.write([
      {
        op: "object.update",
        id,
        expectedVersion: 1,
        source: {
          origin: "human",
          resource: { ...ref, resourceId: "other-scene" },
        },
      },
    ]);
    complete(available(ref));
    await assert.rejects(() => rebound, /变化/);
  } finally {
    service.dispose();
    other.db.close();
    s.close();
  }
});
