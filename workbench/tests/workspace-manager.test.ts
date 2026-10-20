// 多工作空间管理器的测试。契约见 docs/architecture/workspace-management.zh-CN.md 第 3、5 节。
// 覆盖不变量 J6–J8，以及管理器的其余操作。
// 只用 node 内置模块；node --experimental-strip-types --test tests/workspace-manager.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WorkspaceManager } from "../core/workspace-manager.ts";
import type { WorkspaceHost } from "../core/workspace-manager.ts";
import {
  WorkspaceConflictError,
  WorkspaceIdError,
  WorkspaceNotFoundError,
} from "../core/workspace.ts";
import { WorkspaceLockError } from "../core/workspace-lock.ts";
import type { TestContext } from "node:test";

const tempRoot = (t: TestContext): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sand-wsm-"));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
};

/**
 * 假宿主：记录调用顺序，并模拟「运行期改了内容」与「落盘」。
 *
 * 宿主端口只有四个能力（当前 id / flush / restore / attach），
 * 真实接线由负责人接到 core/store.ts 的 BoardStore 上。
 */
const makeHost = (manager: WorkspaceManager) => {
  const calls: string[] = [];
  /** 每个工作空间「运行期」的当前内容。 */
  const memory = new Map<string, string>();
  const state = {
    current: undefined as string | undefined,
    /** 让 flush 失败：模拟磁盘满。 */
    failFlush: false,
  };
  const host: WorkspaceHost = {
    currentWorkspaceId: () => state.current,
    flush: () => {
      calls.push("flush");
      if (state.failFlush)
        throw new Error("ENOSPC: 磁盘满，当前工作空间没能落盘");
      const id = state.current;
      const text = id ? memory.get(id) : undefined;
      if (!id || text === undefined) throw new Error("没有可保存的内容");
      fs.writeFileSync(manager.store.mainPath(id), text);
    },
    restore: (snapshot) => {
      calls.push(`restore:${snapshot.id}`);
      memory.set(snapshot.id, JSON.stringify(snapshot));
    },
    attach: (id) => {
      calls.push(`attach:${id}`);
      state.current = id;
    },
  };
  return { host, calls, memory, state };
};

test("list：列出根目录下的工作空间，带上板数与对象数", async (t) => {
  const root = tempRoot(t);
  const manager = new WorkspaceManager({ root });
  const alpha = manager.create({ id: "alpha", title: "小说" });
  await manager.save(alpha);
  const beta = manager.create({ id: "beta", title: "代码" });
  await manager.save(beta);

  const result = manager.list();
  assert.equal(result.workspaces.length, 2);
  assert.equal(result.errors.length, 0);
  const alphaEntry = result.workspaces.find((w) => w.id === "alpha")!;
  assert.equal(alphaEntry.title, "小说");
  assert.equal(alphaEntry.boardCount, 0);
  assert.equal(alphaEntry.objectCount, 0);
  assert.equal(alphaEntry.revision, 0);
  assert.ok(alphaEntry.dir?.endsWith("alpha"));
});

test("J8：列表里单个损坏的工作空间不影响其他条目", async (t) => {
  const root = tempRoot(t);
  const manager = new WorkspaceManager({ root });
  await manager.save(manager.create({ id: "alpha", title: "好的" }));
  await manager.save(manager.create({ id: "beta", title: "也是好的" }));
  // 一个坏掉的工作空间。
  fs.mkdirSync(path.join(root, "broken"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "broken", "workspace.json"),
    "{ 这不是 JSON",
  );

  const result = manager.list();
  assert.equal(result.workspaces.length, 2, "其余条目照常列出");
  assert.deepEqual(result.workspaces.map((w) => w.id).sort(), [
    "alpha",
    "beta",
  ]);
  assert.equal(result.errors.length, 1, "坏的要被点名");
  assert.equal(result.errors[0].id, "broken");
  assert.match(result.errors[0].reason, /读不出来/);
});

test("create：id 非法或已存在都要抛错，且新建本身不落盘", async (t) => {
  const root = tempRoot(t);
  const manager = new WorkspaceManager({ root });
  assert.throws(
    () => manager.create({ id: "../越界", title: "坏的" }),
    WorkspaceIdError,
  );
  await manager.save(manager.create({ id: "alpha", title: "小说" }));
  assert.throws(
    () => manager.create({ id: "alpha", title: "重名" }),
    WorkspaceConflictError,
  );

  // 新建不落盘：显式 save 之后才出现在列表里。
  const gamma = manager.create({ id: "gamma", title: "还没落盘" });
  assert.equal(manager.list().workspaces.length, 1);
  await manager.save(gamma);
  assert.equal(manager.list().workspaces.length, 2);
});

test("open：读出工作空间内容；不存在要抛 WorkspaceNotFoundError", async (t) => {
  const root = tempRoot(t);
  const manager = new WorkspaceManager({ root });
  await manager.save(manager.create({ id: "alpha", title: "小说" }));
  const opened = manager.open("alpha");
  assert.equal(opened.workspace.title, "小说");
  assert.equal(opened.recovered, false);
  assert.throws(() => manager.open("nope"), WorkspaceNotFoundError);
});

test("rename：改标题并落盘；不存在要抛错", async (t) => {
  const root = tempRoot(t);
  const manager = new WorkspaceManager({ root });
  await manager.save(manager.create({ id: "alpha", title: "旧标题" }));
  const renamed = await manager.rename("alpha", "  新标题  ");
  assert.equal(renamed.title, "新标题", "标题要 trim");
  assert.equal(manager.open("alpha").workspace.title, "新标题");
  await assert.rejects(
    () => manager.rename("nope", "标题"),
    WorkspaceNotFoundError,
  );
});

test("delete：删掉整个工作空间目录", async (t) => {
  const root = tempRoot(t);
  const manager = new WorkspaceManager({ root });
  await manager.save(manager.create({ id: "alpha", title: "小说" }));
  const dir = manager.store.workspaceDir("alpha");
  fs.mkdirSync(path.join(dir, "attachments"), { recursive: true });
  fs.writeFileSync(path.join(dir, "attachments", "note.txt"), "附件");
  fs.writeFileSync(path.join(dir, "workspace.json.bak"), "{}");

  await manager.delete("alpha");
  assert.ok(!fs.existsSync(dir), "目录要整个没了");
  assert.equal(manager.list().workspaces.length, 0);
  await assert.rejects(() => manager.delete("alpha"), WorkspaceNotFoundError);
});

test("delete：被别的进程持锁时拒绝，并说明是谁在占用", async (t) => {
  const root = tempRoot(t);
  const manager = new WorkspaceManager({
    root,
    lock: { host: "machine-a", isProcessAlive: () => true },
  });
  await manager.save(manager.create({ id: "alpha", title: "小说" }));
  const dir = manager.store.workspaceDir("alpha");
  fs.writeFileSync(
    path.join(dir, "workspace.lock"),
    JSON.stringify({
      pid: 4242,
      host: "machine-a",
      at: Date.now() - 5000,
      workspaceId: "alpha",
    }),
  );

  await assert.rejects(
    () => manager.delete("alpha"),
    (error: unknown) => {
      assert.ok(error instanceof WorkspaceLockError);
      const message = (error as Error).message;
      assert.match(message, /pid 4242/, "要说明是谁在占用");
      assert.match(message, /删除被拒绝/);
      return true;
    },
  );
  assert.ok(fs.existsSync(dir), "被拒绝时不能删东西");
});

test("delete：持有者已经不在了（孤儿锁）时不挡路", async (t) => {
  const root = tempRoot(t);
  const manager = new WorkspaceManager({
    root,
    lock: { host: "machine-a", isProcessAlive: () => false },
  });
  await manager.save(manager.create({ id: "alpha", title: "小说" }));
  const dir = manager.store.workspaceDir("alpha");
  fs.writeFileSync(
    path.join(dir, "workspace.lock"),
    JSON.stringify({
      pid: 4242,
      host: "machine-a",
      at: Date.now() - 5000,
      workspaceId: "alpha",
    }),
  );
  await manager.delete("alpha");
  assert.ok(!fs.existsSync(dir));
});

test("J6：切换工作空间前先落盘当前内容——改内容→切换→切回来，内容还在", async (t) => {
  const root = tempRoot(t);
  const probe = new WorkspaceManager({ root });
  const { host, calls, memory, state } = makeHost(probe);
  const manager = new WorkspaceManager({ root, host });

  const alpha = manager.create({ id: "alpha", title: "甲" });
  await manager.save(alpha);
  const beta = manager.create({ id: "beta", title: "乙" });
  await manager.save(beta);

  state.current = "alpha";
  // 运行期在 alpha 上改了内容。
  memory.set("alpha", JSON.stringify({ ...alpha, title: "甲（改过）" }));

  await manager.switch("beta");
  assert.deepEqual(
    calls,
    ["flush", "restore:beta", "attach:beta"],
    "顺序必须是先落盘、再加载、最后换绑",
  );
  assert.equal(state.current, "beta");

  // 切回去：内容还在。
  await manager.switch("alpha");
  assert.equal(manager.open("alpha").workspace.title, "甲（改过）");
});

test("J7：落盘失败时切换中止，活动工作空间不变", async (t) => {
  const root = tempRoot(t);
  const probe = new WorkspaceManager({ root });
  const { host, calls, state } = makeHost(probe);
  const manager = new WorkspaceManager({ root, host });

  await manager.save(manager.create({ id: "alpha", title: "甲" }));
  await manager.save(manager.create({ id: "beta", title: "乙" }));
  state.current = "alpha";
  state.failFlush = true;

  await assert.rejects(() => manager.switch("beta"), /磁盘满/);
  assert.equal(state.current, "alpha", "活动工作空间没变");
  assert.ok(
    !calls.some((c) => c.startsWith("attach:")),
    "不能换绑到新工作空间",
  );
  assert.ok(!calls.includes("restore:beta"), "不能加载目标工作空间");
});

test("J7：目标工作空间不存在时切换中止，活动工作空间不变", async (t) => {
  const root = tempRoot(t);
  const probe = new WorkspaceManager({ root });
  const { host, calls, memory, state } = makeHost(probe);
  const manager = new WorkspaceManager({ root, host });
  const alpha = manager.create({ id: "alpha", title: "甲" });
  await manager.save(alpha);
  state.current = "alpha";
  memory.set("alpha", JSON.stringify(alpha));

  await assert.rejects(() => manager.switch("nope"), WorkspaceNotFoundError);
  assert.equal(state.current, "alpha", "活动工作空间没变");
  assert.ok(!calls.some((c) => c.startsWith("attach:")));
});

test("switch：没有宿主端口时明确拒绝，而不是假装切了", async (t) => {
  const root = tempRoot(t);
  const manager = new WorkspaceManager({ root });
  await manager.save(manager.create({ id: "alpha", title: "甲" }));
  await assert.rejects(() => manager.switch("alpha"), /宿主端口/);
});
