import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createServerV3 } from "./server.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
const args = process.argv.slice(2);
const roots: string[] = [];
let workspaceDir = process.env.SAND_WORKSPACE_DIR;
let workspaceId = process.env.SAND_WORKSPACE_ID;
let folderArg = "";
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
  if (args[i] === "--folder" && args[i + 1]) {
    folderArg = args[++i] ?? "";
    continue;
  }
  throw Error(
    "用法：--workspace 标签=/绝对路径（最多四个）[--workspace-dir 目录] [--workspace-id 编号] [--folder /绝对目录]",
  );
}
const root = workspaceDir || join(homedir(), ".sand-table", "workspaces");
// 工作空间按项目分：带了 --workspace 就用这些参数派生编号，避免两个项目的内容混在一起；
// 空白启动用 default 作为个人草稿。可用 --workspace-id / SAND_WORKSPACE_ID 显式指定。
const derived = roots.length
  ? "project-" +
    createHash("sha256").update(roots.join("|")).digest("hex").slice(0, 12)
  : "default";
const folder = folderArg || process.env.SAND_FOLDER?.trim() || "";
const { server } = createServerV3({
  workspaceRoot: root,
  workspaceId: workspaceId || derived,
  ...(folder ? { folder } : {}),
});
await server.connect(new StdioServerTransport());
