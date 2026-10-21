import { z } from "zod";
import { randomUUID } from "node:crypto";
import { readPdf, pdfBytes } from "../../connectors/pdf.ts";
import {
  pdfCitation,
  verifyCitation,
  citationToResource,
  checkCitation,
  type ResearchCitation,
} from "./index.ts";
import type { RegisterTool } from "../../server/tool-types.ts";
import type { BoardStore } from "../../core/store.ts";
import { Spaces } from "../../server/spaces.ts";
const path = z.string().min(1).max(2000),
  page = z.number().int().positive();
export function registerResearchTools(tool: RegisterTool, store: BoardStore) {
  tool(
    "sand_read_pdf",
    "读取本地 PDF 的真实页码、文本和文件指纹。扫描件无文本时不会捏造 OCR 结果。",
    { path, page },
    async (a) => {
      const result = await readPdf(a.path, a.page);
      return {
        ...result,
        citation: pdfCitation({ ...result, quote: result.text.slice(0, 2000) }),
      };
    },
  );
  tool(
    "sand_import_pdf_evidence",
    "读取 PDF 页面，建立证据卡、原始引用与可追溯来源。",
    {
      path,
      page,
      boardId: z.string(),
      viewId: z.string(),
      revision: z.number().int(),
      title: z.string().min(1).max(200),
      summary: z.string().min(1).max(2000).optional(),
    },
    async (a) => {
      const result = await readPdf(a.path, a.page);
      const b = store.get(a.boardId);
      if (b.revision !== a.revision)
        throw Error("Board changed. Read current board and retry.");
      if (!b.views[a.viewId]) throw Error("Unknown view.");
      if (!result.text && !a.summary)
        throw Error("该页没有可提取文本，请提供摘要或先进行 OCR。");
      const citation = pdfCitation({
        ...result,
        quote: result.text.slice(0, 2000),
      });
      store.atomic(b, () => {
        const intent = randomUUID();
        const object = store.createContent(
          b,
          {
            type: "evidence",
            title: a.title,
            data: {
              summary: a.summary ?? result.text.slice(0, 2000),
              citation,
            },
            source: {
              origin: "imported",
              author: "PDF",
              external: {
                kind: "pdf",
                uri: result.uri,
                fragment: result.fragment,
              },
              fingerprint: result.fingerprint,
            },
          },
          "PDF",
          intent,
          "agent",
        );
        store.createResource(
          b,
          citationToResource(citation, object.id),
          "PDF",
          intent,
          "agent",
        );
        new Spaces(store).update(
          b.id,
          b.revision,
          a.viewId,
          { kind: "present", objectId: object.id, intentId: intent },
          "PDF",
        );
      });
      return store.read(b.id);
    },
  );
  tool(
    "sand_verify_pdf_citation",
    "实际读取本地 PDF，复核旧指纹是否变化或文件是否缺失；不静默更新旧引用。",
    { citation: z.record(z.string(), z.unknown()) },
    (a) => {
      const citation = a.citation as unknown as ResearchCitation;
      const errors = checkCitation(citation);
      if (errors.length) throw Error(errors.join(" "));
      try {
        return verifyCitation(citation, {
          found: true,
          fingerprint: pdfBytes(citation.uri).fingerprint,
        });
      } catch (error) {
        if (
          ["ENOENT", "ENOTDIR"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )
        )
          return verifyCitation(citation, { found: false });
        throw error;
      }
    },
  );
}
