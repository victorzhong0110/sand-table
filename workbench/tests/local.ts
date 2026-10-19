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
import { fixtureGuide } from "./fixture-guide.ts";
const external = process.env.SAND_EXTERNAL_REPO;
if (!external)
  throw Error("Set SAND_EXTERNAL_REPO to a checkout of lukeed/clsx.");
const dir = mkdtempSync(join(tmpdir(), "sand-local-")),
  sessionFile = join(dir, "connection.json");
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
      "--session-file",
      sessionFile,
      "--workspace",
      `clsx=${external}`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Error(output || "Startup timeout")),
      30000,
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
    .getByRole("heading", { name: "项目总览", exact: true })
    .waitFor();
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
    return (result.structuredContent as any).data;
  };
  const listed = await call("sand_list_boards");
  assert.equal(listed.boards.length, 1);
  assert.equal(listed.boards[0].boardId, browserId);
  let b = await call("sand_open_board", { boardId: browserId });
  assert.equal(b.id, browserId);
  const resource = await client.readResource({
    uri: "ui://sand-table/overview.html",
  });
  assert.ok("text" in resource.contents[0]);
  await page.getByText(/MCP 接入进程 1 个/).waitFor({ timeout: 12000 });
  await page.getByRole("button", { name: "返回白板" }).click();
  assert.equal(await page.locator("#setup-panel").isVisible(), false);
  await frame().getByRole("textbox", { name: "搜索对象" }).fill("src/index.js");
  const card = frame()
    .locator(".card")
    .filter({ has: frame().locator("strong", { hasText: /^clsx$/ }) });
  await card.click();
  await frame().locator("textarea").fill("解释条件参数");
  await frame().getByRole("button", { name: "保存备注" }).click();
  const context = await call("sand_read_context", { boardId: browserId });
  assert.equal(context.notes[context.selection[0]], "解释条件参数");
  assert.equal(context.objects[0].title, "clsx");
  b = await call("sand_read_board", { boardId: browserId });
  await call("sand_publish_guide", {
    boardId: browserId,
    revision: b.revision,
    ...fixtureGuide(b),
  });
  await frame()
    .getByRole("combobox", { name: "功能路径" })
    .waitFor({ timeout: 12000 });
  await frame()
    .getByRole("button", { name: /转换每个值/ })
    .click();
  assert.equal(
    (await call("sand_read_context", { boardId: browserId })).objects[0].title,
    "toVal",
  );
  await page.reload();
  await frame()
    .getByRole("heading", { name: "项目总览", exact: true })
    .waitFor();
  assert.equal(
    await page.evaluate(() => (window as any).__sandBoardId),
    browserId,
  );
  assert.equal(
    (await call("sand_read_board", { boardId: browserId })).notes[
      context.selection[0]
    ],
    "解释条件参数",
  );
  const forbidden = await page.request.post(
    new URL("/agent/rpc", connection.url).href,
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
      headers: { Origin: connection.url.slice(0, -1) },
      data: { method: "tools/call" },
    },
  );
  assert.equal(noToken.status(), 403);
  await page.getByRole("button", { name: "连接我的 AI", exact: true }).click();
  assert.ok((await page.locator("#prompt").inputValue()).includes(browserId));
  await page.screenshot({ path: "artifacts/local-connect.png" });
  await page.getByRole("button", { name: "返回白板" }).click();
  await page.screenshot({ path: "artifacts/local-board.png" });
  const oldToken = connection.token;
  await stop();
  assert.equal(existsSync(sessionFile), false);
  connection = await launch();
  assert.notEqual(connection.token, oldToken);
  const fresh = await call("sand_list_boards");
  assert.equal(fresh.boards.length, 1);
  assert.notEqual(fresh.boards[0].boardId, browserId);
  const old = await client.callTool({
    name: "sand_read_board",
    arguments: { boardId: browserId },
  });
  assert.equal(old.isError, true);
  assert.deepEqual(errors, []);
  console.log(
    "Local workbench passed: real launcher, generated MCP config, independent stdio client, shared selection/guide, reload, auth, clean shutdown, token rotation and bridge reconnect.",
  );
} finally {
  await client?.close();
  await browser?.close();
  await stop();
  rmSync(dir, { recursive: true, force: true });
}
