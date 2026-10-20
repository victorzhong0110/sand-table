import { safeUrl } from "../core/spaces.ts";
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
const TOKEN_PATTERN = /^\w{48}$/;
const SESSION_KEY = "sand-session";
const urlParams = new URLSearchParams(location.search);
const hashParams = new URLSearchParams(location.hash.slice(1));
// The fragment and the query parameter are equivalent entry points.
const urlToken = [hashParams.get("session"), urlParams.get("session")].find(
  (value): value is string => Boolean(value && TOKEN_PATTERN.test(value)),
);
const hadUrlToken = Boolean(
  hashParams.get("session") || urlParams.get("session"),
);
let currentToken = "",
  bridge: AppBridge | undefined,
  boardId = "",
  connecting = false;
function rememberToken(token: string) {
  currentToken = token;
  window.__sandToken = token;
  sessionStorage.setItem(SESSION_KEY, token);
}
function storedToken() {
  const stored = sessionStorage.getItem(SESSION_KEY);
  return stored && TOKEN_PATTERN.test(stored) ? stored : "";
}
function scrubUrl() {
  if (hadUrlToken) history.replaceState(null, "", location.pathname);
}
async function requestSessionToken() {
  let response: Response;
  try {
    response = await fetch("/session", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
  } catch (e) {
    throw Error(
      "连不上本机工作台服务（" +
        (e instanceof Error ? e.message : "网络错误") +
        "）。请确认终端里的 Sand Table 实例还在运行，然后点「重新连接」。",
    );
  }
  const data = await response.json().catch(() => ({} as any));
  if (!response.ok)
    throw Error(
      "本机工作台拒绝了凭据请求（HTTP " +
        response.status +
        "）：" +
        (data?.error || "未知原因") +
        "。请确认打开的是本机工作台自己的地址。",
    );
  const token = typeof data?.token === "string" ? data.token : "";
  if (!TOKEN_PATTERN.test(token))
    throw Error("本机工作台返回的会话凭据格式不正确，无法使用。");
  return token;
}
async function ensureToken(force: boolean) {
  if (!force) {
    if (currentToken) return currentToken;
    if (urlToken) return urlToken;
    const stored = storedToken();
    if (stored) return stored;
  }
  return await requestSessionToken();
}
const isAuthError = (error: unknown) =>
  (error as { status?: number } | null)?.status === 403;
async function request(route: string, data: unknown = {}) {
  const response = await fetch(route, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Sand-Token": window.__sandToken,
    },
    body: JSON.stringify(data),
  });
  const result = await response.json().catch(() => ({} as any));
  if (!response.ok) {
    const error = Error(
      result?.error || "工作台请求失败（HTTP " + response.status + "）",
    );
    (error as Error & { status?: number }).status = response.status;
    throw error;
  }
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
  element("error-text").textContent =
    error instanceof Error ? error.message : String(error);
};
function showSetup(show: boolean) {
  element("setup-panel").hidden = !show;
  document.querySelector("iframe")!.hidden = show;
}
function makePrompt(id: string, names: string[] = []) {
  return (
    '使用浏览器已有的 Sand Table boardId="' +
    id +
    '"，不要另建白板。先用 sand_read_context 读取最新选区、备注和编排，再用 sand_read_spaces 了解组件和包含关系。' +
    (names.length
      ? "当前关注：" + names.join("、") + "。"
      : "这张板子可以为空；按我的请求从组件搭起，不需要先导入仓库。") +
    "用 sand_edit_space 维护编排。需要代码理解时再读取真实源码、用 sand_publish_guide 提供引用；需要修改源码时先读取明确意图，提交具体提案，等我确认后才使用宿主文件工具写入，再核对和验证。编排不代表写入授权。"
  );
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
    { name: "Sand Table local workbench", version: "0.3.0" },
    { serverTools: {}, openLinks: {}, message: { text: {} } },
    {
      hostContext: {
        theme: "light",
        displayMode: "inline",
        availableDisplayModes: ["inline"],
        locale: "zh-CN",
      },
    },
  );
  bridge.onmessage = async ({ content }) => {
    element<HTMLTextAreaElement>("prompt").value = content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    showSetup(true);
    element("setup-status").textContent =
      "编排请求已准备。复制下面的消息，到你自己的 AI 客户端发送。";
    return {};
  };
  bridge.onopenlink = async ({ url }) => {
    const safe = safeUrl(url);
    if (!safe) return { isError: true };
    window.open(safe, "_blank", "noopener,noreferrer");
    return {};
  };
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
    `<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; media-src data:; connect-src 'none'">`,
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
async function connect(force = false) {
  element("error").hidden = true;
  connecting = true;
  try {
    const token = await ensureToken(force);
    rememberToken(token);
    scrubUrl();
    try {
      await mount();
    } catch (e) {
      // A rejected credential means the instance rotated its token: fetch a
      // fresh one from the same origin instead of dying on a red bar.
      if (!isAuthError(e)) throw e;
      const fresh = await requestSessionToken();
      rememberToken(fresh);
      await mount();
    }
  } finally {
    connecting = false;
  }
}
element("setup").onclick = () => showSetup(true);
element("close-setup").onclick = () => showSetup(false);
element("retry").onclick = () => void connect(true).catch(showError);
element("new-board").onclick = () => {
  void connect().catch(showError);
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
void connect().catch((e) =>
  showError(
    e instanceof Error && e.message
      ? e
      : Error(
          "无法连接本地工作台。请使用启动终端里打印的完整链接（含 #session=…）打开本页，然后点「重新连接」。",
        ),
  ),
);
setInterval(
  () => {
    if (connecting || !window.__sandToken) return;
    void request("/status")
      .then(renderStatus)
      .catch((e) => {
        element("connection").textContent = "与本地工作台断开";
        showError(
          Error(
            "与本地工作台断开：" +
              (e instanceof Error ? e.message : String(e)) +
              " 点「重新连接」可重新取凭据并重连；也可以在终端里重新启动实例。",
          ),
        );
      });
  },
  3000,
);
