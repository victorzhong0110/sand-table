import { resolve, basename } from "node:path";
import { spawn } from "node:child_process";
import { bind } from "../server/repository.ts";
import { startLocal } from "./service.ts";
import { defaultSessionFile } from "./session.ts";
let open = true,
  port = 0,
  sessionFile = defaultSessionFile,
  preset: "blank" | "code" = "blank";
const roots: string[] = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--code-board") preset = "code";
  else if (arg === "--no-open") open = false;
  else if (["--workspace", "--port", "--session-file"].includes(arg)) {
    const value = args[++i];
    if (!value) throw Error(`Missing value for ${arg}`);
    if (arg === "--workspace") roots.push(value);
    else if (arg === "--session-file") sessionFile = resolve(value);
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
try {
  const local = await startLocal({
    workspaces: bindings.map((w) => `${w.label}=${w.root}`),
    sessionFile,
    port,
    preset,
  });
  console.log(
    `\nSand Table 已就绪：${local.url}\n在页面点击「连接我的 AI」安装 MCP 连接。保持这个终端运行；Ctrl+C 结束会话。\nREADY ${local.url}`,
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
