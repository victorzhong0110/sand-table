import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
export type Connection = {
  url: string;
  token: string;
  pid: number;
  startedAt: number;
  /**
   * The link with the credential fragment, ready to paste into a browser.
   * `url` stays free of the fragment on purpose: a program that takes `url`
   * and opens it plainly would otherwise look authenticated and silently
   * fail with 403. `link` is the field to hand to a human.
   */
  link?: string;
};
export const defaultSessionFile = join(
  tmpdir(),
  `sand-table-${process.getuid?.() ?? "local"}-${createHash("sha256")
    .update(fileURLToPath(new URL("../", import.meta.url)))
    .digest("hex")
    .slice(0, 12)}`,
  "connection.json",
);
export function validateConnection(c: Connection) {
  const u = new URL(c.url);
  if (
    u.protocol !== "http:" ||
    u.hostname !== "127.0.0.1" ||
    !u.port ||
    u.pathname !== "/" ||
    u.search ||
    u.hash ||
    u.username ||
    u.password ||
    !/^\w{48}$/.test(c.token)
  )
    throw Error("Invalid local connection descriptor.");
  if (c.link !== undefined) {
    const l = new URL(c.link);
    if (
      l.protocol !== "http:" ||
      l.hostname !== "127.0.0.1" ||
      !l.port ||
      l.pathname !== "/" ||
      l.search ||
      l.hash !== "#session=" + c.token
    )
      throw Error("Invalid local connection descriptor.");
  }
  return c;
}
export function readConnection(file: string): Connection {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192)
    throw Error("Invalid session file.");
  if (
    process.getuid &&
    (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)
  )
    throw Error("Session file must be private to its owner.");
  const c = validateConnection(JSON.parse(readFileSync(file, "utf8")));
  return { ...c, link: c.link ?? c.url + "#session=" + c.token };
}
export function writeConnection(file: string, c: Connection) {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    (process.getuid &&
      (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))
  )
    throw Error("Session directory must be a private directory (mode 700).");
  writeFileSync(file, JSON.stringify(c), { mode: 0o600, flag: "wx" });
}
export function removeConnection(file: string, token: string) {
  try {
    if (readConnection(file).token === token) unlinkSync(file);
  } catch {}
}
const describeCause = (cause: unknown) => {
  const e = cause as
    | {
        message?: string;
        code?: string;
        cause?: { code?: string; message?: string; errors?: any[] };
      }
    | null;
  const inner = e?.cause;
  const first = Array.isArray(inner?.errors) ? inner.errors[0] : inner;
  const code = e?.code || first?.code;
  const message = e?.message || String(cause);
  return code && !message.includes(code) ? `${message} (${code})` : message;
};
// The session file could not be read at all: the workbench is not running,
// --session-file points somewhere else, or the file was removed.
function unreadableSessionFile(file: string, cause: unknown) {
  const missing = (cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
  const detail = cause instanceof Error ? cause.message : String(cause);
  return [
    `Sand Table 会话文件读不到：${file}`,
    missing
      ? "文件不存在。工作台没有在运行，或者 --session-file 指向了另一份文件。"
      : `文件在，但读不出有效的连接信息（${detail}）。它可能是上次运行的残留，或权限/内容不对。`,
    "请先启动工作台（npm start -- /absolute/path/to/repository），并让 MCP 配置里的 --session-file 指向这一份文件。",
  ].join("\n");
}
// The session file was read, but the running instance refused the request:
// the token is stale, the port changed, or a different instance is up.
function mismatchedSession(file: string, c: Connection, detail: string) {
  return [
    `Sand Table 会话文件与当前实例对不上：${file}`,
    `这份文件记录的是 ${c.url}，但请求被拒：${detail}`,
    "通常说明工作台重启过并换了 token 或端口，而这份文件还是旧的。",
    "请重新启动工作台实例，或让 --session-file 指向当前实例正在使用的那份会话文件。",
  ].join("\n");
}
export async function request(file: string, route: string, data: unknown) {
  let c: Connection;
  try {
    c = readConnection(file);
  } catch (e) {
    throw Error(unreadableSessionFile(file, e));
  }
  let response: Response;
  try {
    response = await fetch(new URL(route, c.url), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sand-Token": c.token },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(30000),
      redirect: "error",
    });
  } catch (e) {
    throw Error(mismatchedSession(file, c, describeCause(e)));
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({} as any));
    const reason = body?.error ? `HTTP ${response.status}（${body.error}）` : `HTTP ${response.status}`;
    throw Error(mismatchedSession(file, c, reason));
  }
  return await response.json();
}
