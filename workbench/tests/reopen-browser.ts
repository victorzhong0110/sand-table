import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { readConnection } from "../local/session.ts";

const root = mkdtempSync(join(tmpdir(), "sand-reopen-")),
  sessionFile = join(root, "connection.json");
const service = spawn(
  process.execPath,
  [
    "--experimental-strip-types",
    "../scripts/start-workbench.mjs",
    "--no-open",
    "--session-file",
    sessionFile,
  ],
  {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, SAND_WORKSPACE_DIR: join(root, "workspaces") },
  },
);
let logs = "",
  browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
service.stderr.on("data", (d) => (logs += d));
try {
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(Error(logs || "startup timeout")), 90000);
    service.stdout.on("data", (d) => {
      logs += d;
      if (logs.includes("READY")) {
        clearTimeout(t);
        resolve();
      }
    });
    service.once("exit", (c) => {
      clearTimeout(t);
      reject(Error("Exited " + c + ": " + logs));
    });
  });
  const connection = readConnection(sessionFile);
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.setDefaultTimeout(20000);
  await page.goto(connection.url + "#session=" + connection.token);
  const frame = page.frameLocator("iframe");
  const board = frame.getByRole("heading", { name: "从一块空白开始" });
  await board.waitFor();
  await page.locator("#opening").waitFor({ state: "hidden" });
  const button = page.locator("#new-board");
  assert.equal(await button.innerText(), "重新连接");
  for (let i = 0; i < 5; i++) {
    await button.click();
    await page.waitForTimeout(200);
  }
  await board.waitFor();
  await frame.locator(".canvas").waitFor();
  await page.locator("#opening").waitFor({ state: "hidden" });
  assert.equal(await page.locator("#error").isVisible(), false);

  await page.route("**/rpc", async (route) => {
    let body: { method?: string } = {};
    try {
      body = route.request().postDataJSON();
    } catch {
      body = {};
    }
    if (body?.method === "resources/read") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          contents: [
            {
              uri: "ui://sand-table/overview.html",
              mimeType: "text/html",
              text: "<!doctype html><html><body><p>not-the-board</p></body></html>",
            },
          ],
        }),
      });
      return;
    }
    await route.continue();
  });
  const started = Date.now();
  await button.click();
  await page.getByText("正在打开白板…").waitFor({ timeout: 3000 });
  await page.locator("#error").waitFor({ timeout: 18000 });
  const elapsed = Date.now() - started;
  const text = await page.locator("#error-text").innerText();
  assert.match(text, /白板没有加载出来/);
  assert.equal(await page.locator("#retry").isVisible(), true);
  assert.ok(elapsed < 18000, "error appeared after " + elapsed + "ms");
  assert.ok(elapsed >= 14000, "error appeared too early: " + elapsed + "ms");
  console.log("REOPEN BROWSER PASSED");
} finally {
  await browser?.close();
  if (service.exitCode === null) {
    service.kill("SIGTERM");
    await once(service, "exit").catch(() => undefined);
  }
  rmSync(root, { recursive: true, force: true });
}
