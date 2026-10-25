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
  assert.equal(await page.locator("body > nav").count(), 0);
  assert.equal(await page.locator("#new-board").count(), 0);
  const browserId = await page.evaluate(() => (window as any).__sandBoardId);
  assert.ok(browserId);
  await frame()
    .locator(".app-rail")
    .getByRole("button", { name: "帮助", exact: true })
    .click();
  await frame()
    .getByRole("heading", { name: "和你自己的 AI 共用这张白板" })
    .waitFor();
  const jsonField = frame().locator("#json");
  let jsonText = "";
  for (let i = 0; i < 50; i++) {
    jsonText = await jsonField.inputValue();
    if (jsonText.includes("mcpServers")) break;
    await page.waitForTimeout(100);
  }
  const config = JSON.parse(jsonText).mcpServers["sand-table"];
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
  await frame()
    .getByText(/MCP 接入进程 1 个/)
    .waitFor({ timeout: 12000 });
  await frame().locator('[data-connection="on"]').waitFor();
  await frame().locator('[data-copy="json"]').click();
  await frame().locator("#setup-status").waitFor();
  assert.match(
    await frame().locator("#setup-status").innerText(),
    /已复制|请按系统复制/,
  );
  await frame().getByRole("button", { name: "返回白板" }).click();
  assert.equal(await frame().locator("#json").count(), 0);
  await frame()
    .locator(".app-rail")
    .getByRole("button", { name: "组件", exact: true })
    .click();
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
  await frame()
    .locator(".app-rail")
    .getByRole("button", { name: "帮助", exact: true })
    .click();
  assert.ok(
    (await frame().locator("#prompt").inputValue()).includes(browserId),
  );
  assert.equal(await frame().locator('[data-copy="prompt"]').count(), 1);
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
  for (let i = 0; i < 50; i++) {
    if ((await frame().locator("#prompt").inputValue()) === agentMessage) break;
    await page.waitForTimeout(100);
  }
  assert.equal(await frame().locator("#prompt").inputValue(), agentMessage);
  const promptBefore = await frame().locator("#prompt").inputValue();
  await frame().locator('[data-copy="prompt"]').click();
  assert.equal(await frame().locator("#prompt").inputValue(), promptBefore);
  await frame().getByRole("button", { name: "复制当前选区提问" }).click();
  for (let i = 0; i < 50; i++) {
    if ((await frame().locator("#ask-text").inputValue()).length > 0) break;
    await page.waitForTimeout(100);
  }
  assert.ok((await frame().locator("#ask-text").inputValue()).length > 0);
  assert.equal(await frame().locator("#prompt").inputValue(), promptBefore);
  await page.screenshot({ path: "artifacts/local-connect.png" });
  await frame().getByRole("button", { name: "返回白板" }).click();
  await page.screenshot({ path: "artifacts/local-board.png" });
  const oldToken = connection.token;
  await stop();
  await frame().locator('[data-connection="off"]').waitFor({ timeout: 8000 });
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
