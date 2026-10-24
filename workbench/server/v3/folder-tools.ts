// 文件夹连接器的 v3 工具。只读启动时绑定的那个目录。
//
// 读规则与 v2 的文件夹连接器相同：不跟符号链接，不读二进制，超限的写进 omitted。

import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import { CommandError, type ToolRegistrar } from "../../kernel/index.ts";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

const limits = {
  maxFiles: 120,
  maxBytes: 2_000_000,
  maxFileBytes: 200_000,
};

const skipped = new Set([
  ".git",
  "node_modules",
  "dist",
  "vendor",
  "build",
  ".venv",
  "__pycache__",
]);

type FolderFile = {
  path: string;
  text: string;
  fingerprint: string;
};

function readFolder(root: string): { files: FolderFile[]; omitted: string[] } {
  const maxFiles = limits.maxFiles;
  const maxBytes = limits.maxBytes;
  let base: string;
  try {
    base = realpathSync(root);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR")
      throw new CommandError(
        "NOT_FOUND",
        "绑定的文件夹不存在。请确认启动时的路径仍是一个目录。",
        null,
      );
    throw error;
  }
  if (!statSync(base).isDirectory())
    throw new CommandError(
      "INVALID_DATA",
      "绑定的路径不是文件夹。请换一个目录后再读。",
      null,
    );
  const files: FolderFile[] = [];
  const omitted: string[] = [];
  let bytes = 0;
  const walk = (dir: string, prefix: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch (error) {
      omitted.push(
        `${prefix || "."}: ${error instanceof Error ? error.message : "unreadable"}`,
      );
      return;
    }
    for (const name of entries.sort()) {
      if (skipped.has(name)) continue;
      const rel = prefix ? `${prefix}/${name}` : name;
      const full = path.join(dir, name);
      let stat;
      try {
        stat = lstatSync(full);
      } catch (error) {
        omitted.push(
          `${rel}: ${error instanceof Error ? error.message : "unreadable"}`,
        );
        continue;
      }
      if (stat.isSymbolicLink()) {
        omitted.push(`${rel}: symlink`);
        continue;
      }
      if (stat.isDirectory()) {
        walk(full, rel);
        continue;
      }
      if (!stat.isFile()) {
        omitted.push(`${rel}: not a regular file`);
        continue;
      }
      if (files.length >= maxFiles) {
        omitted.push(`${rel}: ${maxFiles}-file limit reached`);
        return;
      }
      if (stat.size > limits.maxFileBytes) {
        omitted.push(`${rel}: larger than ${limits.maxFileBytes} bytes`);
        continue;
      }
      let text: string;
      try {
        text = readFileSync(full, "utf8");
      } catch (error) {
        omitted.push(
          `${rel}: ${error instanceof Error ? error.message : "unreadable"}`,
        );
        continue;
      }
      if (text.includes("\0")) {
        omitted.push(`${rel}: binary file`);
        continue;
      }
      if (bytes + Buffer.byteLength(text) > maxBytes) {
        omitted.push(`${rel}: ${maxBytes}-byte limit reached`);
        continue;
      }
      bytes += Buffer.byteLength(text);
      files.push({ path: rel, text, fingerprint: digest(text) });
    }
  };
  walk(base, "");
  return { files, omitted };
}

export function registerFolderTools(
  registrar: ToolRegistrar,
  root: string,
): void {
  registrar.tool(
    "folder_read",
    "Read text files from the folder bound when the server started. Read-only: it does not follow symlinks, does not invent text for binary files, and does not write.",
    {
      kind: z.string().min(1).max(20),
      paths: z.array(z.string().min(1).max(500)).max(200).optional(),
    },
    (args) => {
      if (args.kind !== "file")
        throw new CommandError(
          "INVALID_DATA",
          `folder 连接器未声明读取种类「${args.kind}」：它只能读 file。`,
          null,
        );
      const { files, omitted } = readFolder(root);
      const wanted = args.paths?.length
        ? new Set(args.paths.map((item: string) => item.replace(/^\.\//, "")))
        : undefined;
      const kept = wanted
        ? files.filter((file) => wanted.has(file.path))
        : files;
      return {
        references: kept.map((file) => ({
          id: `folder:${file.path}`,
          kind: "file",
          uri: file.path,
          title: file.path.split("/").at(-1),
          fingerprint: file.fingerprint,
        })),
        contents: kept.map((file) => ({
          id: `folder:${file.path}`,
          text: file.text,
          fingerprint: file.fingerprint,
        })),
        omitted,
        status: { root, files: kept.length },
      };
    },
    { readOnly: true },
  );
}
