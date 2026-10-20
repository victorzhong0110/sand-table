import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
const dir = mkdtempSync(join(tmpdir(), "sand-code-"));
const service = spawn(process.execPath, ["--experimental-strip-types", "server/main.ts", "--workspace", "clsx=/workspace/sand-table"], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, SAND_WORKSPACE_DIR: join(dir, "workspaces") },
});
let logs = "";
service.stderr.on("data", (d) => (logs += d));
service.stdout.on("data", (d) => (logs += d));
await new Promise((r) => setTimeout(r, 1500));
const client = new Client({ name: "probe", version: "1" });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: ["--experimental-strip-types", "server/main.ts", "--workspace", "clsx=/workspace/sand-table"],
  env: { ...process.env, SAND_WORKSPACE_DIR: join(dir, "workspaces") } as any,
}));
const call = async (name: string, args: any) => {
  const r = await client.callTool({ name, arguments: args });
  return r;
};
const opened = await call("sand_open_board", { title: "项目总览", preset: "code" });
console.log("isError:", opened.isError);
console.log("text:", JSON.stringify(opened.content).slice(0, 600));
const data = (opened.structuredContent as any)?.data;
console.log("presentation:", data?.presentation, "| title:", data?.title, "| instances:", data?.instances?.length, "| spaces:", data?.spaces?.length);
service.kill("SIGTERM");
