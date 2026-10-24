import { resultData } from "../board/data-client/results.ts";
import { mkdtempSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { chromium } from "playwright";
import { readConnection } from "../local/session.ts";

const dir = mkdtempSync(join(tmpdir(), "sand-local-")),
  sessionFile = join(dir, "connection.json"),
  workspaceDir = join(dir, "workspaces");
const port = 45000 + Math.floor(Math.random() * 3000);
let service: ReturnType<typeof spawn> | undefined,
  browser,
  client: Client | undefined;

async function launch() {
  service = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      "../scripts/start-workbench.mjs",
      "--no-open",
      "--port",
      String(port),
      "--session-file",
      sessionFile,
      "--workspace-dir",
      workspaceDir,
      "--workspace-id",
      "local",
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, SAND_WORKSPACE_DIR: workspaceDir },
    },
  );
  let output = "";
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Error(output || "Startup timeout")),
      60000,
    );
    service!.stdout!.on("data", (d) => {
      output += d;
      if (output.includes("READY")) {
        clearTimeout(timer);
        resolve();
      }
    });
    service!.stderr!.on("data", (d) => (output += d));
    service!.once("exit", (code) => {
      clearTimeout(timer);
      reject(Error(`Launcher exited ${code}: ${output}`));
    });
  });
  return readConnection(sessionFile);
}

async function stop() {
  if (service?.exitCode === null) {
    service.kill("SIGTERM");
    await once(service, "exit");
  }
  service = undefined;
}

try {
  mkdirSync("artifacts", { recursive: true });
  let connection = await launch();
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1100 },
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(connection.url + "#session=" + connection.token);
  const frame = () => page.frameLocator("iframe");
  await frame()
    .getByRole("heading", { name: "从一块空白开始" })
    .waitFor({ timeout: 20000 });
  const publicHtml = await (await page.request.get(connection.url)).text();
  assert.ok(!publicHtml.includes(connection.token));
  assert.equal(new URL(page.url()).hash, "");
  const browserId = await page.evaluate(() => (window as any).__sandBoardId);
  assert.ok(browserId);
  await page.getByRole("button", { name: "连接我的 AI", exact: true }).click();
  await page
    .getByRole("heading", { name: "和你自己的 AI 共用这张白板" })
    .waitFor();
  const config = JSON.parse(await page.locator("#json").inputValue())
    .mcpServers["sand-table"];
  assert.ok(config.args.includes(sessionFile));
  assert.ok(!JSON.stringify(config).includes(connection.token));
  client = new Client({
    name: "External MCP client (scripted acceptance)",
    version: "1",
  });
  await client.connect(new StdioClientTransport(config));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client!.callTool({ name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result));
    return resultData(result);
  };
  const status = await call("sand_status");
  assert.equal(status.homeBoardId, browserId);
  const resource = await client.readResource({
    uri: "ui://sand-table/overview.html",
  });
  assert.ok("text" in resource.contents[0]);
  await page.getByText(/MCP 接入进程 1 个/).waitFor({ timeout: 12000 });
  await page.getByRole("button", { name: "返回白板" }).click();
  assert.equal(await page.locator("#setup-panel").isVisible(), false);
  await frame()
    .getByRole("button", { name: "便签", exact: true })
    .dragTo(frame().locator(".canvas"), {
      targetPosition: { x: 280, y: 200 },
    });
  await frame().locator(".component-card").first().waitFor();
  const forbidden = await page.request.post(
    new URL("/rpc", connection.url).href,
    {
      headers: {
        "X-Sand-Token": connection.token,
        Origin: "https://untrusted.invalid",
      },
      data: { method: "tools/call" },
    },
  );
  assert.equal(forbidden.status(), 403);
  const noToken = await page.request.post(
    new URL("/rpc", connection.url).href,
    {
      headers: { Origin: connection.url.replace(/\/$/, "") },
      data: { method: "tools/call" },
    },
  );
  assert.equal(noToken.status(), 403);
  await page.getByRole("button", { name: "连接我的 AI", exact: true }).click();
  assert.ok((await page.locator("#prompt").inputValue()).includes(browserId));
  assert.equal(await page.locator('[data-copy="prompt"]').count(), 1);
  const appFrame = () => page.frames().find((f) => f !== page.mainFrame())!;
  const agentMessage =
    "用沙盘搭一个比较两个方案的白板：左边证据，右边图表，最后是结论。";
  await appFrame().evaluate((text) => {
    (window as any).parent.postMessage(
      {
        jsonrpc: "2.0",
        id: 990001,
        method: "ui/message",
        params: { role: "user", content: [{ type: "text", text }] },
      },
      "*",
    );
  }, agentMessage);
  await page.waitForFunction(
    (text) =>
      (document.getElementById("prompt") as HTMLTextAreaElement)?.value ===
      text,
    agentMessage,
    { timeout: 10000 },
  );
  const promptBefore = await page.locator("#prompt").inputValue();
  await page.getByRole("button", { name: "复制当前选区提问" }).click();
  await page.waitForFunction(
    () =>
      (document.getElementById("ask-text") as HTMLTextAreaElement)?.value
        .length > 0,
    undefined,
    { timeout: 10000 },
  );
  assert.equal(await page.locator("#prompt").inputValue(), promptBefore);
  await page.screenshot({ path: "artifacts/local-connect.png" });
  await page.getByRole("button", { name: "返回白板" }).click();
  await page.screenshot({ path: "artifacts/local-board.png" });
  const oldToken = connection.token;
  await stop();
  assert.equal(existsSync(sessionFile), false);
  connection = await launch();
  assert.notEqual(connection.token, oldToken);
  const again = await call("sand_status");
  assert.equal(again.homeBoardId, browserId);
  const notes = await call("sand_query", {
    types: ["base.note"],
    limit: 20,
  });
  assert.ok((notes.rows as unknown[]).length > 0, "重启后便签还在");
  assert.deepEqual(errors, []);
  console.log("Local passed: credential, copy, restart keeps the board.");
} finally {
  await browser?.close();
  await client?.close();
  await stop();
  rmSync(dir, { recursive: true, force: true });
}
