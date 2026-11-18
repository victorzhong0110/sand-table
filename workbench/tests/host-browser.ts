// Real cross-origin browser + actual local service/plugin. DSH session execution is a scripted contract fixture, not a model.
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { startLocal } from "../local/service.ts";
const root = mkdtempSync(join(tmpdir(), "sand-host-browser-"));
const disposers: (() => any)[] = [];
let command: any, local: any, browser: any, page: any;
const events = new Set<(s: any, e: any) => void>();
let turn = 0;
const prompts: any[] = [];
const emit = (type: string, data: any) => {
  for (const listener of events)
    listener({ id: "session" }, { type, data, seq: 1 });
};
const controller = {
  prompt: async (request: any) => {
    prompts.push(request);
    if (request.content[0].text.startsWith("reject"))
      return { accepted: false };
    const current = ++turn;
    setTimeout(() => {
      emit("turn/start", { turn: current });
      emit("user/message", { source: { rpcId: request.requestId } });
      if (request.content[0].text.startsWith("wait")) return;
      emit("assistant/message", {
        turn: current,
        message: {
          content: [{ type: "text", text: `Host response ${current}` }],
        },
      });
      emit("tool/result", {
        turn: current,
        message: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                kind: "dataset",
                title: "Plugin table",
                rows: [
                  ["Round", "Score"],
                  [current, 0.9],
                ],
              }),
            },
          ],
        },
      });
      emit("turn/end", { turn: current, reason: { kind: "completed" } });
    }, 150);
    return { accepted: true };
  },
  cancel: async () => {
    emit("turn/end", { turn, reason: { kind: "aborted" } });
    return { accepted: true };
  },
};
const code = (
  await build({
    stdin: {
      contents: `import React from 'react';import {createRoot} from 'react-dom/client';window.__ModuleLoader__={load({factory}){const plugin=factory(name=>{if(name==='react')return React;throw Error(name)});const ctx={locale:{resolveText:x=>x},get:()=>({adapter:{current:{value:{key:'session'}}}}),effect:fn=>fn(),slots:{inject:(_name,fn)=>fn(),register:(meta,Component)=>{if(meta.name==='main')createRoot(document.getElementById('root')).render(React.createElement(Component));return()=>{}}},remote:{commands:{list:async()=>({ok:true,value:[{name:'sand-table'}]}),execute:async(_session,line)=>{const r=await fetch('/command',{method:'POST',body:JSON.stringify({line})});return r.json()}}}};plugin.apply(ctx)}};`,
      resolveDir: process.cwd(),
      loader: "js",
    },
    bundle: true,
    write: false,
    format: "iife",
    minify: true,
  })
).outputFiles[0].text;
const pluginClient = await import("node:fs/promises").then((fs) =>
  fs.readFile(new URL("../dsh-plugin/client.js", import.meta.url), "utf8"),
);
const parent = createServer(async (req, res) => {
  if (req.url === "/command") {
    let body = "";
    for await (const c of req) body += c;
    const line = JSON.parse(body).line;
    const result = await command.handler({
      rawInput: line.replace(/^\/sand-table\s*/, ""),
      agent: { id: "session" },
      signal: new AbortController().signal,
    });
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, value: { result } }));
    return;
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(
    `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><div id="root" style="height:100vh"></div><script>${code}</script><script>${pluginClient}</script></body></html>`,
  );
});
try {
  await new Promise<void>((r) => parent.listen(0, "127.0.0.1", r));
  const address = parent.address() as any;
  const origin = `http://127.0.0.1:${address.port}`;
  const sessionFile = join(root, "connection.json");
  local = await startLocal({
    workspaces: [],
    sessionFile,
    workspaceDir: join(root, "workspaces"),
    embedOrigins: [origin],
  });
  const pluginFile = "../dsh-plugin/index.js";
  const { apply } = await import(pluginFile);
  const tools = new Map<string, any>();
  apply(
    {
      get: () => controller,
      on: (_: string, fn: any) => {
        events.add(fn);
        return () => events.delete(fn);
      },
      effect: (fn: any) => {
        const dispose = fn();
        if (dispose) disposers.push(dispose);
      },
      tools: {
        register: (t: any) => {
          tools.set(t.name, t);
          return () => {};
        },
      },
      commands: {
        register: (c: any) => {
          command = c;
          return () => {};
        },
      },
    },
    {
      serverEntry: fileURLToPath(
        new URL("../local/bridge.ts", import.meta.url),
      ),
      sessionFile,
      boardUrl: new URL("/embed", local.url).href,
    },
  );
  // Agent tools and the browser must see exactly the same board.
  const listed = JSON.parse(
    await tools.get("sand_table_list_boards").execute(),
  );
  assert.equal(listed.boards.length, 1);
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH,
    args: ["--no-sandbox"],
  });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(12000);
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));
  page.on("console", (m: any) => {
    if (m.type() === "error") console.log("BROWSER_ERROR", m.text());
  });
  await page.goto(origin);
  const shell = page.frameLocator('iframe[title="Sand Table 白板"]');
  const board = shell.frameLocator("iframe");
  await board.getByRole("heading", { name: "从一块空白开始" }).waitFor();
  await board.getByRole("button", { name: "和 AI 协作", exact: true }).click();
  const input = board.getByRole("textbox", { name: "给 AI 的编排请求" });
  await input.waitFor();
  await input.fill("hello");
  await board.getByRole("button", { name: "发送", exact: true }).click();
  await board.getByText("Host response 1", { exact: true }).first().waitFor();
  await board
    .locator(".component-card")
    .filter({ hasText: "Plugin table" })
    .waitFor();
  const table = board
    .locator(".component-card")
    .filter({ hasText: "Plugin table" });
  assert.match(await table.innerText(), /Round/);
  assert.match(await table.innerText(), /Score/);
  const ai = board.getByRole("complementary", {
    name: "和 AI 协作",
    exact: true,
  });
  const conversation = ai.getByRole("log", { name: "白板协作对话" });
  await conversation.getByText("Host response 1", { exact: true }).waitFor();
  await ai
    .getByLabel("AI 任务状态")
    .last()
    .getByText("已完成", { exact: true })
    .waitFor();
  await ai.getByRole("button", { name: "收起 AI 协作" }).click();
  await table.click();
  await board.getByRole("button", { name: /询问选区/ }).click();
  assert.equal(await ai.getByLabel("AI 讨论范围").inputValue(), "selection");
  await ai
    .getByLabel("AI 目标预览")
    .getByText("Plugin table", { exact: true })
    .first()
    .waitFor();
  assert.equal(
    await conversation.getByText("hello", { exact: true }).count(),
    1,
  );
  await input.fill("follow up");
  await board.getByRole("button", { name: "发送", exact: true }).click();
  await board.getByText("Host response 2", { exact: true }).first().waitFor();
  await conversation.getByText("Host response 2", { exact: true }).waitFor();
  await ai
    .getByLabel("AI 任务状态")
    .last()
    .getByText("已完成", { exact: true })
    .waitFor();
  const selectedTargets = JSON.parse(
    prompts[1].content[0].text.match(/targets: (.+)/)[1],
  );
  assert.equal(selectedTargets.length, 1);
  assert.ok(selectedTargets[0].objectId);
  assert.ok(selectedTargets[0].version > 0);
  mkdirSync("artifacts", { recursive: true });
  await page.screenshot({
    path: "artifacts/whiteboard-ai.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  const panelBounds = await ai.boundingBox();
  assert.ok(
    panelBounds &&
      panelBounds.x >= 0 &&
      panelBounds.x + panelBounds.width <= 390,
  );
  assert.ok(
    await ai.getByRole("button", { name: "发送", exact: true }).isVisible(),
  );
  await page.screenshot({
    path: "artifacts/whiteboard-ai-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await ai.getByLabel("AI 讨论范围").selectOption("board");
  await ai
    .getByLabel("AI 目标预览")
    .getByText("Plugin table", { exact: true })
    .first()
    .waitFor();
  await ai.getByRole("button", { name: "找出遗漏", exact: true }).click();
  assert.match(await input.inputValue(), /遗漏、矛盾/);
  await input.fill("reject this request");
  await ai.getByRole("button", { name: "发送", exact: true }).click();
  await conversation.getByText("发送失败", { exact: true }).waitFor();
  assert.equal(await input.inputValue(), "reject this request");
  assert.equal(
    await conversation.getByText("follow up", { exact: true }).count(),
    1,
  );
  await input.fill("wait for cancellation");
  const before = prompts.length;
  await ai
    .getByRole("button", { name: "发送", exact: true })
    .evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
  await board.getByRole("button", { name: "停止 AI", exact: true }).click();
  assert.equal(prompts.length, before + 1, "重复点击只发送一次");
  await board
    .getByLabel("AI 任务状态")
    .last()
    .getByText("已取消", { exact: true })
    .waitFor();
  // Responses must be visible to the independent Agent tool through the same running service.
  const readBack = JSON.parse(
    await tools
      .get("sand_table_read_board")
      .execute({ boardId: listed.boards[0].boardId }),
  );
  assert.ok(JSON.stringify(readBack).includes("Plugin table"));
  const fresh = JSON.parse(await tools.get("sand_table_list_boards").execute());
  await tools.get("sand_table_edit_space").execute({
    boardId: fresh.boards[0].boardId,
    revision: fresh.boards[0].revision,
    operation: JSON.stringify({
      kind: "create",
      type: "text",
      title: "Agent edit",
      data: { text: "Shared through the host tool" },
    }),
  });
  await board
    .getByText("Shared through the host tool", { exact: true })
    .waitFor();
  // A non-programmer can create/edit domain components from the actual palette.
  await board
    .locator(".app-rail")
    .getByRole("button", { name: "组件", exact: true })
    .click();
  await board.getByRole("button", { name: "小说", exact: true }).click();
  await board.getByRole("button", { name: "人物", exact: true }).click();
  const character = board
    .locator(".component-card")
    .filter({ hasText: "人物" })
    .last();
  await character.waitFor();
  await character.click();
  const nameField = board.getByLabel("姓名", { exact: true });
  await nameField.fill("林澈");
  await nameField.blur();
  await character.getByText("林澈", { exact: true }).waitFor();
  assert.equal(await board.getByText(/此版本不支持组件类型/).count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    "HOST BROWSER PASSED: actual local service and plugin, cross-origin nested canvas, late capability, real request ID, response and table persisted, follow-up and cancellation (scripted DSH execution fixture).",
  );
} catch (error) {
  for (const frame of page?.frames() ?? [])
    console.log(
      "FRAME",
      frame.url(),
      await frame
        .locator("body")
        .innerText()
        .catch(() => "unreadable"),
    );
  throw error;
} finally {
  await browser?.close();
  for (const dispose of disposers.reverse()) await dispose();
  await local?.close();
  parent.closeAllConnections();
  await new Promise<void>((r) => parent.close(() => r()));
  rmSync(root, { recursive: true, force: true });
}
