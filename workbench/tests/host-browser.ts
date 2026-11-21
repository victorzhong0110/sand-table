import { dshWorkbenchFixture, emitArtifact } from "./fixtures/dsh-workbench.ts";
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
import {
  applyCommands,
  boardContents,
  createRegistry,
  openWorkspace,
  type Command,
} from "../kernel/index.ts";
import { builtinPacks } from "../packs/index.ts";
import type { ResourceRegistry } from "../resources/registry.ts";
const root = mkdtempSync(join(tmpdir(), "sand-host-browser-"));
const disposers: (() => any)[] = [];
let command: any, local: any, browser: any, page: any;
const fixture = dshWorkbenchFixture();
let resourceRegistry: ResourceRegistry | undefined;
const emit = fixture.emit;
let turn = 0;
const prompts: any[] = [];
let finishDetached: (() => void) | undefined;
const experimentDrawing = {
  providerId: "comparison-drawing",
  namespace: "workbench",
  resourceId: "experiment-map",
};
let experimentRevision = "map-original";
const controller = {
  prompt: async (request: any) => {
    prompts.push(request);
    if (request.content[0].text.startsWith("reject"))
      return { accepted: false };
    const current = ++turn;
    setTimeout(() => {
      emit("turn/start", { turn: current });
      emit("user/message", {
        source: { kind: "user", rpcId: request.requestId },
      });
      if (request.content[0].text.startsWith("wait")) return;
      emit("assistant/message", {
        turn: current,
        message: {
          content: [{ type: "text", text: `Host response ${current}` }],
        },
      });
      if (request.content[0].text.startsWith("compare experiments")) {
        finishDetached = () => {
          experimentRevision = "map-compared";
          emitArtifact(fixture, current, {
            kind: "resource",
            title: "实验对照图新版本",
            note: "实验甲与实验乙比较",
            resource: { ...experimentDrawing, revision: experimentRevision },
          });
          emit("turn/end", { turn: current, reason: { kind: "completed" } });
        };
        return;
      }
      if (request.content[0].text.startsWith("detach")) {
        finishDetached = () => {
          emitArtifact(fixture, current, {
            kind: "note",
            title: "Closed page artifact",
            body: "Saved by the host",
          });
          emit("turn/end", { turn: current, reason: { kind: "completed" } });
        };
        return;
      }
      emitArtifact(fixture, current, {
        kind: "table",
        title: "Plugin table",
        columns: ["Round", "Score"],
        rows: [[current, 0.9]],
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
      ...fixture.ctx(controller),
      provide: (name: string, value: ResourceRegistry) => {
        if (name === "sandTableResources") resourceRegistry = value;
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
      workspaceDir: join(root, "workspaces"),
      boardUrl: new URL("/embed", local.url).href,
    },
    fixture.records,
  );
  const runtimeProbe = (
    await build({
      stdin: {
        contents: `
        import { createComponentRuntime } from './board/runtime/resources.ts';
        globalThis.sandPreparePdf = async (base64) => {
          let requests = 0;
          const runtime = createComponentRuntime(async (uri) => {
            const id = 'sand-test-' + ++requests;
            return await new Promise((resolve, reject) => {
              const receive = ({source, data}) => {
                if (source !== parent || data?.id !== id) return;
                clearTimeout(timeout);
                removeEventListener('message', receive);
                if (data.error) reject(Error(data.error.message));
                else resolve(data.result);
              };
              const timeout = setTimeout(() => {
                removeEventListener('message', receive);
                reject(Error('组件资源没有回执'));
              }, 4000);
              addEventListener('message', receive);
              parent.postMessage({jsonrpc:'2.0', method:'resources/read', id, params:{uri}}, '*');
            });
          });
          const read = async () => {
            const reader = await runtime.createPdfWorker();
            const document = reader.open(Uint8Array.from(atob(base64), x => x.charCodeAt(0)));
            try {
              const pdf = await document.document;
              const page = await pdf.getPage(1);
              const text = await page.getTextContent();
              await document.destroy();
              return { requests, pages: pdf.numPages, text: text.items.map(x => x.str || '').join('') };
            } finally {
              await reader.destroy();
            }
          };
          globalThis.sandReadPdfOffline = async () => {
            try { return await read(); }
            finally { runtime.dispose(); }
          };
          return await read();
        };
      `,
        resolveDir: process.cwd(),
      },
      bundle: true,
      write: false,
      format: "iife",
    })
  ).outputFiles[0].text;
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
  page.on("pageerror", (e: Error) => {
    errors.push(e.message);
    console.error("BROWSER_PAGE_ERROR", e.message);
  });
  page.on("console", (m: any) => {
    if (m.type() === "error") console.log("BROWSER_ERROR", m.text());
  });
  await page.goto(origin);
  const shell = page.frameLocator('iframe[title="Sand Table 白板"]');
  const board = shell.frameLocator("iframe");
  await board.getByRole("heading", { name: "从一块空白开始" }).waitFor();
  const boardFrame = page
    .frames()
    .find((frame: { url(): string }) => frame.url() === "about:srcdoc");
  assert.ok(boardFrame);
  await boardFrame.addScriptTag({ content: runtimeProbe });
  const pdfFixture = "./../spikes/bundle-loading/lib.mjs";
  const { helloPdf } = await import(pdfFixture);
  const pdfResult = await boardFrame.evaluate(
    (fixture: string) =>
      (
        globalThis as unknown as { sandPreparePdf(fixture: string): unknown }
      ).sandPreparePdf(fixture),
    Buffer.from(helloPdf()).toString("base64"),
  );
  assert.deepEqual(pdfResult, { requests: 2, pages: 1, text: "Hello" });
  await page.context().setOffline(true);
  try {
    const offline = await boardFrame.evaluate(() =>
      (
        globalThis as unknown as { sandReadPdfOffline(): unknown }
      ).sandReadPdfOffline(),
    );
    assert.deepEqual(offline, pdfResult);
  } finally {
    await page.context().setOffline(false);
  }

  await board.getByRole("button", { name: "和 AI 协作", exact: true }).click();
  const input = board.getByRole("textbox", { name: "给 AI 的编排请求" });
  await input.waitFor();
  await board.getByText("DSH 会话 session", { exact: true }).waitFor();
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
  assert.equal(
    await table.getByRole("textbox", { name: "Round列名" }).inputValue(),
    "Round",
  );
  assert.equal(
    await table.getByRole("textbox", { name: "Score列名" }).inputValue(),
    "Score",
  );
  assert.equal(
    await table.getByLabel("第 1 行 Round", { exact: true }).inputValue(),
    "1",
  );
  assert.equal(
    await table.getByLabel("第 1 行 Score", { exact: true }).inputValue(),
    "0.9",
  );
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
  assert.equal(await board.locator(".component-card").count(), 1);
  assert.equal(
    await board
      .locator(".component-card")
      .filter({ hasText: "Host response 1" })
      .count(),
    0,
  );
  const firstArtifacts = JSON.parse(
    await tools.get("sand_table_read_board").execute({
      boardId: listed.boards[0].boardId,
    }),
  );
  assert.ok(JSON.stringify(firstArtifacts).includes("Plugin table"));
  assert.ok(!JSON.stringify(firstArtifacts).includes("AI 回复"));
  await ai.getByRole("button", { name: "收起 AI 协作" }).click();
  await table.click({ position: { x: 8, y: 90 } });
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
  await conversation.getByText("等待中", { exact: true }).waitFor();
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
  await input.fill("detach browser");
  await ai.getByRole("button", { name: "发送", exact: true }).click();
  await board.getByRole("button", { name: "停止 AI", exact: true }).waitFor();
  const beforeClosing = prompts.length;
  await page.goto("about:blank");
  assert.ok(finishDetached);
  finishDetached();
  for (let attempt = 0; attempt < 80; attempt++) {
    const boardText = await tools
      .get("sand_table_read_board")
      .execute({ boardId: listed.boards[0].boardId });
    if (boardText.includes("Closed page artifact")) break;
    assert.notEqual(attempt, 79, "宿主应在浏览器关闭时写入产物");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await page.goto(origin);
  await board.getByRole("button", { name: "和 AI 协作", exact: true }).click();
  await conversation.getByText("detach browser", { exact: true }).waitFor();
  await conversation.getByText("Host response 4", { exact: true }).waitFor();
  await board
    .getByText("Closed page artifact", { exact: true })
    .first()
    .waitFor();
  assert.equal(prompts.length, beforeClosing, "重开不能重新执行原任务");
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
  assert.ok(resourceRegistry);
  const removeProvider = resourceRegistry.register({
    describe: () => ({
      providerId: "diagram-probe",
      namespace: "context",
      title: "图形测试",
      capabilities: { read: true },
      idempotency: "none",
    }),
    read: (ref) => ({
      status: "available",
      ref,
      revision: "diagram-r7",
      title: "选区原图",
      summary: "主持久化的图形摘要",
      capabilities: { read: true },
    }),
  });
  const registry = createRegistry();
  for (const pack of builtinPacks) registry.registerPack(pack, "builtin");
  const boardId = listed.boards[0].boardId as string;
  const { db } = openWorkspace(join(root, "workspaces"), "default", registry);
  let objectCount: number;
  let omittedCount: number;
  try {
    const actor = { kind: "human" as const, id: "context-browser" };
    const commands: Command[] = [];
    for (let index = 0; index < 15; index++) {
      commands.push(
        {
          op: "object.create",
          ref: `context${index}`,
          title: `选区资源 ${index}`,
          type: "base.resource_reference",
          source: {
            origin: "human",
            resource: {
              providerId: index === 0 ? "diagram-probe" : "missing-probe",
              namespace: "context",
              resourceId: `scene-${index}`,
            },
          },
        },
        {
          op: "presentation.create",
          ref: `place${index}`,
          boardId,
          objectId: `@context${index}`,
          x: 2100 + index * 260,
          y: 100,
        },
        { op: "presentation.update", id: `@place${index}`, z: 400 + index },
      );
    }
    const { created } = applyCommands(db, registry, { actor, commands });
    const ids = Array.from(
      { length: 15 },
      (_, index) => created[`context${index}`],
    );
    const relations: Command[] = ids.flatMap((sourceId, index) =>
      ids.flatMap((targetId, other) =>
        index === other
          ? []
          : [
              {
                op: "relation.create",
                kind: "base.related",
                sourceId,
                targetId,
              },
            ],
      ),
    );
    applyCommands(db, registry, { actor, commands: relations.slice(0, 200) });
    applyCommands(db, registry, { actor, commands: relations.slice(200, 201) });
    const content = boardContents(db, registry, boardId);
    objectCount = content.objects.length;
    omittedCount = content.relations.length - 200;
    assert.ok(omittedCount >= 1);
  } finally {
    db.close();
  }
  if (!(await ai.isVisible()))
    await board
      .getByRole("button", { name: "和 AI 协作", exact: true })
      .click();
  await ai.getByLabel("AI 讨论范围").selectOption("board");
  await ai
    .getByLabel("AI 目标预览")
    .getByText(`${objectCount} 个对象`, { exact: true })
    .waitFor();
  await input.fill("check frozen resource context");
  await board.getByRole("button", { name: "发送", exact: true }).click();
  const submitted = conversation.locator(".ai-turn").filter({
    hasText: "check frozen resource context",
  });
  await submitted
    .getByLabel("AI 任务状态")
    .getByText("已完成", { exact: true })
    .waitFor();
  await submitted.getByText("提交时的上下文", { exact: true }).click();
  await submitted.getByText("资源版本 diagram-r7", { exact: true }).waitFor();

  await submitted
    .getByText(/^资源插件尚未加载/)
    .first()
    .waitFor();
  await submitted
    .getByText("达到资源摘要上限，未读取。", { exact: true })
    .first()
    .waitFor();
  await submitted
    .getByText(`达到关系上限，省略了 ${omittedCount} 条关系。`, { exact: true })
    .waitFor();
  removeProvider();
  await page.goto(origin);
  await board.getByRole("button", { name: "和 AI 协作", exact: true }).click();
  await submitted.getByText("提交时的上下文", { exact: true }).click();
  await submitted.getByText("资源版本 diagram-r7", { exact: true }).waitFor();

  const unregisterComparison = resourceRegistry.register({
    describe: () => ({
      ...experimentDrawing,
      title: "实验对照图",
      capabilities: { read: true },
      idempotency: "none",
    }),
    read: (ref) =>
      ref.revision && ref.revision !== experimentRevision
        ? { status: "version_unavailable", ref, reason: "图稿已更新" }
        : {
            status: "available",
            ref,
            revision: experimentRevision,
            title: "实验对照图",
            summary: "分析数据图稿",
            capabilities: { read: true },
          },
  });
  disposers.push(unregisterComparison);
  const target = openWorkspace(join(root, "workspaces"), "default", registry);
  let scenario: Record<string, string>;
  try {
    const commands: Command[] = [
      { op: "pack.enable", id: "research" },
      {
        op: "object.create",
        ref: "comparison",
        type: "base.board",
        title: "跨资源验收",
      },
      {
        op: "presentation.create",
        ref: "entry",
        boardId,
        objectId: "@comparison",
        x: 315,
        y: 420,
      },
      {
        op: "object.create",
        ref: "A",
        type: "research.evidence",
        title: "实验甲",
        data: { method: "实验", summary: "甲组结果" },
      },
      {
        op: "object.create",
        ref: "B",
        type: "research.evidence",
        title: "实验乙",
        data: { method: "实验", summary: "乙组结果" },
      },
      {
        op: "object.create",
        ref: "map",
        type: "base.resource_reference",
        title: "实验对照图",
        source: {
          origin: "human",
          resource: { ...experimentDrawing, revision: experimentRevision },
        },
      },
      ...["A", "B", "map"].map((id, index): Command => ({
        op: "presentation.create",
        ref: "place" + id,
        boardId: "@comparison",
        objectId: "@" + id,
        x: index * 245,
        y: 0,
        width: 206,
        height: 100,
      })),
    ];
    scenario = applyCommands(target.db, registry, {
      actor: { kind: "human", id: "comparison" },
      commands,
    }).created;
  } finally {
    target.db.close();
  }
  const entry = board.locator(`[data-instance-id="${scenario.entry}"]`);
  const enterScenario = () =>
    entry
      .getByRole("button", { name: "进入白板" })
      .evaluate((button: HTMLButtonElement) => button.click());
  await page.emulateMedia({ reducedMotion: "reduce" });
  await enterScenario();
  const cards = ["placeA", "placeB", "placemap"].map((key) =>
    board.locator(`[data-instance-id="${scenario[key]}"]`),
  );
  for (const card of cards) await card.waitFor();
  const positions = await Promise.all(cards.map((card) => card.boundingBox()));
  assert.ok(positions.every(Boolean));
  const bounds = positions as {
    x: number;
    y: number;
    width: number;
    height: number;
  }[];
  await page.keyboard.down("Shift");
  await page.mouse.move(
    Math.min(...bounds.map((r) => r.x)) - 8,
    Math.min(...bounds.map((r) => r.y)) - 8,
  );
  await page.mouse.down();
  await page.mouse.move(
    Math.max(...bounds.map((r) => r.x + r.width)) + 8,
    Math.max(...bounds.map((r) => r.y + r.height)) + 8,
    { steps: 8 },
  );
  await page.mouse.up();
  await page.keyboard.up("Shift");
  if (!(await ai.isVisible()))
    await board
      .getByRole("button", { name: "和 AI 协作", exact: true })
      .click();
  await ai.getByLabel("AI 讨论范围").selectOption("selection");
  await ai
    .getByLabel("AI 目标预览")
    .getByText("3 个对象", { exact: true })
    .waitFor();
  finishDetached = undefined;
  await input.fill("compare experiments and update the drawing");
  await ai.getByRole("button", { name: "发送", exact: true }).click();
  await board.getByRole("button", { name: "停止 AI", exact: true }).waitFor();
  const comparisonsSent = prompts.length;
  await page.goto("about:blank");
  assert.ok(finishDetached);
  (finishDetached as () => void)();
  const readScenario = async () =>
    JSON.parse(
      await tools
        .get("sand_table_read_board")
        .execute({ boardId: scenario.comparison }),
    );
  for (let attempt = 0; attempt < 80; attempt++) {
    if (JSON.stringify(await readScenario()).includes("实验对照图新版本"))
      break;
    assert.notEqual(attempt, 79, "关闭浏览器时也应写入版本化绘图引用");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await page.goto(origin);
  await cards[0].or(entry).first().waitFor();
  if (await entry.isVisible()) await enterScenario();
  if (!(await ai.isVisible()))
    await board
      .getByRole("button", { name: "和 AI 协作", exact: true })
      .click();
  const comparisonTurn = conversation
    .locator(".ai-turn")
    .filter({ hasText: "compare experiments and update the drawing" });
  await comparisonTurn
    .getByLabel("AI 任务状态")
    .getByText("已完成", { exact: true })
    .waitFor();
  await comparisonTurn.getByText("提交时的上下文", { exact: true }).click();
  await comparisonTurn
    .getByText("资源版本 map-original", { exact: true })
    .waitFor();
  const output = (await readScenario()).objects.filter(
    (object: { title: string }) => object.title === "实验对照图新版本",
  );
  assert.equal(output.length, 1);
  const updated = JSON.parse(
    await tools
      .get("sand_table_read_object")
      .execute({ boardId: scenario.comparison, objectId: output[0].id }),
  );
  assert.deepEqual(updated.source.resource, {
    ...experimentDrawing,
    revision: "map-compared",
  });
  assert.equal(updated.resource.value.status, "available");
  assert.equal(prompts.length, comparisonsSent, "跨资源任务恢复时不得重发");
  assert.deepEqual(errors, []);
  console.log(
    "HOST BROWSER PASSED: actual local service and plugin, cross-origin nested canvas, real request ID, replies remain in conversation, structured delivery, follow-up, cancellation and cross-resource recovery (scripted DSH execution fixture).",
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
