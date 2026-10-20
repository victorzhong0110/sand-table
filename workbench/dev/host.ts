// Development protocol harness, not an AI client or a production MCP App host.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
const port = Number(process.env.PORT || 4317);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw Error("Invalid PORT");
const origin = `http://127.0.0.1:${port}`,
  token = randomBytes(24).toString("hex");
const client = new Client({
  name: "sand-table-protocol-harness",
  version: "0.1.0",
});
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [
      "--experimental-strip-types",
      fileURLToPath(new URL("../server/main.ts", import.meta.url)),
      // MCP 的 stdio 子进程只继承白名单环境变量：工作空间设置必须显式传过去，
      // 否则服务端会落到默认目录，和别的进程共用同一块工作空间。
      ...(process.env.SAND_WORKSPACE_DIR
        ? ["--workspace-dir", process.env.SAND_WORKSPACE_DIR]
        : []),
      ...(process.env.SAND_WORKSPACE_ID
        ? ["--workspace-id", process.env.SAND_WORKSPACE_ID]
        : []),
      ...process.argv.slice(2),
    ],
  }),
);
const bundle = await build({
  configFile: false,
  logLevel: "error",
  build: {
    write: false,
    minify: true,
    lib: {
      entry: fileURLToPath(new URL("./client.ts", import.meta.url)),
      formats: ["iife"],
      name: "Harness",
    },
  },
});
const built = Array.isArray(bundle) ? bundle[0] : bundle;
const code =
  "output" in built ? built.output.find((x) => x.type === "chunk")?.code : "";
const server = createServer(async (req, res) => {
  try {
    if (req.headers.host !== `127.0.0.1:${port}`) {
      res.writeHead(403).end();
      return;
    }
    if (req.method === "GET" && req.url === "/") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(
        `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font:12px system-ui;background:#222;color:#fff}nav{padding:10px;display:flex;gap:24px;align-items:center}iframe{border:0;width:100%;height:calc(100vh - 44px)}pre{max-height:180px;overflow:auto}</style></head><body><nav>LOCAL PROTOCOL HARNESS · 没有连接 AI 模型 <button id="read">测试客户端读取选区</button></nav><pre id="context" hidden></pre><iframe title="Sand Table" sandbox="allow-scripts"></iframe><script>window.__token=${JSON.stringify(token)}</script><script>${code}</script></body></html>`,
      );
      return;
    }
    if (
      req.method !== "POST" ||
      req.url !== "/rpc" ||
      req.headers.origin !== origin ||
      req.headers["x-sand-token"] !== token
    ) {
      res.writeHead(403).end();
      return;
    }
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 4_000_000) {
        res.writeHead(413).end();
        return;
      }
    }
    const { method, params } = JSON.parse(body);
    const result =
      method === "tools/call"
        ? await client.callTool(params)
        : method === "resources/read"
          ? await client.readResource(params)
          : null;
    if (!result) throw Error("Unsupported method");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(result));
  } catch (e) {
    res.writeHead(400, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        error: e instanceof Error ? e.message : "Request failed",
      }),
    );
  }
});
server.listen(port, "127.0.0.1", () => console.log(`READY ${origin}`));
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    server.close();
    void client.close().finally(() => process.exit());
  });
