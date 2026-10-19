import { resultData } from "../core/results.ts";
import {
  AppBridge,
  PostMessageTransport,
} from "@modelcontextprotocol/ext-apps/app-bridge";
declare global {
  interface Window {
    __sandToken: string;
    __sandBoardId: string;
  }
}
const element = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const bootstrapToken = new URLSearchParams(window.location.hash.slice(1)).get(
  "session",
);
if (bootstrapToken && /^\w{48}$/.test(bootstrapToken)) {
  sessionStorage.setItem("sand-session", bootstrapToken);
  history.replaceState(null, "", location.pathname);
}
window.__sandToken =
  bootstrapToken || sessionStorage.getItem("sand-session") || "";
let bridge: AppBridge | undefined,
  boardId = "";
async function request(route: string, data: unknown = {}) {
  const response = await fetch(route, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Sand-Token": window.__sandToken,
    },
    body: JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error || "工作台请求失败");
  return result;
}
async function rpc(name: string, args: Record<string, unknown> = {}) {
  const r = await request("/rpc", {
    method: "tools/call",
    params: { name, arguments: { boardId, ...args } },
  });
  if (r.isError) throw Error(r.content?.[0]?.text || "工具请求失败");
  return r;
}
const showError = (error: unknown) => {
  element("error").hidden = false;
  element("error").textContent =
    error instanceof Error ? error.message : String(error);
};
function showSetup(show: boolean) {
  element("setup-panel").hidden = !show;
  document.querySelector("iframe")!.hidden = show;
}
function makePrompt(id: string, names: string[] = []) {
  return `这次使用浏览器中已有的 Sand Table boardId="${id}"，不要另建白板。先用 sand_read_context 读取最新选区和备注，额外查找用 sand_find_objects 分页搜索。${names.length ? `当前选中的对象：${names.join("、")}。` : "如果没有选区，用 sand_find_objects 查找 README 文件并读取项目说明，向我说明用途。"}请用我能理解的方式解释这些部分如何配合，读取真实源码，说明输入、输出和仍不确定的地方，并用 sand_publish_guide 把带引用的功能讲解放到这张板子。实际工作时用 sand_report_activity 报告正确的 workspaceId 与对象。不要因为我整理了白板就修改代码；改代码前先讨论具体改法。`;
}
function renderStatus(data: any) {
  const entries = data.connections || [];
  const latest = entries
    .filter((c: any) => c.lastTool)
    .sort((a: any, b: any) => b.lastSeen - a.lastSeen)[0];
  element("connection").textContent = entries.length
    ? `MCP 接入进程 ${entries.length} 个${latest ? ` · 最近工具：${latest.lastTool}` : " · 等待 AI 调用工具"}`
    : "尚未连接 AI · 可以先浏览，再点击「连接我的 AI」";
}
async function mount() {
  element("error").hidden = true;
  const boot = await request("/bootstrap");
  boardId = resultData(boot.boardResult).id;
  window.__sandBoardId = boardId;
  for (const key of ["codex", "json", "toml"])
    element<HTMLTextAreaElement>(key).value = boot.config[key];
  element<HTMLTextAreaElement>("prompt").value = makePrompt(boardId);
  renderStatus(boot.status);
  const resource = await request("/rpc", {
    method: "resources/read",
    params: { uri: "ui://sand-table/overview.html" },
  });
  await bridge?.close();
  const old = document.querySelector("iframe")!;
  const frame = old.cloneNode() as HTMLIFrameElement;
  old.replaceWith(frame);
  bridge = new AppBridge(
    null,
    { name: "Sand Table local workbench", version: "0.2.0" },
    { serverTools: {} },
    {
      hostContext: {
        theme: "light",
        displayMode: "inline",
        availableDisplayModes: ["inline"],
        locale: "zh-CN",
      },
    },
  );
  bridge.oncalltool = (params) =>
    request("/rpc", { method: "tools/call", params });
  bridge.oninitialized = async () => {
    await bridge!.sendToolInput({ arguments: { boardId } });
    await bridge!.sendToolResult(boot.boardResult);
  };
  await bridge.connect(
    new PostMessageTransport(frame.contentWindow!, frame.contentWindow!),
  );
  frame.srcdoc = resource.contents[0].text.replace(
    "<head>",
    `<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'">`,
  );
  showSetup(false);
}
async function copy(id: string) {
  const field = element<HTMLTextAreaElement>(id);
  try {
    await navigator.clipboard.writeText(field.value);
    element("setup-status").textContent =
      "已复制。粘贴到你的本机 AI 客户端即可。";
  } catch {
    field.focus();
    field.select();
    element("setup-status").textContent = "请按系统复制快捷键，文本已选中。";
  }
}
element("setup").onclick = () => showSetup(true);
element("close-setup").onclick = () => showSetup(false);
element("new-board").onclick = () => {
  if (window.__sandToken) void mount().catch(showError);
  else showError("请使用终端打印的完整启动链接。");
};
for (const button of document.querySelectorAll<HTMLButtonElement>(
  "[data-copy]",
))
  button.onclick = () => void copy(button.dataset.copy!);
element("ask").onclick = async () => {
  try {
    const r = await rpc("sand_read_board");
    const b = resultData(r);
    element<HTMLTextAreaElement>("prompt").value = makePrompt(
      boardId,
      b.objects
        .filter((o: any) => b.selection.includes(o.id))
        .map((o: any) => o.title),
    );
    await copy("prompt");
  } catch (e) {
    showError(e);
  }
};
if (window.__sandToken) void mount().catch(showError);
else
  showError(
    "请使用启动终端中打印的完整链接打开工作台（链接包含 #session=…）。",
  );
setInterval(
  () =>
    void request("/status")
      .then(renderStatus)
      .catch(() => {
        element("connection").textContent =
          "与本地工作台断开 · 请重新启动后刷新页面";
      }),
  3000,
);
