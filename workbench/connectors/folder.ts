// 文件夹连接器：读普通目录（不需要是 Git 仓库），产出引用与只读内容。
//
// 契约见 docs/architecture/domain-packs.zh-CN.md 第 3.4 节。
//
// 这个连接器是**只读**的：它不实现写回。调用写入会被明确拒绝，
// 理由是「只读」——不允许「先做了再说」。

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import type {
  Connector,
  ConnectorReadRequest,
  ConnectorReadResult,
} from "./types.ts";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

/** 读目录时的上限：与代码索引器同一量级，避免把整个仓库读进内存。 */
export const folderLimits = {
  maxFiles: 120,
  maxBytes: 2_000_000,
  maxFileBytes: 200_000,
};

/** 不读的目录：与索引器保持一致，避免把依赖与产物读成内容。 */
const skipped = new Set([
  ".git",
  "node_modules",
  "dist",
  "vendor",
  "build",
  ".venv",
  "__pycache__",
]);

/** 一个目录里的一个可读文本文件。 */
export type FolderFile = {
  /** 相对目录的路径。 */
  path: string;
  text: string;
  /** 内容指纹：外部内容变了要能识别。 */
  fingerprint: string;
};

export type FolderReadOptions = {
  maxFiles?: number;
  maxBytes?: number;
};

/**
 * 读一个普通目录里的文本文件。
 *
 * 目录不需要是 Git 仓库：符号链接不跟，二进制不读，超限的进 omitted。
 */
export function readFolder(
  root: string,
  options: FolderReadOptions = {},
): { files: FolderFile[]; omitted: string[] } {
  const maxFiles = options.maxFiles ?? folderLimits.maxFiles;
  const maxBytes = options.maxBytes ?? folderLimits.maxBytes;
  const base = realpathSync(root);
  const files: FolderFile[] = [];
  const omitted: string[] = [];
  let bytes = 0;
  const walk = (dir: string, prefix: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch (e) {
      omitted.push(
        `${prefix || "."}: ${e instanceof Error ? e.message : "unreadable"}`,
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
      } catch (e) {
        omitted.push(
          `${rel}: ${e instanceof Error ? e.message : "unreadable"}`,
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
      if (stat.size > folderLimits.maxFileBytes) {
        omitted.push(`${rel}: larger than ${folderLimits.maxFileBytes} bytes`);
        continue;
      }
      let text: string;
      try {
        text = readFileSync(full, "utf8");
      } catch (e) {
        omitted.push(
          `${rel}: ${e instanceof Error ? e.message : "unreadable"}`,
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

/**
 * 文件夹连接器。
 *
 * 能力声明：读 file，作用域是普通目录；**没有写能力**。
 */
export const folderConnector: Connector = {
  id: "folder",
  title: "文件夹",
  description: "读取普通目录（不需要是 Git 仓库），产出引用与只读内容。",
  descriptor() {
    return {
      id: "folder",
      title: "文件夹",
      description: "读取普通目录（不需要是 Git 仓库），产出引用与只读内容。",
      capabilities: {
        read: {
          kinds: ["file"],
          scopes: ["普通目录（不需要是 Git 仓库）"],
        },
        // 只读连接器不声明 write。
      },
      available: true,
    };
  },
  read(request: ConnectorReadRequest): ConnectorReadResult {
    const root = request.binding?.root;
    if (!root)
      throw Error("文件夹连接器需要一个目录：没有绑定来源就没有可读的内容。");
    const { files, omitted } = readFolder(root, {
      ...(request.limit?.maxFiles !== undefined
        ? { maxFiles: request.limit.maxFiles }
        : {}),
      ...(request.limit?.maxBytes !== undefined
        ? { maxBytes: request.limit.maxBytes }
        : {}),
    });
    const wanted = request.paths?.length
      ? new Set(request.paths.map((p) => p.replace(/^\.\//, "")))
      : undefined;
    const kept = wanted ? files.filter((f) => wanted.has(f.path)) : files;
    return {
      references: kept.map((f) => ({
        id: `folder:${f.path}`,
        kind: "file",
        uri: f.path,
        title: f.path.split("/").at(-1),
        fingerprint: f.fingerprint,
      })),
      contents: kept.map((f) => ({
        id: `folder:${f.path}`,
        text: f.text,
        fingerprint: f.fingerprint,
      })),
      omitted,
      status: { root, files: kept.length },
    };
  },
};
