import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import {
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { chromium } from "playwright";
import { repoRoot } from "./lib.mjs";

const CHUNK_TEXT = "globalThis.__chunk=1";
const UI_CHUNK = "ui://sand-table/chunks/probe.js";
const PLAIN_CHUNK = "sand-table://chunks/probe.js";

function summarize(result) {
  const content = result?.contents?.[0];
  return {
    uri: content?.uri,
    mimeType: content?.mimeType,
    bytes: typeof content?.text === "string" ? Buffer.byteLength(content.text) : 0,
    textIsChunk: content?.text === CHUNK_TEXT,
  };
}

async function readOrError(client, uri) {
  try {
    return { ok: true, resource: summarize(await client.readResource({ uri })) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 同一个 SDK 上注册 HTML 界面和脚本文本，看 resources/read 是否原样返回。 */
export async function probeSdk() {
  const server = new McpServer({ name: "t41-spike", version: "0" });
  registerAppResource(
    server,
    "overview",
    "ui://sand-table/overview.html",
    {},
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: RESOURCE_MIME_TYPE,
          text: "<!doctype html><title>overview</title>",
        },
      ],
    }),
  );
  const chunk = async (uri) => ({
    contents: [
      { uri: uri.href, mimeType: "text/javascript", text: CHUNK_TEXT },
    ],
  });
  server.registerResource(
    "ui chunk",
    UI_CHUNK,
    { mimeType: "text/javascript" },
    chunk,
  );
  server.registerResource(
    "plain chunk",
    PLAIN_CHUNK,
    { mimeType: "text/javascript" },
    chunk,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t41-spike", version: "0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  try {
    const listed = await client.listResources();
    return {
      registeredMime: RESOURCE_MIME_TYPE,
      listed: (listed.resources ?? []).map((resource) => ({
        uri: resource.uri,
        mimeType: resource.mimeType,
      })),
      overview: await readOrError(client, "ui://sand-table/overview.html"),
      uiChunk: await readOrError(client, UI_CHUNK),
      plainChunk: await readOrError(client, PLAIN_CHUNK),
    };
  } finally {
    await client.close();
  }
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    once(child, "exit").then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 5000)),
  ]);
  if (!exited) child.kill("SIGKILL");
}

async function rpc(origin, token, method, params) {
  const response = await fetch(`${origin}/rpc`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      "X-Sand-Token": token,
    },
    body: JSON.stringify({ method, params }),
  });
  return { status: response.status, text: await response.text() };
}

/** 拉起当前本地工作台，看整页内联是否能打开，以及 chunk 资源是否可读。 */
export async function probeLocalHost() {
  const dir = mkdtempSync(join(tmpdir(), "sand-t41-host-"));
  const sessionFile = join(dir, "connection.json");
  const workspaceDir = join(dir, "workspaces");
  const port = 46000 + Math.floor(Math.random() * 1000);
  const child = spawn(
    process.execPath,
    [
      join(repoRoot, "scripts/start-workbench.mjs"),
      "--no-open",
      "--port",
      String(port),
      "--session-file",
      sessionFile,
      "--workspace-dir",
      workspaceDir,
      "--workspace-id",
      "t41-spike",
    ],
    {
      cwd: join(repoRoot, "workbench"),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NODE_ENV: "development" },
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(output.slice(-2000) || "本地工作台没有就绪")),
      120000,
    );
    const watch = () => {
      const match = output.match(/READY (http:\/\/127\.0\.0\.1:\d+\/#session=\w+)/);
      if (!match) return;
      clearTimeout(timer);
      resolve(match[1]);
    };
    child.stdout.on("data", watch);
    child.stderr.on("data", watch);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`工作台退出 ${code}: ${output.slice(-2000)}`));
    });
    watch();
  });
  const readyUrl = new URL(ready);
  const origin = readyUrl.origin;
  const token = readyUrl.hash.slice("#session=".length);
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/google-chrome",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 800 },
    });
    page.setDefaultTimeout(30000);
    await page.goto(ready);
    const frame = page.frameLocator("iframe");
    await frame.getByRole("heading", { name: "从一块空白开始" }).waitFor({
      timeout: 20000,
    });
    const appFrame = page.frames().find((item) => item !== page.mainFrame());
    if (!appFrame) throw new Error("没有白板 iframe");
    const view = await appFrame.evaluate(async () => {
      const csp =
        document
          .querySelector('meta[http-equiv="Content-Security-Policy"]')
          ?.getAttribute("content") ?? null;
      const heading = document.querySelector("h1")?.textContent ?? "";
      const bridge = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ timeout: true }), 3000);
        window.addEventListener("message", (event) => {
          if (!event.data || event.data.id !== 424242) return;
          clearTimeout(timer);
          resolve({
            timeout: false,
            error: event.data.error ?? null,
            hasResult: event.data.result !== undefined,
          });
        });
        window.parent.postMessage(
          {
            jsonrpc: "2.0",
            id: 424242,
            method: "resources/read",
            params: { uri: "ui://sand-table/chunks/probe.js" },
          },
          "*",
        );
      });
      return { csp, heading, bridge };
    });
    const overview = await rpc(origin, token, "resources/read", {
      uri: "ui://sand-table/overview.html",
    });
    const chunk = await rpc(origin, token, "resources/read", { uri: UI_CHUNK });
    let overviewMeta = { ok: false };
    try {
      const parsed = JSON.parse(overview.text);
      const content = parsed.contents?.[0];
      overviewMeta = {
        ok: typeof content?.text === "string",
        mimeType: content?.mimeType ?? "",
        bytes:
          typeof content?.text === "string"
            ? Buffer.byteLength(content.text)
            : 0,
        hasRoot:
          typeof content?.text === "string" && content.text.includes('id="root"'),
      };
    } catch (error) {
      overviewMeta = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    return {
      origin,
      boardRendered: view.heading === "从一块空白开始",
      csp: view.csp,
      viewBridge: view.bridge,
      overview: { status: overview.status, ...overviewMeta },
      chunk: { status: chunk.status, body: chunk.text.slice(0, 500) },
    };
  } finally {
    await browser.close();
    await stop(child);
  }
}
