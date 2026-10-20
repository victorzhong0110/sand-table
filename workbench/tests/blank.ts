import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { readConnection } from "../local/session.ts";
import { resultData } from "../core/results.ts";
const root = mkdtempSync(join(tmpdir(), "sand-blank-")),
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
  { stdio: ["ignore", "pipe", "pipe"] },
);
let logs = "",
  browser,
  client: Client | undefined;
service.stderr.on("data", (d) => (logs += d));
try {
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(Error(logs)), 60000);
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
  const c = readConnection(sessionFile);
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    }),
    errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(c.url + "#session=" + c.token);
  const frame = page.frameLocator("iframe");
  await frame.getByRole("heading", { name: "从一块空白开始" }).waitFor();
  assert.equal(await frame.locator(".component-card").count(), 0);
  assert.equal(await frame.locator(".studio-inspector").count(), 0);
  assert.equal(await frame.getByText("代码入口", { exact: true }).count(), 0);
  mkdirSync("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/blank-canvas.png", fullPage: true });
  await page.getByRole("button", { name: "连接我的 AI", exact: true }).click();
  const config = JSON.parse(await page.locator("#json").inputValue())
    .mcpServers["sand-table"];
  client = new Client({
    name: "Scripted blank-canvas acceptance; not a model",
    version: "1",
  });
  await client.connect(new StdioClientTransport(config));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client!.callTool({ name, arguments: args });
    assert.ok(!r.isError, JSON.stringify(r));
    return resultData(r);
  };
  const boardId = (await call("sand_list_boards")).boards[0].boardId;
  const read = () => call("sand_read_board", { boardId });
  const until = async (test: (b: any) => boolean) => {
    for (let i = 0; i < 150; i++) {
      const b = await read();
      if (test(b)) return b;
      await new Promise((r) => setTimeout(r, 60));
    }
    throw Error("Expected state not reached.");
  };
  let b = await read();
  assert.equal(b.workspaces.length, 0);
  assert.equal(b.instances.length, 0);
  assert.equal(
    (await call("sand_read_context", { boardId })).contextLimits
      .selectedInstances,
    0,
  );
  await page.getByRole("button", { name: "返回白板" }).click();
  await frame
    .getByRole("button", { name: "说明／便签", exact: true })
    .dragTo(frame.locator(".canvas"), { targetPosition: { x: 300, y: 240 } });
  b = await until((b) => b.instances.some((i: any) => i.type === "text"));
  assert.ok(b.instances[0].rect.x > 100);
  await frame.getByRole("textbox", { name: "编辑组件名称" }).fill("我的计划");
  await frame
    .getByRole("textbox", { name: "内容", exact: true })
    .fill("先收集证据，再比较方案");
  await frame.getByRole("button", { name: "保存组件", exact: true }).click();
  b = await until((b) => b.instances[0].data.text === "先收集证据，再比较方案");
  await frame.getByRole("button", { name: "关闭详情" }).click();
  await frame.getByRole("button", { name: "白板", exact: true }).click();
  b = await until((b) => b.instances.some((i: any) => i.type === "board"));
  const container = b.instances.find((i: any) => i.type === "board"),
    child = container.data.spaceId;
  await frame
    .locator('[data-instance-id="' + container.id + '"]')
    .getByRole("button", { name: "进入白板" })
    .click();
  await frame
    .locator(".breadcrumbs")
    .getByRole("button", { name: "白板", exact: true })
    .waitFor();
  await frame.getByRole("heading", { name: "从一块空白开始" }).waitFor();
  await frame.getByRole("button", { name: "添加第一张便签" }).click();
  b = await until((b) =>
    b.instances.some((i: any) => i.spaceId === child && i.type === "text"),
  );
  assert.equal(
    b.instances.filter((i: any) => i.spaceId === "overview").length,
    2,
  );
  await frame
    .getByRole("button", { name: "和 AI 一起搭", exact: false })
    .first()
    .click();
  await frame
    .getByRole("textbox", { name: "给 AI 的编排请求" })
    .fill("在这个子白板里添加一个比较组件，保留我的便签。");
  await frame.getByRole("button", { name: "交给我的 AI", exact: true }).click();
  await page.locator("#setup-panel").waitFor();
  assert.match(
    await page.locator("#prompt").inputValue(),
    /在这个子白板里添加一个比较组件/,
  );
  assert.ok((await page.locator("#prompt").inputValue()).includes(boardId));
  await page.getByRole("button", { name: "返回白板" }).click();
  // A scripted external MCP client maintains the same board, without a repository.
  b = await read();
  const viewId = Object.keys(b.views)[0];
  await call("sand_edit_space", {
    boardId,
    revision: b.revision,
    viewId,
    author: "Protocol probe",
    operation: {
      kind: "create",
      type: "comparison",
      title: "AI 搭建的比较",
      data: {
        left: { title: "方案甲", text: "" },
        right: { title: "方案乙", text: "" },
        conclusion: "",
      },
    },
  });
  await frame.getByText("AI 搭建的比较", { exact: true }).first().waitFor();
  if (process.env.SAND_EXTERNAL_REPO) {
    await frame.getByRole("tab", { name: "仓库", exact: true }).click();
    await frame
      .getByRole("textbox", { name: "本机仓库路径" })
      .fill(process.env.SAND_EXTERNAL_REPO);
    await frame
      .getByRole("button", { name: "导入到白板", exact: true })
      .click();
    b = await until(
      (b) =>
        b.workspaces.length === 1 &&
        b.instances.some((i: any) => i.type === "object"),
    );
    assert.equal(
      b.instances.filter((i: any) => i.spaceId === "overview").length,
      2,
      "Import stays inside the current child board.",
    );
    assert.equal(b.autoProjectSources, false);
    assert.ok(b.spaces.length > 3);
    const source =
      b.instances.find(
        (i: any) => i.type === "object" && i.title === "readme.md",
      ) || b.instances.find((i: any) => i.type === "object");
    const v = b.views[viewId];
    // Agent can explicitly focus the imported file's board and the human sees it.
    if (v.spaceId !== source.spaceId)
      await call("sand_edit_space", {
        boardId,
        revision: b.revision,
        viewId,
        author: "Protocol probe",
        operation: { kind: "navigate", spaceId: source.spaceId },
      });
    await frame.locator('[data-instance-id="' + source.id + '"]').waitFor();
    await frame.getByRole("button", { name: "浏览", exact: true }).click();
    await frame.locator('[data-instance-id="' + source.id + '"]').click();
    await until((b) => b.views[viewId].selection.includes(source.id));
    await frame
      .getByRole("button", { name: "查看源码依据", exact: true })
      .click();
    await frame.locator(".source-inspector pre.source").waitFor();
  }
  await frame.getByRole("button", { name: "外观", exact: true }).click();
  await frame.locator('input[type="color"]').first().fill("#edf2ed");
  await frame
    .getByRole("button", { name: "应用自定义外观", exact: true })
    .click();
  await until((b) => b.theme?.background === "#edf2ed");
  await page.screenshot({
    path: "artifacts/composed-canvas.png",
    fullPage: true,
  });
  assert.equal(await frame.locator('[role="alert"]').count(), 0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "artifacts/blank-mobile.png", fullPage: true });
  assert.ok(
    (await frame.locator(".canvas").evaluate((el) => el.clientWidth)) > 100,
  );
  assert.deepEqual(errors, []);
  console.log(
    "BLANK CANVAS PASSED: no workspace required, zero initial components, palette drag/drop and editing, nested boards, explicit AI handoff/shared MCP composition, optional human repository import, source reading, custom theme and narrow-screen layout.",
  );
} catch (e) {
  const failedPage = browser?.contexts()[0]?.pages()[0];
  if (failedPage) {
    await failedPage
      .screenshot({ path: "artifacts/blank-failure.png", fullPage: true })
      .catch(() => {});
    console.log(
      "Canvas state at failure:",
      await failedPage
        .frameLocator("iframe")
        .locator("main")
        .innerText()
        .catch(() => "(not visible)"),
    );
  }
  throw e;
} finally {
  await client?.close().catch(() => {});
  await browser?.close();
  service.kill("SIGTERM");
  if (service.exitCode === null)
    await Promise.race([
      once(service, "exit"),
      new Promise((r) => setTimeout(r, 3000)),
    ]);
  rmSync(root, { recursive: true, force: true });
}
