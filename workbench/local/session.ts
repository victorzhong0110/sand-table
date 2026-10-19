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
  return validateConnection(JSON.parse(readFileSync(file, "utf8")));
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
export async function request(file: string, route: string, data: unknown) {
  let c: Connection;
  try {
    c = readConnection(file);
  } catch {
    throw Error(
      "Sand Table is not running. Start it with npm start -- /absolute/path/to/repository, then retry.",
    );
  }
  try {
    const response = await fetch(new URL(route, c.url), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sand-Token": c.token },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(30000),
      redirect: "error",
    });
    if (!response.ok) throw Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (e) {
    throw Error(
      `Cannot reach the local Sand Table session. Start or restart the workbench, then retry. (${e instanceof Error ? e.message : "connection error"})`,
    );
  }
}
