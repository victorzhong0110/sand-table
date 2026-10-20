import { resultData } from "../core/results.ts";
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
// A fixed port, the way the documentation tells people to run it: the
// address stays the same across restarts, so a restart rotates only the
// credential and the tab has to pick the new one up.
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
      "--code-board",
      "--port",
      String(port),
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
    return resultData(result);
  };
  const listed = await call("sand_list_boards");
  assert.equal(listed.boards.length, 1);
  assert.equal(listed.boards[0].boardId, browserId);
  /** The UI writes to the server without waiting: "save note" and "focus a
   *  guide step" both fire the write and move on, and reading the context
   *  right after the click can land before the write does. Wait for the
   *  expected state instead of reading once and hoping. */
  const untilContext = async (
    check: (ctx: any) => boolean,
    describe: string,
  ): Promise<any> => {
    const deadline = Date.now() + 10000;
    let last = "(no read yet)";
    while (Date.now() < deadline) {
      try {
        const ctx = await call("sand_read_context", { boardId: browserId });
        last = JSON.stringify(ctx.objects?.[0]?.title ?? null);
        if (check(ctx)) return ctx;
      } catch (e) {
        last = String((e as Error).message);
      }
      await new Promise((r) => setTimeout(r, 80));
    }
    assert.fail(
      `The context never reached the expected state (${describe}). Last read: ${last}`,
    );
  };
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
  const context = await untilContext(
    (c) => c.notes[c.selection?.[0]] === "解释条件参数",
    "the saved note on the selected object",
  );
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
  await untilContext(
    (c) => c.objects?.[0]?.title === "toVal",
    "the guide step focus",
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
  /* #6-A: the address stayed the same, the credential did not. The tab
     still holds the old one, so every request comes back unauthorized —
     until the new link is pasted into it. Pasting changes only the
     fragment, so the page is never reloaded and has to read the new
     credential from there; otherwise the tab stays broken until it is
     reloaded by hand. */
  await page.waitForFunction(
    () =>
      Boolean(
        document.getElementById("connection")?.textContent?.includes("断开"),
      ),
    undefined,
    { timeout: 20000 },
  );
  await page.evaluate((token) => {
    location.hash = "#session=" + token;
  }, connection.token);
  await page.waitForFunction(
    () =>
      !document
        .getElementById("connection")
        ?.textContent?.includes("断开"),
    undefined,
    { timeout: 20000 },
  );
  await frame()
    .getByRole("heading", { name: "项目总览", exact: true })
    .waitFor({ timeout: 20000 });
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
