import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { bind } from "../connectors/git.ts";
import { createServer } from "./server.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
const args = process.argv.slice(2);
const roots: string[] = [];
let workspaceDir = process.env.SAND_WORKSPACE_DIR;
let workspaceId = process.env.SAND_WORKSPACE_ID;
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
// 工作空间按项目分：绑定了仓库就用仓库派生，避免两个项目的内容混在一起；
// 空白启动用 default 作为个人草稿。可用 --workspace-id / SAND_WORKSPACE_ID 显式指定。
const derived = roots.length
  ? "project-" +
    createHash("sha256").update(roots.join("|")).digest("hex").slice(0, 12)
  : "default";
const { server } = createServer(roots.length ? bind(roots) : [], undefined, {
  workspaceRoot: root,
  workspaceId: workspaceId || derived,
});
await server.connect(new StdioServerTransport());
