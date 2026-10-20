import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { bind } from "./repository.ts";
import { createServer } from "./server.ts";
import { homedir } from "node:os";
import { join } from "node:path";
const args = process.argv.slice(2);
const roots: string[] = [];
let workspaceDir = process.env.SAND_WORKSPACE_DIR;
let workspaceId = process.env.SAND_WORKSPACE_ID || "default";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--workspace" && args[i + 1]) {
    roots.push(args[++i]);
    continue;
  }
  if (args[i] === "--workspace-dir" && args[i + 1]) {
    workspaceDir = args[++i];
    continue;
  }
  if (args[i] === "--workspace-id" && args[i + 1]) {
    workspaceId = args[++i];
    continue;
  }
  throw Error(
    "Usage: --workspace label=/absolute/git/root (repeat up to four) [--workspace-dir path] [--workspace-id id]",
  );
}
const root = workspaceDir || join(homedir(), ".sand-table", "workspaces");
const { server } = createServer(roots.length ? bind(roots) : [], undefined, {
  workspaceRoot: root,
  workspaceId,
});
await server.connect(new StdioServerTransport());
