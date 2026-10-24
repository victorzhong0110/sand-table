import { createServer, type IncomingMessage } from "node:http";
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/client/stdio";
import { connectionConfig, defaultMcpEntry, type McpEntry } from "./config.ts";
import {
  readConnection,
  writeConnection,
  removeConnection,
} from "./session.ts";

/**
 * 桥接由 MCP 客户端启动，它看到的是客户端自己的环境变量。
 * 生成的条目里必须带上内核版本，桥接才会走同一套工具面。
 * 自定义条目自己的环境变量要留着，只补内核版本。
 * 默认命令和参数来自 config.ts，这里不另写一套。
 */
export function bridgeEntry(
  kernel: string | undefined,
  entry: McpEntry | undefined,
  sessionFile: string,
): McpEntry | undefined {
  if (kernel !== "v3") return entry;
  const base = entry ?? defaultMcpEntry(sessionFile);
  return {
    command: base.command,
    args: base.args,
    env: { ...base.env, SAND_KERNEL: "v3" },
  };
}

export async function startLocal(options: {
  workspaces: string[];
  sessionFile: string;
  port?: number;
  preset?: "blank" | "code";
  /** 工作空间存储目录。作品落在这里，重启后仍在。 */
  workspaceDir?: string;
  /** 工作空间 ID。 */
  workspaceId?: string;
  embedOrigins?: string[];
  /**
   * 启动 MCP 服务端子进程时附加的环境变量。
   * stdio 传输只继承白名单变量（PATH、HOME 等），自定义变量必须显式传，
   * 否则子进程会在一个没有这些变量的环境里启动。
   */
  serverEnv?: Record<string, string>;
  /** 展示给用户的 MCP 客户端条目；不传时按当前进程推导。 */
  mcpEntry?: McpEntry;
}) {
  const embedOrigins = (options.embedOrigins ?? []).map((value) => {
    const u = new URL(value);
    if (
      !["http:", "https:"].includes(u.protocol) ||
      u.origin !== value ||
      u.username ||
      u.password
    )
      throw Error("--embed-origin must be an exact http(s) origin.");
    return u.origin;
  });
  if (existsSync(options.sessionFile)) {
    const previous = readConnection(options.sessionFile);
    let alive = false;
    try {
      const response = await fetch(new URL("/health", previous.url), {
        headers: { "X-Sand-Token": previous.token },
        signal: AbortSignal.timeout(1000),
        redirect: "error",
      });
      alive = response.ok;
    } catch {}
    if (alive)
      throw Error(
        `Sand Table is already running at ${previous.url}. Stop that process before opening a different workspace.`,
      );
    unlinkSync(options.sessionFile);
  }
  const hostScript = readFileSync(
    new URL("../dist/host.js", import.meta.url),
    "utf8",
  );
  const client = new Client({
    name: "sand-table-local-workbench",
    version: "0.2.0",
  });
  const kernel = process.env.SAND_KERNEL;
  const mcpEntry = bridgeEntry(kernel, options.mcpEntry, options.sessionFile);
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        "--experimental-strip-types",
        fileURLToPath(new URL("../server/main.ts", import.meta.url)),
        ...options.workspaces.flatMap((w) => ["--workspace", w]),
        ...(options.workspaceDir
          ? ["--workspace-dir", options.workspaceDir]
          : []),
        ...(options.workspaceId ? ["--workspace-id", options.workspaceId] : []),
      ],
      // stdio 传输只继承白名单变量，内核版本要显式传过去，
      // 否则子进程会在一个没有它的环境里启动。
      env:
        kernel === "v3"
          ? {
              ...getDefaultEnvironment(),
              ...options.serverEnv,
              SAND_KERNEL: "v3",
            }
          : options.serverEnv,
    }),
  );
  let primaryBoardId: string | undefined,
    origin = "",
    closed = false;
  const token = randomBytes(24).toString("hex"),
    startedAt = Date.now();
  const connections = new Map<
    string,
    { lastSeen: number; lastTool?: string }
  >();
  const config = connectionConfig(options.sessionFile, mcpEntry);
  // The browser always attaches Origin to same-origin POSTs, so the same
  // comparison that guards /rpc also proves a request came from our own page.
  const sameOrigin = (req: IncomingMessage) => req.headers.origin === origin;
  const dispatch = async (method: string, params: any) => {
    if (method === "tools/call") return client.callTool(params);
    if (method === "resources/read") return client.readResource(params);
    throw Error("Unsupported RPC method.");
  };
  const primary = async () => {
    // v3 的工作空间启动时就打开了首页白板，没有「再打开一块板」这一步。
    if (process.env.SAND_KERNEL === "v3") {
      const r = await client.callTool({
        name: "sand_status",
        arguments: {},
      });
      if (r.isError)
        throw Error(
          (r.content as any)?.[0]?.text || "Cannot open the workspace.",
        );
      /* 界面启动时也要一个白板编号：v3 的首页白板在打开工作空间时就已经存在。 */
      const data = (r as any).structuredContent?.data ?? {};
      return {
        ...r,
        _meta: {
          ...((r as any)._meta ?? {}),
          data: { ...data, id: data.homeBoardId },
        },
      };
    }
    if (primaryBoardId) {
      const r = await client.callTool({
        name: "sand_read_board",
        arguments: { boardId: primaryBoardId },
      });
      if (!r.isError) return r;
    }
    const r = await client.callTool({
      name: "sand_open_board",
      arguments: {
        title: options.preset === "code" ? "项目总览" : "未命名白板",
        preset: options.preset || "blank",
      },
    });
    if (r.isError)
      throw Error((r.content as any)?.[0]?.text || "Cannot index repository.");
    primaryBoardId = (r.structuredContent as any).data.id;
    return r;
  };
  function pruneConnections() {
    for (const [id, c] of connections)
      if (Date.now() - c.lastSeen >= 45000) connections.delete(id);
  }
  const status = () => {
    pruneConnections();
    return {
      connections: [...connections.entries()]
        .filter(([, c]) => Date.now() - c.lastSeen < 45000)
        .map(([id, c]) => ({ id, ...c })),
      startedAt,
      boardId: primaryBoardId,
    };
  };
  const http = createServer(async (req, res) => {
    const json = (data: unknown, code = 200) => {
      res.writeHead(code, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(data));
    };
    try {
      if (req.headers.host !== new URL(origin).host) {
        res.writeHead(403).end();
        return;
      }
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("Cache-Control", "no-store");
      // Routes are matched on the path: a credential may arrive as a query
      // parameter (?session=…), and the query must not change the route.
      const path = (req.url || "/").split("?")[0];
      if (req.method === "GET" && (path === "/" || path === "/embed")) {
        if (path === "/embed" && !embedOrigins.length) {
          json(
            {
              error:
                "Embedding is disabled. Start with --embed-origin <DSH origin>.",
            },
            403,
          );
          return;
        }
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader(
          "Content-Security-Policy",
          `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self'; img-src 'self' data:; media-src data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors ${path === "/embed" ? embedOrigins.join(" ") : "'none'"}`,
        );
        res.end(
          `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sand Table · 本地工作台</title><style>${css}${path === "/embed" ? "body>nav{display:none}" : ""}</style></head><body><nav><b>本地会话</b><span id="connection">正在连接工作台…</span><button id="setup">连接我的 AI</button><button id="new-board">重新连接</button></nav><section id="setup-panel" hidden><h1>和你自己的 AI 共用这张白板</h1><p>在本机 MCP 客户端中安装一次，然后在它的对话里提问。白板不自带模型，也不需要新的 API Key。</p><p class="muted">装一次就够：工作台重启后客户端无需改配置即可自动跟随（前提是 MCP 配置里的 --session-file 与本实例用的是同一份文件）。如果你的宿主是在会话进行中才注册 MCP，可能需要重开一次宿主会话才能看到新工具。浏览器与 MCP 客户端共享同一张板、同一份 revision 计数；Agent 侧的"读→写→读回"宜在同一次连接内完成。</p><label>Codex CLI 安装命令<textarea id="codex" readonly></textarea></label><button data-copy="codex">复制命令</button><details><summary>通用 MCP JSON / Codex TOML</summary><label>JSON<textarea id="json" readonly></textarea></label><button data-copy="json">复制 JSON</button><label>TOML<textarea id="toml" readonly></textarea></label><button data-copy="toml">复制 TOML</button></details><label>安装后，在 AI 对话中发送<textarea id="prompt" readonly></textarea></label><button data-copy="prompt">复制这条消息</button><label>选区提问<textarea id="ask-text" readonly></textarea></label><button id="ask">复制当前选区提问</button><p id="setup-status" role="status"></p><p class="muted">这里显示 MCP 接入进程与工具通信，不代表 AI 正在思考。浏览器聊天网页不能直接读取本机 stdio 配置；请使用本机 MCP 客户端。无需把此服务暴露到公网。</p><button id="close-setup">返回白板</button></section><div id="error" role="alert" hidden><span id="error-text"></span><button id="retry" type="button">重新连接</button></div><div id="board-stage"><iframe title="Sand Table 白板" sandbox="allow-scripts"></iframe><p id="opening" role="status" hidden>正在打开白板…</p></div><script src="/host.js"></script></body></html>`,
        );
        return;
      }
      if (req.method === "GET" && path === "/host.js") {
        res
          .writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" })
          .end(hostScript);
        return;
      }
      // Credential self-heal: only a request that our own page issued
      // (same host + same origin) may ask for the current session token.
      if (req.method === "POST" && path === "/session") {
        if (!sameOrigin(req)) {
          json({ error: "Origin rejected" }, 403);
          return;
        }
        json({ token, url: origin + "/" });
        return;
      }
      if (req.headers["x-sand-token"] !== token) {
        json({ error: "Session authorization required." }, 403);
        return;
      }
      if (req.method === "GET" && path === "/health") {
        json({ ok: true });
        return;
      }
      if (req.method !== "POST") {
        json({ error: "Unsupported route" }, 404);
        return;
      }
      const agentRoute = path === "/agent/rpc" || path === "/agent/status";
      if (
        agentRoute
          ? req.headers.origin !== undefined
          : req.headers.origin !== origin
      ) {
        json({ error: "Origin rejected" }, 403);
        return;
      }
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 4_000_000) {
          json({ error: "Request too large" }, 413);
          return;
        }
      }
      const data = JSON.parse(body || "{}");
      if (agentRoute) {
        pruneConnections();
        if (connections.size >= 64 && !connections.has(data.connectionId)) {
          json({ error: "Too many active MCP connections" }, 429);
          return;
        }
        if (
          typeof data.connectionId !== "string" ||
          data.connectionId.length > 80
        ) {
          json({ error: "Invalid connection identity" }, 400);
          return;
        }
        if (path === "/agent/status") {
          if (data.state === "disconnected")
            connections.delete(data.connectionId);
          else
            connections.set(data.connectionId, {
              ...connections.get(data.connectionId),
              lastSeen: Date.now(),
            });
          json({ ok: true });
          return;
        }
        connections.set(data.connectionId, {
          lastSeen: Date.now(),
          lastTool:
            typeof data.params?.name === "string"
              ? data.params.name.slice(0, 100)
              : data.method,
        });
        json(await dispatch(data.method, data.params));
        return;
      }
      if (path === "/bootstrap") {
        json({ boardResult: await primary(), config, status: status() });
        return;
      }
      if (path === "/status") {
        json(status());
        return;
      }
      if (path === "/rpc") {
        json(await dispatch(data.method, data.params));
        return;
      }
      json({ error: "Unsupported route" }, 404);
    } catch (e) {
      json({ error: e instanceof Error ? e.message : "Request failed" }, 400);
    }
  });
  async function close() {
    if (closed) return;
    closed = true;
    removeConnection(options.sessionFile, token);
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await client.close();
  }
  try {
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(options.port || 0, "127.0.0.1", () => resolve());
    });
    const address = http.address();
    if (!address || typeof address === "string")
      throw Error("Cannot bind local workbench.");
    origin = `http://127.0.0.1:${address.port}`;
    writeConnection(options.sessionFile, {
      url: origin + "/",
      token,
      link: origin + "/#session=" + token,
      pid: process.pid,
      startedAt,
    });
    await primary();
  } catch (e) {
    await close();
    throw e;
  }
  return {
    url: origin + "/#session=" + token,
    close,
    sessionFile: options.sessionFile,
  };
}
const css = `html{scrollbar-width:none}html::-webkit-scrollbar{display:none}body{height:100dvh;overflow:hidden;display:flex;flex-direction:column}body>nav{flex-shrink:0}body>iframe{flex:1;min-height:0;height:auto}#setup-panel{overflow:auto;scrollbar-width:none}#setup-panel::-webkit-scrollbar{display:none}*[hidden]{display:none!important}*{box-sizing:border-box}body{margin:0;background:#f6f1e6;color:#322f28;font:14px/1.6 system-ui,sans-serif}nav{display:flex;align-items:center;gap:16px;padding:10px 20px;background:#fffdf7;color:#322f28;border-bottom:1px solid #ddd5c4;min-height:44px}nav span{flex:1;font-size:12px}button{cursor:pointer;border:1px solid #d9d0be;border-radius:6px;padding:7px 12px;background:#fffdf7;color:#322f28;font:inherit}button:focus-visible,textarea:focus-visible{outline:2px solid #b67547;outline-offset:3px}iframe{border:0;width:100%;height:calc(100vh - 44px);display:block}section{padding:28px;max-width:900px;margin:auto}textarea{display:block;width:100%;min-height:84px;padding:12px;border:1px solid #ddd5c4;border-radius:8px;background:#fffdf7;font:12px/1.6 ui-monospace,monospace;color:inherit;resize:vertical;margin:6px 0 10px}label{display:block;margin-top:18px}details{margin-top:20px}summary{cursor:pointer}.muted{color:#777366;font-size:12px}#error{padding:16px;background:#fbe7e1;color:#833c28;display:flex;gap:12px;align-items:center;flex-wrap:wrap}#error-text{flex:1;white-space:pre-wrap}#setup-status{min-height:24px}h1{font-weight:500;font-size:28px}@media(max-width:600px){nav{flex-wrap:wrap;gap:8px}nav span{flex-basis:70%}iframe{height:calc(100vh - 90px)}section{padding:18px}}#board-stage{position:relative;flex:1;min-height:0;display:flex}#board-stage>iframe{flex:1;min-height:0;width:100%;height:100%}#opening{position:absolute;inset:0;z-index:2;margin:0;display:flex;align-items:center;justify-content:center;background:#f6f1e6;color:#322f28;font-size:16px}`;
