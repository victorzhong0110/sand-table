import { chromium } from "playwright";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { once } from "node:events";
import { createServer } from "node:net";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";

const index = process.argv.indexOf("--executable");
if (index < 0) throw Error("需要 --executable 指定真实便携包。");
const executable = resolve(process.argv[index + 1]);
const output = resolve("desktop/dist/smoke/portable");
mkdirSync(join(output, "user"), { recursive: true });
const probe = createServer();
probe.listen(0, "127.0.0.1");
await once(probe, "listening");
const port = probe.address().port;
await new Promise((r) => probe.close(r));
// NSIS 启动器不会转交 Playwright 的调试管道句柄，改用真实应用的本机 CDP 端口。
const child = spawn(executable, [`--remote-debugging-port=${port}`], {
  env: {
    ...process.env,
    /* 桌面主进程的日志默认被这个开关挡掉（main.cjs 的 log()）：
       打开它，失败时才能看到本地服务自己的 stderr 与就绪信息。 */
    SAND_DESKTOP_LOG: "1",
    /* 打包后的 Electron 在 Windows 上没有控制台，console.log 落不到 stdout；
       这个开关把主进程的日志转到 stderr，冒烟脚本才收得到。 */
    ELECTRON_ENABLE_LOGGING: "1",
    SAND_DESKTOP_USER_DATA: join(output, "user"),
    SAND_WORKSPACE_DIR: join(output, "workspaces"),
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let browser, entry;
let startupError;
child.on("error", (error) => {
  startupError = error;
});
// 子进程的输出要留着：失败时「本地服务为什么没就绪」全在这里面。
const childOutput = { stdout: "", stderr: "" };
const collect = (key) => (chunk) => {
  childOutput[key] = (childOutput[key] + String(chunk)).slice(-8000);
};
child.stdout.on("data", collect("stdout"));
child.stderr.on("data", collect("stderr"));
try {
  const started = Date.now();
  let portAt = 0; // 拿到调试端口的时刻
  let pageAt = 0; // 找到页面的时刻
  const end = Date.now() + 90000;
  let ws;
  while (Date.now() < end) {
    if (startupError) throw startupError;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) {
        ws = (await r.json()).webSocketDebuggerUrl;
        break;
      }
    } catch {}
    if (child.exitCode !== null)
      throw Error(`便携启动器提前退出：${child.exitCode}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(ws, "便携窗口未开放调试端口，未能完成真实窗口验收。");
  portAt = Date.now();
  /* 桌面主进程给本地服务 60 秒就绪预算，CDP 握手也得留够时间：
     慢的 runner 上默认 30 秒会不够。 */
  browser = await chromium.connectOverCDP(ws, { timeout: 60000 });
  const context = browser.contexts()[0];
  let page;
  /* 等页面的耐心不能比程序自己的就绪预算还短：
     桌面主进程给本地服务 60 秒，这里给 90 秒。 */
  const pageDeadline = Date.now() + 90000;
  while (Date.now() < pageDeadline) {
    page = context
      .pages()
      .find((p) => /^http:\/\/127\.0\.0\.1:\d+/.test(p.url()));
    if (page) {
      pageAt = Date.now();
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!page) {
    // 失败时把看到的东西都打出来：窗口里是哪个页面、服务端说了什么。
    const pages = context
      .pages()
      .map((p) => `${p.url()}${p.url() ? "" : ""} | ${p.title?.() ?? ""}`);
    const body = (
      await Promise.all(
        context.pages().map((p) => p.innerText().catch(() => "")),
      )
    )
      .join("\n---\n")
      .slice(0, 2000);
    console.error(
      [
        "便携窗口没有打开本地工作台。",
        `各阶段耗时：拿到调试端口 ${portAt ? Math.round((portAt - started) / 1000) + " 秒" : "没拿到"}；再找到页面：${pageAt ? Math.round((pageAt - portAt) / 1000) + " 秒" : "没找到（等了 " + Math.round((Date.now() - portAt) / 1000) + " 秒）"}；合计 ${Math.round((Date.now() - started) / 1000)} 秒。`,
        `窗口里的页面：${pages.join(" || ") || "(没有页面)"}`,
        `页面正文：${body || "(空)"}`,
        `子进程 stdout 尾部：${childOutput.stdout || "(空)"}`,
        `子进程 stderr 尾部：${childOutput.stderr || "(空)"}`,
      ].join("\n"),
    );
  }
  assert.ok(page, "便携窗口没有打开本地工作台");
  const frame = page.frameLocator("iframe");
  await frame.locator(".canvas").waitFor({ timeout: 30000 });
  const bootstrap = await page.evaluate(async () => {
    const session = await (
      await fetch("/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
    ).json();
    return (
      await fetch("/bootstrap", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Sand-Token": session.token,
        },
        body: "{}",
      })
    ).json();
  });
  entry = JSON.parse(bootstrap.config.json).mcpServers["sand-table"];
  assert.equal(entry.env.ELECTRON_RUN_AS_NODE, "1");
  assert.ok(
    entry.command.includes("mcp-runtime"),
    "便携配置必须指向持久运行时",
  );
  assert.ok(existsSync(entry.command) && existsSync(entry.args[1]));
  await page.screenshot({ path: join(output, "portable-window.png") });
  const session = await browser.newBrowserCDPSession();
  // Electron 退出时可能不回复关闭命令；用启动器退出确认实际关闭。
  const exited = new Promise((resolve, reject) => {
    if (child.exitCode !== null) return resolve();
    const timer = setTimeout(() => reject(Error("便携窗口关闭超时")), 15000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  void session.send("Browser.close").catch(() => {});
  await exited;
  const runtime = spawnSync(entry.command, ["--version"], {
    env: { ...process.env, ...entry.env },
    encoding: "utf8",
    timeout: 15000,
    windowsHide: true,
  });
  assert.equal(
    runtime.status,
    0,
    runtime.stderr || String(runtime.error || ""),
  );
  assert.match(runtime.stdout, /^v\d+/);
  assert.ok(existsSync(entry.args[1]));
  console.log(
    "PORTABLE WINDOWS PASSED: actual launcher/window, persistent MCP command and bridge after exit.",
  );
} finally {
  await browser?.close().catch(() => {});
  if (child.exitCode === null) {
    if (process.platform === "win32")
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    else child.kill();
  }
}
