// 桌面版冒烟检查：用 Playwright 启动真实的 Electron 应用，
// 确认窗口确实打开了本地工作台、白板渲染出来、会话凭据有效。
//
// 用法：
//   node desktop/scripts/smoke.mjs                     # 用仓库里的 workbench/
//   node desktop/scripts/smoke.mjs --workbench <目录>    # 用别的目录（例如打包后的布局）
// 截图落在 desktop/dist/smoke/ 下，作为「窗口里真的有东西」的证据。

import { mkdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const outputDir = join(desktopRoot, "dist", "smoke");
const sessionDir = join(desktopRoot, "dist", "smoke", "session");

const workbenchArg = process.argv.indexOf("--workbench");
const workbenchRoot =
  workbenchArg === -1 ? undefined : resolve(process.argv[workbenchArg + 1]);

mkdirSync(outputDir, { recursive: true });
mkdirSync(join(outputDir, "user"), { recursive: true, mode: 0o700 });
// 会话文件要求目录只有本人可读写。
mkdirSync(sessionDir, { recursive: true, mode: 0o700 });

const failures = [];
let savedEntry;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? " · " + detail : ""}`);
  if (!ok) failures.push(name);
};

const executableArg = process.argv.indexOf("--executable");
const executablePath =
  executableArg < 0 ? undefined : resolve(process.argv[executableArg + 1]);
const app = await electron.launch({
  ...(executablePath ? { executablePath } : {}),
  args: executablePath ? [] : [desktopRoot],
  cwd: desktopRoot,
  env: {
    ...process.env,
    // 沙箱里以 root 跑，Chromium 拒绝在没有 --no-sandbox 时启动。
    ELECTRON_DISABLE_SANDBOX: "1",
    SAND_DESKTOP_LOG: "1",
    SAND_DESKTOP_SMOKE: "1",
    SAND_DESKTOP_USER_DATA: join(outputDir, "user"),
    SAND_WORKSPACE_DIR: join(outputDir, "workspaces"),
    ...(workbenchRoot ? { SAND_DESKTOP_WORKBENCH: workbenchRoot } : {}),
  },
});

try {
  const window = await app.firstWindow({ timeout: 60000 });
  // 先等窗口从加载页切到本地工作台，再做页面内的检查。
  await window.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//, { timeout: 90000 });
  await window.waitForLoadState("domcontentloaded");

  // 1) 窗口标题与地址
  // 页面加载后会把凭据片段从地址栏去掉，所以这里只看本地地址。
  const url = window.url();
  check(
    "窗口打开了本地工作台",
    /^http:\/\/127\.0\.0\.1:\d+\/?$/.test(url),
    url,
  );

  // 2) 宿主页面渲染出来了
  await window.waitForSelector("nav #connection", { timeout: 30000 });
  const connection = await window.textContent("nav #connection");
  check(
    "本地会话状态可见",
    !!connection && connection.trim().length > 0,
    connection?.trim(),
  );

  // 3) 白板 iframe 真的挂上了
  await window.waitForSelector("#board-stage iframe", { timeout: 30000 });
  const frame = window.frameLocator("#board-stage iframe");
  await frame.locator("body").waitFor({ timeout: 30000 });
  const bodyText = (await frame.locator("body").innerText()).slice(0, 400);
  check(
    "白板画布已渲染",
    bodyText.length > 0,
    bodyText.replace(/\s+/g, " ").slice(0, 80),
  );

  // 4) 工具箱里的组件分组在（空白板也要有可用的左侧工具箱）
  const hasToolbox = (await frame.locator("text=组件").count()) > 0;
  check("左侧组件工具箱存在", hasToolbox);

  // 5) MCP 配置可用：/bootstrap 应当返回可用的连接配置
  // 本地 API 用会话凭据做授权，先按页面的做法换到令牌。
  const session = await window.evaluate(async () => {
    const response = await fetch("/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    return { status: response.status, body: await response.json() };
  });
  check("换到会话令牌", session.status === 200 && !!session.body?.token);
  const bootstrap = await window.evaluate(async (token) => {
    const response = await fetch("/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sand-Token": token },
      body: "{}",
    });
    return { status: response.status, body: await response.json() };
  }, session.body?.token);
  check(
    "本地 API 返回会话配置",
    bootstrap.status === 200 && !!bootstrap.body?.config?.json,
    `status=${bootstrap.status}`,
  );
  const config = JSON.parse(bootstrap.body?.config?.json ?? "{}");
  const entry = config?.mcpServers?.["sand-table"];
  savedEntry = entry;
  check(
    "MCP 配置指向桌面版自身",
    !!entry?.command &&
      existsSync(entry.command) &&
      !!entry?.env?.ELECTRON_RUN_AS_NODE,
    entry ? `command=${entry.command}` : "缺少条目",
  );

  // 6) 工作空间落盘位置
  const workspaceSaved = await window.evaluate(async (token) => {
    const response = await fetch("/status", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sand-Token": token },
      body: "{}",
    });
    return response.status;
  }, session.body?.token);
  check("本地服务状态可查", workspaceSaved === 200);

  await window.screenshot({ path: join(outputDir, "desktop-window.png") });
  console.log(`截图：${join(outputDir, "desktop-window.png")}`);
} finally {
  await app.close().catch(() => undefined);
}

if (savedEntry) {
  const runtime = spawnSync(savedEntry.command, ["--version"], {
    env: { ...process.env, ...savedEntry.env },
    encoding: "utf8",
    timeout: 15000,
    windowsHide: true,
  });
  check(
    "关闭窗口后 MCP 运行时仍可启动",
    runtime.status === 0 && /^v\d+/.test(runtime.stdout ?? ""),
    runtime.stderr || runtime.error?.message || "",
  );
  check("关闭窗口后桥接脚本仍存在", existsSync(savedEntry.args[1]));
}
if (failures.length) {
  console.error(`\n冒烟检查失败：${failures.length} 项`);
  process.exit(1);
}
console.log("\n冒烟检查全部通过。");
if (!existsSync(outputDir)) process.exit(1);
