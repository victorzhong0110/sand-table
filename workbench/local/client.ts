import { safeUrl } from "../board/data-client/spaces.ts";
import { resultData } from "../board/data-client/results.ts";
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
  connecting = false,
  opening = false,
  openCycle = 0,
  openTimer = 0;
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
  const data = await response.json().catch(() => ({}) as any);
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
  const result = await response.json().catch(() => ({}) as any);
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
function makePrompt(id: string, names: string[] = []) {
  return (
    '使用浏览器已有的 Sand Table boardId="' +
    id +
    '"，不要另建白板。先用 sand_context 看当前选区，再用 sand_query、sand_read 了解组件。' +
    (names.length
      ? "当前关注：" + names.join("、") + "。"
      : "这张板子可以为空；按我的请求从组件搭起。") +
    "用 sand_edit 维护编排。需要代码时用 code_repo 读源码；需要修改源码时用 code_change 提交提案，等我确认后才使用宿主文件工具写入。编排不代表写入授权。"
  );
}
type ShellState = {
  embedded: boolean;
  connected: boolean;
  statusText: string;
  config: { json: string; codex: string; toml: string };
  prompt: string;
  askText: string;
  askSeq: number;
  revealSeq: number;
};
const shell: ShellState = {
  embedded: false,
  connected: false,
  statusText: "正在连接工作台…",
  config: { json: "", codex: "", toml: "" },
  prompt: "",
  askText: "",
  askSeq: 0,
  revealSeq: 0,
};
function postShell() {
  toBoard({ type: "sand-table:shell", ...shell });
}
function renderStatus(data: any) {
  const entries = data.connections || [];
  const latest = entries
    .filter((c: any) => c.lastTool)
    .sort((a: any, b: any) => b.lastSeen - a.lastSeen)[0];
  shell.connected = entries.length > 0;
  shell.statusText = entries.length
    ? `MCP 接入进程 ${entries.length} 个${latest ? ` · 最近工具：${latest.lastTool}` : " · 等待 AI 调用工具"}`
    : "尚未连接 AI。打开「帮助」可以复制连接配置。";
  postShell();
}
const embedded = location.pathname === "/embed" && window.parent !== window;
shell.embedded = embedded;
let hostOrigin = "";
let hostHandshake: unknown;
const toBoard = (data: unknown) =>
  document.querySelector("iframe")?.contentWindow?.postMessage(data, "*");
function boardWindow() {
  return document.querySelector("iframe")?.contentWindow ?? null;
}
async function answerAsk() {
  try {
    const r = await rpc("sand_context");
    const data = resultData(r);
    const names = Array.isArray(data?.selection)
      ? data.selection
          .map((item: { title?: string }) => item.title)
          .filter((title: string | undefined): title is string =>
            Boolean(title),
          )
      : [];
    /* 提问单独放：prompt 里是 Agent 发来的原文，不能被这次复制盖掉。 */
    shell.askText = makePrompt(data?.board?.id || boardId, names);
    shell.askSeq += 1;
    postShell();
  } catch (e) {
    showError(e);
  }
}
window.addEventListener("message", (event) => {
  if (event.source !== boardWindow()) return;
  if (event.data?.type === "sand-table:shell-ready") postShell();
  if (event.data?.type === "sand-table:shell-ask") void answerAsk();
});
window.addEventListener("message", (event) => {
  if (!embedded) return;
  if (event.source === window.parent) {
    if (hostOrigin && event.origin !== hostOrigin) return;
    if (event.data?.type === "sand-table:host-bridge") {
      if (!event.origin || event.origin === "null") return;
      hostOrigin = event.origin;
      hostHandshake = event.data;
      toBoard(event.data);
    } else if (
      hostOrigin &&
      [
        "sand-table:submit-task-result",
        "sand-table:submit-task-error",
        "sand-table:task-event",
      ].includes(event.data?.type)
    )
      toBoard(event.data);
  } else if (
    event.source === document.querySelector("iframe")?.contentWindow &&
    event.data?.type === "sand-table:bridge-ready"
  ) {
    if (hostHandshake) toBoard(hostHandshake);
    window.parent.postMessage(
      { type: "sand-table:bridge-ready" },
      hostOrigin || "*",
    );
  } else if (
    event.source === document.querySelector("iframe")?.contentWindow &&
    hostOrigin &&
    ["sand-table:submit-task", "sand-table:cancel-task"].includes(
      event.data?.type,
    )
  ) {
    window.parent.postMessage(event.data, hostOrigin);
  }
});
function startOpening() {
  opening = true;
  const cycle = ++openCycle;
  element("opening").hidden = false;
  element("error").hidden = true;
  window.clearTimeout(openTimer);
  openTimer = window.setTimeout(() => {
    if (cycle !== openCycle) return;
    openCycle += 1;
    opening = false;
    element("opening").hidden = true;
    showError(
      Error("白板没有加载出来。暂时无法确认保存状态，请点「重新连接」重试。"),
    );
  }, 15000);
  return cycle;
}
function stopOpening(cycle: number) {
  if (cycle !== openCycle) return;
  window.clearTimeout(openTimer);
  opening = false;
  element("opening").hidden = true;
}
async function mount(cycle: number) {
  const boot = await request("/bootstrap");
  if (cycle !== openCycle) return;
  boardId = resultData(boot.boardResult).id;
  window.__sandBoardId = boardId;
  shell.config = {
    json: String(boot.config?.json ?? ""),
    codex: String(boot.config?.codex ?? ""),
    toml: String(boot.config?.toml ?? ""),
  };
  shell.prompt = makePrompt(boardId);
  postShell();
  renderStatus(boot.status);
  const resource = await request("/rpc", {
    method: "resources/read",
    params: { uri: "ui://sand-table/overview.html" },
  });
  if (cycle !== openCycle) return;
  await bridge?.close();
  const old = document.querySelector("iframe");
  if (!old) throw Error("页面上没有白板框架，无法重新连接。");
  const frame = document.createElement("iframe");
  frame.title = "Sand Table 白板";
  frame.setAttribute("sandbox", "allow-scripts");
  old.replaceWith(frame);
  frame.addEventListener("load", () => {
    postShell();
    if (hostHandshake) toBoard(hostHandshake);
    if (embedded)
      window.parent.postMessage(
        { type: "sand-table:bridge-ready" },
        hostOrigin || "*",
      );
  });
  bridge = new AppBridge(
    null,
    { name: "Sand Table local workbench", version: "0.3.0" },
    { serverTools: {}, openLinks: {}, message: { text: {} }, downloadFile: {} },
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
    shell.prompt = content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    shell.revealSeq += 1;
    postShell();
    return {};
  };
  bridge.ondownloadfile = async ({ contents }) => {
    if (contents.length !== 1 || contents[0].type !== "resource")
      return { isError: true };
    const resource = contents[0].resource;
    if (!("text" in resource) || resource.mimeType !== "application/json")
      return { isError: true };
    const blob = new Blob([resource.text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download =
      new URL(resource.uri).pathname.split("/").pop() || "sand-table.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
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
    stopOpening(cycle);
  };
  await bridge.connect(
    new PostMessageTransport(frame.contentWindow!, frame.contentWindow!),
  );
  if (cycle !== openCycle) return;
  frame.srcdoc = resource.contents[0].text.replace(
    "<head>",
    `<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; media-src data:; connect-src 'none'">`,
  );
}
async function connect(force = false) {
  if (opening) return;
  const cycle = startOpening();
  connecting = true;
  try {
    const token = await ensureToken(force);
    if (cycle !== openCycle) return;
    rememberToken(token);
    scrubUrl();
    try {
      await mount(cycle);
    } catch (e) {
      // A rejected credential means the instance rotated its token: fetch a
      // fresh one from the same origin instead of dying on a red bar.
      if (cycle !== openCycle) return;
      if (!isAuthError(e)) throw e;
      const fresh = await requestSessionToken();
      if (cycle !== openCycle) return;
      rememberToken(fresh);
      await mount(cycle);
    }
  } catch (e) {
    if (cycle !== openCycle) return;
    stopOpening(cycle);
    throw e;
  } finally {
    connecting = false;
  }
}
element("retry").onclick = () => void connect(true).catch(showError);
// Pasting a new link into an open tab changes only the fragment, so the
// document is never reloaded and the new credential would be ignored: the
// page would keep using the old one and every request would come back
// unauthorized. Adopt the credential from the hash and reconnect. If it is
// stale, connect() falls back to the live one the service hands out.
window.addEventListener("hashchange", () => {
  const fresh = new URLSearchParams(location.hash.slice(1)).get("session");
  if (!fresh || !TOKEN_PATTERN.test(fresh) || fresh === currentToken) return;
  rememberToken(fresh);
  void connect(false).catch(showError);
});
void connect().catch((e) =>
  showError(
    e instanceof Error && e.message
      ? e
      : Error(
          "无法连接本地工作台。请使用启动终端里打印的完整链接（含 #session=…）打开本页，然后点「重新连接」。",
        ),
  ),
);
setInterval(() => {
  if (connecting || !window.__sandToken) return;
  void request("/status")
    .then(renderStatus)
    .catch((e) => {
      shell.connected = false;
      shell.statusText = "与本地工作台断开";
      postShell();
      showError(
        Error(
          "与本地工作台断开：" +
            (e instanceof Error ? e.message : String(e)) +
            " 点「重新连接」可重新取凭据并重连；也可以在终端里重新启动实例。",
        ),
      );
    });
}, 3000);
