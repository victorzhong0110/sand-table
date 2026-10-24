import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { readConnection } from "../local/session.ts";
import { resultData } from "../board/data-client/results.ts";

const repo = process.env.SAND_PYTHON_REPO;
if (!repo)
  throw Error("Set SAND_PYTHON_REPO to the pinned Hugging Face Hub checkout.");
const dir = mkdtempSync(join(tmpdir(), "sand-performance-")),
  sessionFile = join(dir, "connection.json");
const start = performance.now();
const service = spawn(
  process.execPath,
  [
    "--experimental-strip-types",
    "local/main.ts",
    "--no-open",
    "--session-file",
    sessionFile,
    "--workspace-dir",
    join(dir, "workspaces"),
    "--workspace-id",
    "performance",
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);
let output = "",
  browser;
service.stderr.on("data", (d) => (output += d));
try {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Error(output || "Startup timeout")),
      60000,
    );
    service.stdout.on("data", (d) => {
      output += d;
      if (output.includes("READY")) {
        clearTimeout(timer);
        resolve();
      }
    });
    service.once("exit", (code) => {
      clearTimeout(timer);
      reject(Error(`Service exited ${code}: ${output}`));
    });
  });
  const readyMs = performance.now() - start;
  const connection = readConnection(sessionFile);
  const client = new Client({ name: "performance", version: "1" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        "--experimental-strip-types",
        "local/bridge.ts",
        "--session-file",
        sessionFile,
      ],
    }),
  );
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result));
    return resultData(result);
  };
  await call("app_edit", {
    commands: [{ op: "pack.enable", id: "code" }],
  });
  const importStart = performance.now();
  const imported = await call("code_repo", { action: "import", path: repo });
  const importMs = performance.now() - importStart;
  assert.equal(typeof imported.repositoryId, "string");
  const queryStart = performance.now();
  const found = await call("sand_query", {
    types: ["code.symbol"],
    text: "snapshot_download",
    limit: 20,
  });
  const searchMs = performance.now() - queryStart;
  const rows = found.rows as { title: string }[];
  assert.ok(rows.some((row) => row.title === "snapshot_download"));
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const load = performance.now();
  await page.goto(connection.url + "#session=" + connection.token);
  const frame = page.frameLocator("iframe");
  await frame.getByRole("heading", { name: "从一块空白开始" }).waitFor();
  const firstPaintMs = performance.now() - load;
  const report = {
    scenario:
      "HF Hub pinned checkout imported through code_repo (at most 120 files); blank board in the browser; no model",
    node: process.version,
    platform: process.platform,
    readyMs,
    importMs,
    searchMs,
    firstPaintMs,
    files: imported.files,
    omitted: Array.isArray(imported.omitted) ? imported.omitted.length : 0,
    hostHeapBytes: process.memoryUsage().heapUsed,
    limitations:
      "索引有 120 个文件的上限，不再把整个仓库铺到画布上测量裁剪。耗时含本机磁盘，不代表别人的机器。",
  };
  assert.ok(readyMs < 60000);
  assert.ok(importMs < 120000);
  assert.ok(searchMs < 10000);
  assert.ok(firstPaintMs < 30000);
  mkdirSync("artifacts", { recursive: true });
  writeFileSync(
    "artifacts/performance.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
  await client.close();
} finally {
  await browser?.close();
  service.kill("SIGTERM");
  if (service.exitCode === null)
    await Promise.race([
      once(service, "exit"),
      new Promise((r) => setTimeout(r, 3000)),
    ]);
  rmSync(dir, { recursive: true, force: true });
}
