// 本地 PDF：按真实页码取文本，指纹是整个文件的 sha256。没有文本就不补 OCR。

import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CommandError } from "../../kernel/index.ts";

export function pdfBytes(path: string) {
  let actual: string;
  try {
    actual = realpathSync(
      path.startsWith("file:") ? fileURLToPath(path) : path,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") throw error;
    throw new CommandError(
      "INVALID_DATA",
      "PDF 必须是小于 25 MB 的普通文件。",
      null,
    );
  }
  const stat = statSync(actual);
  if (!stat.isFile() || stat.size > 25_000_000)
    throw new CommandError(
      "INVALID_DATA",
      "PDF 必须是小于 25 MB 的普通文件。",
      null,
    );
  const bytes = readFileSync(actual);
  if (!bytes.subarray(0, 1024).includes(Buffer.from("%PDF-")))
    throw new CommandError("INVALID_DATA", "不是 PDF 文件。", null);
  return {
    bytes,
    uri: pathToFileURL(actual).href,
    fingerprint: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
}

export async function readPdf(path: string, page: number) {
  if (!Number.isInteger(page) || page < 1)
    throw new CommandError("INVALID_DATA", "页码必须是正整数。", null);
  let file;
  try {
    file = pdfBytes(path);
  } catch (error) {
    if (error instanceof CommandError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR")
      throw new CommandError(
        "NOT_FOUND",
        "找不到这个 PDF。请确认路径是本机上的文件后再读。",
        null,
      );
    throw error;
  }
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loading = getDocument({
    data: new Uint8Array(file.bytes),
    disableFontFace: true,
    useSystemFonts: true,
  });
  try {
    const pdf = await loading.promise;
    if (page > pdf.numPages)
      throw new CommandError(
        "INVALID_DATA",
        `页码越界，PDF 共 ${pdf.numPages} 页。`,
        null,
      );
    const content = await (await pdf.getPage(page)).getTextContent();
    const text = content.items
      .map((item) =>
        "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "",
      )
      .join("")
      .trim();
    return {
      uri: file.uri,
      fingerprint: file.fingerprint,
      page,
      pageCount: pdf.numPages,
      text,
      fragment: `page=${page}`,
    };
  } finally {
    await loading.destroy();
  }
}
