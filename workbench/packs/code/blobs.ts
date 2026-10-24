// 提案里放不下的基线文本写到工作空间的 blobs/ 目录，对象里只留 sha256。
//
// 与界面上传附件一样，只写文件，不写 blobs 表：表的写入没有给包用的内核接口。

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CommandError, type Db } from "../../kernel/index.ts";

/** 超过这个大小的单段基线文本不放进对象数据。 */
export const TEXT_BLOB_LIMIT = 1024 * 1024;

export type BlobRef = { blob: string; bytes: number };

export function databaseDir(db: Db): string {
  const rows = db.prepare("PRAGMA database_list").all() as {
    name: string;
    file: string;
  }[];
  const main = rows.find((row) => row.name === "main") ?? rows[0];
  if (!main?.file)
    throw new CommandError(
      "INTERNAL",
      "找不到工作空间目录，基线附件写不进去。请重新打开工作空间后再试。",
      null,
    );
  return dirname(main.file);
}

export function writeBlob(db: Db, bytes: Buffer): BlobRef {
  const sha = createHash("sha256").update(bytes).digest("hex");
  const dir = join(databaseDir(db), "blobs");
  mkdirSync(dir, { recursive: true });
  const target = join(dir, sha);
  if (existsSync(target)) {
    const existing = readFileSync(target);
    if (createHash("sha256").update(existing).digest("hex") !== sha)
      throw new CommandError(
        "INTERNAL",
        `附件「${sha}」已经存在，但内容和摘要对不上。请检查这个工作空间的 blobs 目录。`,
        null,
      );
  } else {
    writeFileSync(target, bytes);
  }
  return { blob: sha, bytes: bytes.length };
}

export function readBlob(db: Db, sha: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha))
    throw new CommandError(
      "INVALID_DATA",
      "附件摘要必须是 64 位小写十六进制。请重新读取提案。",
      null,
    );
  const target = join(databaseDir(db), "blobs", sha);
  if (!existsSync(target))
    throw new CommandError(
      "NOT_FOUND",
      "找不到提案基线引用的附件。请重新发布提案。",
      null,
    );
  return readFileSync(target, "utf8");
}

/** 单段文本超过 1 MB 时改成附件引用，否则原样返回。 */
export function spillText(db: Db, text: string): string | BlobRef {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= TEXT_BLOB_LIMIT) return text;
  return writeBlob(db, bytes);
}

export function isBlobRef(value: unknown): value is BlobRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as { blob?: unknown; bytes?: unknown };
  return (
    typeof record.blob === "string" &&
    /^[0-9a-f]{64}$/.test(record.blob) &&
    typeof record.bytes === "number"
  );
}
