// Sand Table 桌面版主进程。
//
// 桌面版不重写工作台：它用同一个可执行文件充当 Node 运行时，
// 启动 workbench/local/main.ts（本地工作台），再把它的页面装进一个原生窗口。
// 窗口里看到的就是浏览器里那一版：同一份前端、同一个本地服务、同一份工作空间。

const { app, BrowserWindow, Menu, dialog, shell } = require("electron");
const { spawn } = require("node:child_process");
const { existsSync, mkdirSync } = require("node:fs");
const path = require("node:path");

const isPackaged = app.isPackaged;
// 打包后工作台在 resources/workbench，开发时在仓库的 workbench/。
const workbenchRoot = isPackaged
  ? path.join(process.resourcesPath, "workbench")
  : path.join(__dirname, "..", "..", "workbench");
const sessionFile = path.join(app.getPath("userData"), "session", "connection.json");

let service = null;
let mainWindow = null;
let quitting = false;

function log(message) {
  if (process.env.SAND_DESKTOP_LOG) console.log(`[sand-table] ${message}`);
}

// 工作台需要 dist/board.html 与 dist/host.js；缺失说明这一份构建不完整。
function assertBuilt() {
  for (const file of ["dist/board.html", "dist/host.js", "local/main.ts"]) {
    if (!existsSync(path.join(workbenchRoot, file)))
      throw Error(
        `工作台没有构建完整：缺少 ${file}。请在 workbench/ 目录执行 npm run build 后重试。`,
      );
  }
}

function startService() {
  const bridge = path.join(workbenchRoot, "local", "bridge.ts");
  // 会话文件所在目录要求只有本人可读写（Windows 上这项检查不生效）。
  mkdirSync(path.dirname(sessionFile), { recursive: true, mode: 0o700 });
  // MCP 客户端与工作台服务端都用这个可执行文件当 Node 运行时，
  // ELECTRON_RUN_AS_NODE 让它不做界面、只跑脚本。
  const runtime = {
    serverEnv: { ELECTRON_RUN_AS_NODE: "1" },
    mcpEntry: {
      command: process.execPath,
      args: [
        "--experimental-strip-types",
        bridge,
        "--session-file",
        sessionFile,
      ],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    },
  };
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      path.join(workbenchRoot, "local", "main.ts"),
      "--session-file",
      sessionFile,
      "--port",
      "0",
    ],
    {
      cwd: workbenchRoot,
      env: {
        ...process.env,
        // 这个子进程要的是 Node 行为，不是界面。
        ELECTRON_RUN_AS_NODE: "1",
        SAND_RUNTIME: JSON.stringify(runtime),
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => log(`工作台：${String(chunk).trimEnd()}`));
  return child;
}

function stopService() {
  if (!service || service.killed) return;
  service.kill();
  service = null;
}

function loadingPage(message) {
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>Sand Table</title><style>
html,body{height:100%;margin:0}
body{display:flex;align-items:center;justify-content:center;background:#f6f1e6;color:#322f28;
font:14px/1.7 system-ui,"Microsoft YaHei",sans-serif}
main{max-width:520px;padding:32px;text-align:center}
h1{font-size:19px;font-weight:600;margin:0 0 10px}
p{margin:0;color:#6d675b}
.dot{width:10px;height:10px;border-radius:50%;background:#b67547;display:inline-block;
animation:pulse 1.4s ease-in-out infinite;margin-right:8px;vertical-align:middle}
@keyframes pulse{0%,100%{opacity:.25}50%{opacity:1}}
</style></head><body><main><h1>${message}</h1>
<p><span class="dot"></span>正在准备本地工作台…</p></main></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function errorPage(detail) {
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>Sand Table</title><style>
html,body{height:100%;margin:0}
body{display:flex;align-items:center;justify-content:center;background:#f6f1e6;color:#322f28;
font:14px/1.7 system-ui,"Microsoft YaHei",sans-serif}
main{max-width:560px;padding:32px}
h1{font-size:18px;font-weight:600;margin:0 0 12px}
pre{background:#fffdf7;border:1px solid #ddd5c4;border-radius:8px;padding:12px;
white-space:pre-wrap;word-break:break-word;font:12px/1.6 ui-monospace,Consolas,monospace;color:#6d675b}
</style></head><body><main><h1>本地工作台没有启动</h1><pre>${detail}</pre></main></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 860,
    minHeight: 560,
    show: false,
    backgroundColor: "#f6f1e6",
    title: "Sand Table",
    icon: path.join(__dirname, "..", "build", "icon.png"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  window.once("ready-to-show", () => window.show());
  // 页面只在本地工作台内活动；站外链接交给系统浏览器。
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("http://127.0.0.1:")) {
      event.preventDefault();
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
    }
  });
  return window;
}

function waitForReady(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      reject(Error(`本地工作台在 ${Math.round(timeoutMs / 1000)} 秒内没有就绪。`));
    }, timeoutMs);
    const onData = (chunk) => {
      buffer += chunk;
      const match = buffer.match(/READY (http:\/\/127\.0\.0\.1:\d+\/#session=\w+)/);
      if (!match) return;
      clearTimeout(timer);
      child.stdout.off("data", onData);
      resolve(match[1]);
    };
    child.stdout.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(Error(`本地工作台进程退出（代码 ${code ?? "未知"}）。`));
    });
  });
}

async function start() {
  assertBuilt();
  mainWindow = createWindow();
  mainWindow.loadURL(loadingPage("正在启动 Sand Table"));
  service = startService();
  service.once("exit", (code) => {
    if (quitting) return;
    service = null;
    const detail = `本地工作台进程意外退出（代码 ${code ?? "未知"}）。\n请重新启动 Sand Table；如果反复出现，请把下面的日志反馈给作者：\n${path.join(app.getPath("userData"), "session")}`;
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.loadURL(errorPage(detail));
  });
  const url = await waitForReady(service, 60000);
  log(`工作台就绪：${url}`);
  await mainWindow.loadURL(url);
}

function buildMenu() {
  const template = [
    {
      label: "文件",
      submenu: [
        {
          label: "在浏览器中打开当前工作台",
          click: () => {
            if (mainWindow) shell.openExternal(mainWindow.webContents.getURL());
          },
        },
        { type: "separator" },
        { role: "quit", label: "退出" },
      ],
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { role: "selectAll", label: "全选" },
      ],
    },
    {
      label: "视图",
      submenu: [
        { role: "reload", label: "重新加载" },
        { role: "toggleDevTools", label: "开发者工具" },
        { type: "separator" },
        { role: "resetZoom", label: "实际大小" },
        { role: "zoomIn", label: "放大" },
        { role: "zoomOut", label: "缩小" },
        { type: "separator" },
        { role: "togglefullscreen", label: "全屏" },
      ],
    },
    {
      label: "帮助",
      submenu: [
        {
          label: "关于 Sand Table",
          click: () =>
            dialog.showMessageBox({
              type: "info",
              title: "Sand Table",
              message: `Sand Table ${app.getVersion()}`,
              detail:
                "人和自己的 AI 共用的一张交互沙盘。\n作品保存在本机，AI 通过 MCP 接入同一个工作台。",
              buttons: ["好"],
            }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    buildMenu();
    try {
      await start();
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      dialog.showErrorBox("Sand Table 启动失败", detail);
      app.quit();
    }
  });

  app.on("window-all-closed", () => app.quit());

  app.on("before-quit", () => {
    quitting = true;
    stopService();
  });

  app.on("will-quit", stopService);
}
