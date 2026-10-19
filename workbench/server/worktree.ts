import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Binding } from "./repository.ts";
import type { FileRef, WorkspaceState } from "../core/changes.ts";
export const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export function validatePath(file: string) {
  if (
    !file ||
    path.isAbsolute(file) ||
    file.includes("\\") ||
    file
      .split("/")
      .some(
        (p) => !p || p === "." || p === ".." || p.toLowerCase() === ".git",
      ) ||
    file.length > 500
  )
    throw Error("Path must stay inside the configured worktree.");
}
export function boundPath(binding: Binding, file: string) {
  validatePath(file);
  let cursor = binding.root;
  for (const part of file.split("/")) {
    cursor = path.join(cursor, part);
    try {
      if (lstatSync(cursor).isSymbolicLink())
        throw Error("Symlink paths are not supported.");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT")
        return cursor === path.join(binding.root, file)
          ? cursor
          : path.join(binding.root, file);
      throw e;
    }
  }
  return cursor;
}
export function currentFile(bindings: Binding[], ref: FileRef) {
  const binding = bindings.find((b) => b.id === ref.workspaceId);
  if (!binding) throw Error("Unknown workspace.");
  const full = boundPath(binding, ref.path);
  try {
    const stat = lstatSync(full);
    if (!stat.isFile() || stat.size > 200000)
      throw Error("Proposal files must be text files of at most 200 KB.");
    const text = readFileSync(full, "utf8");
    if (text.includes("\0") || Buffer.from(text).length !== stat.size)
      throw Error("Unsupported text encoding or binary file.");
    return { text, hash: digest(text) };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      return { text: null, hash: null };
    throw e;
  }
}
const git = (root: string, args: string[]) =>
  execFileSync("git", ["-c", "core.fsmonitor=false", "-C", root, ...args], {
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: 4_000_000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
export function worktreeState(
  bindings: Binding[],
  extra: FileRef[] = [],
): WorkspaceState[] {
  return bindings.map((b) => {
    const files: WorkspaceState["files"] = {},
      omitted: string[] = [];
    const names = [
      ...new Set([
        ...git(b.root, [
          "ls-files",
          "--cached",
          "--others",
          "--exclude-standard",
          "-z",
        ])
          .split("\0")
          .filter(Boolean),
        ...extra.filter((r) => r.workspaceId === b.id).map((r) => r.path),
      ]),
    ].sort();
    let bytes = 0;
    for (const file of names) {
      try {
        const full = boundPath(b, file);
        let stat;
        try {
          stat = lstatSync(full);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw e;
        }
        if (
          !stat.isFile() ||
          stat.size > 2_000_000 ||
          bytes + stat.size > 64_000_000 ||
          Object.keys(files).length >= 10000
        )
          throw Error("Worktree observation limit or unsupported file.");
        const content = readFileSync(full);
        bytes += content.length;
        files[file] = { hash: digest(content), mode: stat.mode & 0o777 };
      } catch (e) {
        omitted.push(
          `${file}: ${e instanceof Error ? e.message : "unreadable"}`,
        );
      }
    }
    const head = git(b.root, ["rev-parse", "HEAD"]).trim();
    return {
      workspaceId: b.id,
      head,
      files,
      omitted,
      fingerprint: digest(JSON.stringify(files)),
    };
  });
}
