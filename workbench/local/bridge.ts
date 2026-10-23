// A local stdio MCP entry point; forwards to the workbench's single shared server.
import { randomUUID } from "node:crypto";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createServer } from "../server/server.ts";
import { createServerV3 } from "../server/v3/server.ts";
import { defaultSessionFile, request } from "./session.ts";
const args = process.argv.slice(2);
if (args.length && !(args.length === 2 && args[0] === "--session-file"))
  throw Error(
    "Usage: bridge.ts [--session-file /private/path/connection.json]",
  );
const sessionFile = args[1] || defaultSessionFile,
  connectionId = randomUUID();
const touch = () =>
  request(sessionFile, "/agent/status", {
    connectionId,
    state: "connected",
  }).catch(() => undefined);
const forward = {
  tool: (name: string, arguments_: Record<string, unknown>) =>
    request(sessionFile, "/agent/rpc", {
      connectionId,
      method: "tools/call",
      params: { name, arguments: arguments_ },
    }),
  resource: () =>
    request(sessionFile, "/agent/rpc", {
      connectionId,
      method: "resources/read",
      params: { uri: "ui://sand-table/overview.html" },
    }),
};
const { server, dispose } =
  process.env.SAND_KERNEL === "v3"
    ? createServerV3({
        // 转发模式不打开工作空间：调用都交给本地服务，
        // 这里只需要一份同样的工具清单。
        workspaceRoot: process.env.SAND_WORKSPACE_DIR ?? "",
        workspaceId: process.env.SAND_WORKSPACE_ID ?? "default",
        forward,
      })
    : createServer([], forward);
await server.connect(new StdioServerTransport());
// The bridge can be installed before launching the board. It reconnects through the descriptor.
await touch();
const heartbeat = setInterval(() => void touch(), 15000);
heartbeat.unref();
async function close() {
  clearInterval(heartbeat);
  dispose();
  await request(sessionFile, "/agent/status", {
    connectionId,
    state: "disconnected",
  }).catch(() => undefined);
  await server.close();
}
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => void close().finally(() => process.exit()));
process.stdin.on("end", () => void close().finally(() => process.exit()));
