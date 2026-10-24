import { resolve, basename } from "node:path";
import { spawn } from "node:child_process";
import { bind } from "../connectors/git.ts";
import { startLocal } from "./service.ts";
import { defaultSessionFile } from "./session.ts";
import type { McpEntry } from "./config.ts";
let open = false,
  port = 0,
  sessionFile = defaultSessionFile,
  workspaceDir: string | undefined = process.env.SAND_WORKSPACE_DIR
    ? resolve(process.env.SAND_WORKSPACE_DIR)
    : undefined,
  workspaceId: string | undefined = process.env.SAND_WORKSPACE_ID,
  preset: "blank" | "code" = "blank";
let folder = "";
type LocalRuntime = { serverEnv?: Record<string, string>; mcpEntry?: McpEntry };
let runtime: LocalRuntime | undefined;
const readRuntime = (raw: string): LocalRuntime => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw Error("Invalid runtime descriptor: it must be a JSON object.");
  }
  if (!parsed || typeof parsed !== "object")
    throw Error("Invalid runtime descriptor.");
  return parsed as LocalRuntime;
};
// 桌面版把自身的可执行文件当作运行时来跑服务端与桥接进程，
// 需要的启动方式通过 --runtime 或 SAND_RUNTIME 显式传进来。
if (process.env.SAND_RUNTIME) runtime = readRuntime(process.env.SAND_RUNTIME);
const roots: string[] = [];
const embedOrigins: string[] = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--code-board") preset = "code";
  else if (arg === "--open") open = true;
  else if (arg === "--no-open") open = false;
  else if (arg === "--runtime") {
    const value = args[++i];
    if (!value) throw Error("Missing value for --runtime");
    runtime = readRuntime(value);
  } else if (
    [
      "--workspace",
      "--port",
      "--session-file",
      "--workspace-dir",
      "--workspace-id",
      "--embed-origin",
      "--folder",
    ].includes(arg)
  ) {
    const value = args[++i];
    if (!value) throw Error(`Missing value for ${arg}`);
    if (arg === "--embed-origin") embedOrigins.push(value);
    else if (arg === "--workspace") roots.push(value);
    else if (arg === "--session-file") sessionFile = resolve(value);
    else if (arg === "--workspace-dir") workspaceDir = resolve(value);
    else if (arg === "--workspace-id") workspaceId = value;
    else if (arg === "--folder") folder = resolve(value);
    else {
      port = Number(value);
      if (!Number.isInteger(port) || port < 0 || port > 65535)
        throw Error("Invalid port");
    }
  } else if (arg.startsWith("-")) throw Error(`Unknown option: ${arg}`);
  else {
    const root = resolve(arg);
    roots.push(
      `${
        basename(root)
          .replace(/[^\w-]/g, "-")
          .slice(0, 40) || "project"
      }=${root}`,
    );
  }
}
const bindings = roots.length ? bind(roots) : [];
if (folder) {
  if (process.env.SAND_KERNEL !== "v3")
    throw Error("绑定文件夹需要先设置 SAND_KERNEL=v3，再带 --folder 启动。");
  process.env.SAND_FOLDER = folder;
}
try {
  const local = await startLocal({
    workspaces: bindings.map((w) => `${w.label}=${w.root}`),
    sessionFile,
    port,
    preset,
    workspaceDir,
    workspaceId,
    embedOrigins,
    ...(runtime?.serverEnv ? { serverEnv: runtime.serverEnv } : {}),
    ...(runtime?.mcpEntry ? { mcpEntry: runtime.mcpEntry } : {}),
  });
  console.log(
    [
      "",
      "Sand Table 已就绪：",
      local.url,
      "",
      "复制上面这行完整链接到浏览器打开（#session= 片段是本机凭据，不要转发给别人）。",
      open
        ? "已按 --open 打开系统浏览器。"
        : "默认不打开系统浏览器，避免打断你正在做的事。想让它自动打开：加 --open 重新启动，例：npm start -- --open /absolute/path/to/repository",
      "兼容性：旧版本 npm start 会自动打开浏览器；现在默认不打开，需要时用 --open 恢复。",
      "",
      "在页面点击「连接我的 AI」安装 MCP 连接。保持这个终端运行；Ctrl+C 结束会话。",
      `READY ${local.url}`,
    ].join("\n"),
  );
  if (open) {
    const command =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "rundll32"
          : "xdg-open";
    const params =
      process.platform === "win32"
        ? ["url.dll,FileProtocolHandler", local.url]
        : [local.url];
    const child = spawn(command, params, { stdio: "ignore" });
    child.on("error", () => console.log(`请在浏览器打开 ${local.url}`));
    child.unref();
  }
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.once(
      signal,
      () => void local.close().finally(() => process.exit()),
    );
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
