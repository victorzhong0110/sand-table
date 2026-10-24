import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { resultData } from "../board/data-client/results.ts";

const external = process.env.SAND_EXTERNAL_REPO;
if (!external)
  throw Error("Set SAND_EXTERNAL_REPO to a checkout of lukeed/clsx.");
const workspaceDir = mkdtempSync(join(tmpdir(), "sand-browser-"));
const host = spawn(
  process.execPath,
  [
    "--experimental-strip-types",
    "dev/host.ts",
    "--workspace-dir",
    workspaceDir,
    "--workspace-id",
    "browser",
  ],
  {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, SAND_WORKSPACE_DIR: workspaceDir },
  },
);
let logs = "";
host.stderr.on("data", (d) => (logs += d));
let browser;
try {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(Error(logs || "Host startup timed out")),
      30000,
    );
    host.once("exit", (c) => {
      clearTimeout(timeout);
      reject(Error(`Host exited ${c}: ${logs}`));
    });
    host.stdout.on("data", (d) => {
      logs += d;
      if (logs.includes("READY")) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1100 },
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://127.0.0.1:4317");
  const frame = page.frameLocator("iframe");
  await frame.getByRole("heading", { name: "从一块空白开始" }).waitFor();
  async function rpc(name: string, args: Record<string, unknown> = {}) {
    return page.evaluate(
      async ({ name, args }) => {
        const w = window as any;
        const r = await fetch("/rpc", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Sand-Token": w.__token,
          },
          body: JSON.stringify({
            method: "tools/call",
            params: { name, arguments: args },
          }),
        });
        return r.json();
      },
      { name, args },
    );
  }
  const imported = resultData(
    await rpc("code_repo", { action: "import", path: external }),
  );
  assert.equal(typeof imported.repositoryId, "string");
  const found = resultData(
    await rpc("sand_query", {
      types: ["code.symbol"],
      text: "clsx",
      limit: 20,
    }),
  );
  const symbol = (found.rows as { id: string; title: string }[]).find(
    (row) => row.title === "clsx",
  );
  assert.ok(symbol);
  const source = resultData(
    await rpc("code_repo", { action: "read_source", objectId: symbol.id }),
  );
  assert.match(String(source.text), /toVal/);
  mkdirSync("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/overview-paper.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "artifacts/overview-mobile.png" });
  const rejected = await page.request.post("http://127.0.0.1:4317/rpc", {
    headers: { Origin: "https://untrusted.invalid" },
    data: { method: "tools/call" },
  });
  assert.equal(rejected.status(), 403);
  assert.deepEqual(errors, []);
  console.log(
    "Browser passed: blank board, clsx import, source excerpt, mobile render, origin rejection.",
  );
} finally {
  await browser?.close();
  host.kill("SIGTERM");
}
