// 跨进程包启停的测试。
//
// 契约：docs/kernel-v3/tasks/T74-existing-contract-backfill.md 第 5 条与验收第 2 条，
// 以及 05-delivery-contracts.md §3（运行状态由各自内核接口写，不进作品撤销）。
//
// 场景：两个进程打开同一个工作空间库。A 停掉一个包，B 这边的工具列表
// 必须在 2 秒内跟着变；重新启用要恢复。B 靠每秒读一次 packs 的修订号发现变化，
// 不靠本进程的写入回调——所以这里 A 必须是另一个进程。

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServerV3 } from "../server/v3/server.ts";
import { basePack } from "../packs/base/index.ts";
import type { PackSpec } from "../kernel/index.ts";

const KERNEL = fileURLToPath(new URL("../kernel/index.ts", import.meta.url));
const PACKS = fileURLToPath(new URL("../packs/index.ts", import.meta.url));

/** 演示包：注册一个工具，用来观察包的启停。 */
const demoPack: PackSpec = {
  id: "demo",
  title: "演示包",
  version: 1,
  registerTools: (registrar) => {
    registrar.tool("demo_ping", "演示包的工具。", {}, () => ({ ok: true }));
  },
};

/**
 * 另一个进程：打开同一个库，停用或启用演示包。
 *
 * 写完之后打印 DONE，父进程从这一刻开始计时。
 */
const childSource = `
import { createRegistry, openWorkspace, applyCommands } from ${JSON.stringify(KERNEL)};
import { builtinPacks } from ${JSON.stringify(PACKS)};
const registry = createRegistry();
for (const pack of builtinPacks) registry.registerPack(pack, "builtin");
registry.registerPack(
  { id: "demo", title: "演示包", version: 1 },
  "builtin",
);
const opened = openWorkspace(process.env.SAND_ROOT, process.env.SAND_WS, registry);
applyCommands(opened.db, registry, {
  actor: { id: "tester", kind: "human" },
  commands: [{ op: process.env.SAND_OP, id: "demo" }],
});
opened.db.close();
console.log("DONE");
`;

/** 起一个子进程，让它改包的状态，等它做完。 */
function runChild(
  root: string,
  workspaceId: string,
  op: "pack.enable" | "pack.disable",
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "-e", childSource],
      {
        env: {
          ...process.env,
          SAND_ROOT: root,
          SAND_WS: workspaceId,
          SAND_OP: op,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (data) => (stdout += data));
    child.stderr!.on("data", (data) => (stderr += data));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`子进程超时没退出。stdout=${stdout} stderr=${stderr}`));
    }, 30_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`子进程退出码 ${code}。stderr=${stderr}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

/** 工具列表里有没有这个工具。 */
async function hasTool(client: Client, name: string): Promise<boolean> {
  const listed = await client.listTools();
  return listed.tools.some((tool) => tool.name === name);
}

/**
 * 等工具列表变成期望的样子，最多等 limit 毫秒。
 *
 * 从子进程写完库那一刻开始算：子进程打印 DONE 的时候写已经提交了。
 */
async function waitForTool(
  client: Client,
  name: string,
  want: boolean,
  limit: number,
): Promise<number> {
  const started = Date.now();
  for (;;) {
    if ((await hasTool(client, name)) === want) return Date.now() - started;
    if (Date.now() - started > limit)
      throw new Error(
        `${limit} 毫秒内工具「${name}」没有变成${want ? "有" : "没有"}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("另一个进程停包，这边的工具列表 2 秒内跟着变；重新启用要恢复", async () => {
  const root = mkdtempSync(join(tmpdir(), "sand-pack-sync-"));
  const workspaceId = "shared";
  const created = createServerV3({
    workspaceRoot: root,
    workspaceId,
    packs: [basePack, demoPack],
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "pack-tester", version: "1" });
  await Promise.all([
    client.connect(clientTransport),
    created.server.connect(serverTransport),
  ]);
  try {
    assert.equal(await hasTool(client, "demo_ping"), true, "包启用时工具在");

    // A 停包。
    const stopped = await runChild(root, workspaceId, "pack.disable");
    assert.match(stopped.stdout, /DONE/, "子进程写完了");

    const off = await waitForTool(client, "demo_ping", false, 2000);
    assert.ok(off <= 2000, `停包用了 ${off} 毫秒`);

    // A 重新启用。
    const started = await runChild(root, workspaceId, "pack.enable");
    assert.match(started.stdout, /DONE/, "子进程写完了");

    const on = await waitForTool(client, "demo_ping", true, 2000);
    assert.ok(on <= 2000, `重新启用用了 ${on} 毫秒`);
  } finally {
    created.dispose();
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("服务退出会把看包的计时器收掉", async () => {
  const root = mkdtempSync(join(tmpdir(), "sand-pack-timer-"));
  const created = createServerV3({
    workspaceRoot: root,
    workspaceId: "timed",
    packs: [basePack, demoPack],
  });
  const watcher = created.packWatcher() as unknown as {
    _destroyed: boolean;
    hasRef: () => boolean;
  };
  assert.equal(watcher._destroyed, false, "计时器还在跑");
  // 计时器不拦着进程退出：服务收尾之后这一轮就结束了。
  assert.equal(watcher.hasRef(), false, "计时器不占着事件循环");
  created.dispose();
  assert.equal(watcher._destroyed, true, "退出会把计时器收掉");
  rmSync(root, { recursive: true, force: true });
});
