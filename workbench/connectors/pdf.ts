// Local PDF reads stay outside the domain model. No network fetching or executable PDF actions.
import { readFileSync, statSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";
export function pdfBytes(path: string) {
  const actual = realpathSync(
    path.startsWith("file:") ? fileURLToPath(path) : path,
  );
  const stat = statSync(actual);
  if (!stat.isFile() || stat.size > 25_000_000)
    throw Error("PDF 必须是小于 25 MB 的普通文件。");
  const bytes = readFileSync(actual);
  if (!bytes.subarray(0, 1024).includes(Buffer.from("%PDF-")))
    throw Error("不是 PDF 文件。");
  return {
    bytes,
    uri: pathToFileURL(actual).href,
    fingerprint: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
}
export async function readPdf(path: string, page: number) {
  if (!Number.isInteger(page) || page < 1) throw Error("页码必须是正整数。");
  const file = pdfBytes(path);
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loading = getDocument({
    data: new Uint8Array(file.bytes),
    disableFontFace: true,
    useSystemFonts: true,
  });
  try {
    const pdf = await loading.promise;
    if (page > pdf.numPages)
      throw Error(`页码越界，PDF 共 ${pdf.numPages} 页。`);
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
      fragment: `p.${page}`,
    };
  } finally {
    await loading.destroy();
  }
}
