import { resultData } from "../core/results.ts";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { fixtureGuide } from "./fixture-guide.ts";
const external = process.env.SAND_EXTERNAL_REPO;
if (!external)
  throw Error("Set SAND_EXTERNAL_REPO to a checkout of lukeed/clsx.");
const workspaceDir = mkdtempSync(join(tmpdir(), "sand-browser-"));
const host = spawn(
  process.execPath,
  [
    "--experimental-strip-types",
    "dev/host.ts",
    "--workspace",
    `clsx=${external}`,
  ],
  {
    stdio: ["ignore", "pipe", "pipe"],
    // 测试之间互不干扰，也不碰用户真实的工作空间
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
  await frame.getByRole("heading", { name: "代码如何协作" }).waitFor();
  await frame
    .getByRole("button", { name: /项目说明/ })
    .first()
    .click();
  await frame.locator(".source").filter({ hasText: "clsx" }).waitFor();
  await frame
    .getByRole("combobox", { name: "对象类型" })
    .selectOption("symbol");
  await frame.getByRole("textbox", { name: "搜索对象" }).fill("src/index.js");
  const card = frame
    .locator(".card")
    .filter({ has: frame.locator("strong", { hasText: /^clsx$/ }) });
  await card.click();
  await frame.getByRole("button", { name: "查看源码依据" }).click();
  await frame.locator(".source").filter({ hasText: "toVal" }).waitFor();
  await frame.locator("textarea").fill("请解释这条路径");
  await frame.getByRole("button", { name: "保存备注" }).click();
  await page.getByRole("button", { name: "测试客户端读取选区" }).click();
  await page
    .locator("#context")
    .filter({ hasText: "请解释这条路径" })
    .waitFor();
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
            params: { name, arguments: { boardId: w.__boardId, ...args } },
          }),
        });
        return r.json();
      },
      { name, args },
    );
  }
  let state = resultData(await rpc("sand_read_board"));
  const selected = state.objects.find((o: any) => o.id === state.selection[0]);
  await rpc("sand_report_activity", {
    agentId: "Protocol test client",
    workspaceId: selected.workspaceId,
    objectIds: [selected.id],
    task: "Scripted browser check",
    action: "Reading source (test)",
    state: "waiting",
  });
  await frame
    .getByText("Reading source (test)", { exact: false })
    .first()
    .waitFor({ timeout: 12000 });
  await frame
    .locator(".card")
    .filter({ has: frame.locator("strong", { hasText: /^toVal$/ }) })
    .click({ modifiers: ["Shift"] });
  await frame.getByRole("button", { name: "编排", exact: true }).click();
  await frame
    .getByRole("textbox", { name: "分组名称" })
    .fill("参数如何变成字符串");
  await frame.getByRole("button", { name: "将选区分组" }).click();
  await frame.locator(".group").waitFor();
  const box = await card.boundingBox();
  assert.ok(box);
  await page.mouse.move(box.x + 80, box.y + 35);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + 175, { steps: 8 });
  await page.mouse.up();
  await frame.getByRole("button", { name: "浏览", exact: true }).click();
  await card.click();
  await frame.getByRole("button", { name: "固定位置", exact: true }).click();
  await frame.getByRole("button", { name: "取消固定", exact: true }).waitFor();
  state = resultData(await rpc("sand_read_board"));
  assert.equal(state.groups.length, 1);
  assert.equal(state.placements[selected.id].pinned, true);
  assert.ok(state.placements[selected.id].y > 100);
  await frame.getByRole("button", { name: "关系 关", exact: true }).click();
  await frame.getByRole("button", { name: "查看源码依据" }).click();
  mkdirSync("artifacts", { recursive: true });
  await page
    .locator("#context")
    .evaluate((e) => ((e as HTMLElement).hidden = true));
  await frame.locator("main").evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: "artifacts/overview-paper.png" });
  await frame.getByRole("button", { name: "切换黑白" }).click();
  await page.screenshot({ path: "artifacts/overview-mono.png" });
  await frame.getByRole("button", { name: "AI 上下文" }).click();
  await frame.getByRole("heading", { name: "AI 看到了什么" }).waitFor();
  state = resultData(await rpc("sand_read_board"));
  const published = await rpc("sand_publish_guide", {
    revision: state.revision,
    ...fixtureGuide(state),
  });
  assert.ok(!published.isError, JSON.stringify(published));
  await frame
    .getByRole("combobox", { name: "功能路径" })
    .waitFor({ timeout: 12000 });
  await frame.getByRole("textbox", { name: "搜索对象" }).fill("no match");
  await frame.getByRole("button", { name: /转换每个值/ }).click();
  await frame.locator(".card.selected").filter({ hasText: "toVal" }).waitFor();
  assert.equal(
    await frame.getByRole("textbox", { name: "搜索对象" }).inputValue(),
    "",
  );
  const focused = resultData(await rpc("sand_read_context"));
  assert.equal(focused.guideFocus.step, 1);
  assert.equal(focused.objects[0].title, "toVal");
  const targetBox = await frame.locator(".card.selected").boundingBox();
  const canvasBox = await frame.locator(".canvas").boundingBox();
  assert.ok(
    targetBox &&
      canvasBox &&
      targetBox.x >= canvasBox.x &&
      targetBox.x + targetBox.width <= canvasBox.x + canvasBox.width,
  );
  await frame.getByRole("button", { name: "切换纸张" }).click();
  await frame.locator("aside").evaluate((e) => (e.scrollTop = 0));
  await frame.locator("main").evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: "artifacts/feature-guide.png" });
  const rejected = await page.request.post("http://127.0.0.1:4317/rpc", {
    headers: { Origin: "https://untrusted.invalid" },
    data: { method: "tools/call" },
  });
  assert.equal(rejected.status(), 403);
  await page.setViewportSize({ width: 390, height: 844 });
  await frame.locator("main").evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: "artifacts/overview-mobile.png" });
  assert.deepEqual(errors, []);
  console.log(
    "Browser passed: source, shared context, group, drag, pin, activity report, themes, mobile render, origin rejection, README entry, guide focus and context.",
  );
} finally {
  await browser?.close();
  host.kill("SIGTERM");
}
