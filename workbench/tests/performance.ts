import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { readConnection } from "../local/session.ts";
import { resultData } from "../core/results.ts";
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
    "--workspace",
    "hf=" + repo,
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);
let output = "",
  browser;
service.stderr.on("data", (d) => (output += d));
try {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(output)), 30000);
    service.stdout.on("data", (d) => {
      output += d;
      if (output.includes("READY")) {
        clearTimeout(timer);
        resolve();
      }
    });
    service.once("exit", (code) => {
      clearTimeout(timer);
      reject(Error("Service exited " + code + ": " + output));
    });
  });
  const readyMs = performance.now() - start,
    c = readConnection(sessionFile);
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const load = performance.now();
  await page.goto(c.url + "#session=" + c.token);
  const frame = page.frameLocator("iframe");
  await frame.locator(".component-card").first().waitFor();
  const firstCardMs = performance.now() - load;
  const board = await page.evaluate(async () => {
    const response = await fetch("/rpc", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Sand-Token": window.__sandToken,
      },
      body: JSON.stringify({
        method: "tools/call",
        params: {
          name: "sand_read_board",
          arguments: { boardId: window.__sandBoardId },
        },
      }),
    });
    return response.json();
  });
  const b = resultData(board),
    rendered = await frame.locator(".component-card").count();
  assert.ok(
    b.instances.length > 500,
    "Use a real large projection, not a tiny fixture.",
  );
  assert.ok(rendered < 100, "Viewport must cull the large map.");
  const query = frame.getByRole("textbox", { name: "搜索对象" });
  const searchStart = performance.now();
  await query.fill("snapshot_download");
  await frame
    .locator(".component-card")
    .filter({ hasText: "snapshot_download" })
    .first()
    .waitFor();
  const searchMs = performance.now() - searchStart;
  await query.fill("");
  const canvas = frame.locator(".canvas");
  const box = await canvas.boundingBox();
  assert.ok(box);
  await page.mouse.move(box.x + box.width - 50, box.y + box.height - 50);
  const panStart = performance.now();
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 180, box.y + box.height - 180, {
    steps: 20,
  });
  await page.mouse.up();
  const panMs = performance.now() - panStart;
  const frameTimes = await canvas.evaluate(async () => {
    const times: number[] = [];
    let last = performance.now();
    for (let i = 0; i < 30; i++) {
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      const now = performance.now();
      times.push(now - last);
      last = now;
    }
    return times.sort((a, b) => a - b);
  });
  const report = {
    scenario:
      "HF Hub pinned checkout; 120 indexed files; 1440x1000; browser shared view; default depth; no model",
    node: process.version,
    platform: process.platform,
    readyMs,
    firstCardMs,
    searchMs,
    panMs,
    totalInstances: b.instances.length,
    renderedInstances: rendered,
    sourceEdges: b.relations.length,
    frameP95Ms: frameTimes[28],
    hostHeapBytes: process.memoryUsage().heapUsed,
    limitations:
      "Frame sample is post-interaction, not a full animation profile. Heap is test-host JS, not total browser/server RSS. Device-specific human latency still requires actual hardware.",
  };
  assert.ok(readyMs < 30000);
  assert.ok(firstCardMs < 15000);
  assert.ok(searchMs < 10000);
  mkdirSync("artifacts", { recursive: true });
  writeFileSync(
    "artifacts/performance.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
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
