import { gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export const spikeRoot = here;
export const workbenchRoot = join(here, "../..");
export const repoRoot = join(workbenchRoot, "..");

/** 与 local/client.ts 注入 srcdoc 的策略一致。 */
export const LOCAL_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; media-src data:; connect-src 'none'";

/** MCP Apps 规范在省略 ui.csp 时要求宿主使用的默认策略。 */
export const SPEC_CSP =
  "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' data:; font-src 'self' data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'self'";

/** 只放宽 worker，不加网络，也不加 unsafe-eval。 */
export const WORKER_BLOB_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; worker-src blob:; style-src 'unsafe-inline'; img-src data:; media-src data:; connect-src 'none'";

/** 在上一则之外再允许 blob 脚本，并配合 allow-same-origin 试验真 Worker。 */
export const BLOB_SCRIPT_CSP =
  "default-src 'none'; script-src 'unsafe-inline' blob:; worker-src blob:; style-src 'unsafe-inline'; img-src data:; media-src data:; connect-src 'none'";

export function fileSize(path) {
  const bytes = readFileSync(path);
  return {
    file: relative(repoRoot, path),
    raw: bytes.length,
    gzip: gzipSync(bytes).length,
  };
}

export function packageMeta(path) {
  const meta = JSON.parse(readFileSync(path, "utf8"));
  return { name: meta.name, version: meta.version, license: meta.license };
}

/** 一页、一句 Hello 的 PDF。xref 偏移按实际字节重算。 */
export function helloPdf() {
  const chunks = ["%PDF-1.4\n"];
  const offsets = [];
  const add = (object) => {
    offsets.push(Buffer.byteLength(chunks.join("")));
    chunks.push(object);
  };
  add("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  add("2 0 obj\n<< /Type /Pages /Count 1 /Kids [3 0 R] >>\nendobj\n");
  add(
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
  );
  const stream = "BT /F1 24 Tf 50 100 Td (Hello) Tj ET";
  add(
    `4 0 obj\n<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream\nendobj\n`,
  );
  add(
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  );
  const startxref = Buffer.byteLength(chunks.join(""));
  let xref = "xref\n0 6\n0000000000 65535 f \n";
  for (const offset of offsets) {
    xref += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  chunks.push(
    `${xref}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`,
  );
  return Buffer.from(chunks.join(""));
}

export async function readHelloPdf(pdfBytes) {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loading = getDocument({
    data: new Uint8Array(pdfBytes),
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: true,
  });
  try {
    const pdf = await loading.promise;
    const page = await pdf.getPage(1);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join("");
    return { pages: pdf.numPages, text };
  } finally {
    await loading.destroy();
  }
}
