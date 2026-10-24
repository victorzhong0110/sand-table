// 科研包的 PDF 工具：读页、导入证据、复核引用。
//
// 导入进撤销历史。复核只比较文件指纹，不把新指纹写回旧引用。

import { z } from "zod";
import {
  applyCommands,
  CommandError,
  readView,
  status,
  type ExternalLocator,
  type ToolRegistrar,
} from "../../kernel/index.ts";
import { pdfBytes, readPdf } from "./pdf.ts";

const PAGE_FRAGMENT = /^page=[1-9]\d*(?:;rect=.+)?$/;

export function registerResearchTools(registrar: ToolRegistrar): void {
  registrar.tool(
    "research_pdf",
    "Read a local PDF page, import it as research.evidence, or check whether a saved citation fingerprint still matches the file. Scanned pages with no extractable text are left empty; this tool does not OCR.",
    {
      action: z.enum(["read", "import_evidence", "verify_citation"]),
      path: z.string().min(1).max(2000).optional(),
      page: z.number().int().positive().optional(),
      boardId: z.string().min(1).max(500).optional(),
      viewId: z.string().min(1).max(500).optional(),
      revision: z.number().int().nonnegative().optional(),
      title: z.string().min(1).max(200).optional(),
      summary: z.string().min(1).max(2000).optional(),
      citation: z.record(z.string(), z.unknown()).optional(),
    },
    async (args, ctx) => {
      if (args.action === "read") return readPage(args.path, args.page);
      if (args.action === "import_evidence")
        return importEvidence(ctx.db, ctx.registry, ctx.actor, args);
      return verifyPdfCitation(args.citation);
    },
  );
}

async function readPage(path: string | undefined, page: number | undefined) {
  if (!path || page === undefined)
    throw new CommandError(
      "INVALID_DATA",
      "读 PDF 要给出文件路径和页码。请补全后再读。",
      null,
    );
  const result = await readPdf(path, page);
  const quote = result.text.slice(0, 2000);
  return {
    ...result,
    ...(quote ? { quote } : {}),
    citation: locatorOf(result),
  };
}

async function importEvidence(
  db: Parameters<typeof applyCommands>[0],
  registry: Parameters<typeof applyCommands>[1],
  actor: Parameters<typeof applyCommands>[2]["actor"],
  args: {
    path?: string;
    page?: number;
    boardId?: string;
    viewId?: string;
    revision?: number;
    title?: string;
    summary?: string;
  },
) {
  if (
    !args.path ||
    args.page === undefined ||
    !args.boardId ||
    !args.viewId ||
    args.revision === undefined ||
    !args.title
  )
    throw new CommandError(
      "INVALID_DATA",
      "导入证据要给出 PDF 路径、页码、白板、视角、修订号和标题。请补全后再导入。",
      null,
    );
  const result = await readPdf(args.path, args.page);
  const current = status(db, registry).workspace.revision;
  if (current !== args.revision)
    throw new CommandError(
      "VERSION_CONFLICT",
      "白板已经变了。请重新读取当前修订号后再导入。",
      null,
    );
  const view = readView(db, args.viewId);
  if (!view.board || view.board.id !== args.boardId)
    throw new CommandError(
      "NOT_FOUND",
      "这个视角不在指定的白板上。请重新打开白板，核对白板编号和视角编号后再导入。",
      null,
    );
  const quote = result.text.slice(0, 2000);
  if (!quote && !args.summary)
    throw new CommandError(
      "INVALID_DATA",
      "该页没有可提取文本，请提供摘要或先进行 OCR。",
      null,
    );
  const citation = locatorOf(result);
  const data: Record<string, unknown> = {
    summary: args.summary ?? quote,
    citation,
    status: "valid",
  };
  if (quote) data.quote = quote;
  const written = applyCommands(db, registry, {
    actor,
    label: "导入 PDF 证据",
    commands: [
      {
        op: "object.create",
        ref: "evidence",
        type: "research.evidence",
        title: args.title,
        data,
        source: { origin: "imported", external: citation },
      },
      {
        op: "presentation.create",
        boardId: args.boardId,
        objectId: "@evidence",
      },
    ],
  });
  return {
    revision: written.revision,
    objectId: written.created.evidence,
    citation,
  };
}

function verifyPdfCitation(input: unknown) {
  const citation = asLocator(input);
  try {
    const observed = pdfBytes(citation.uri).fingerprint;
    if (observed !== citation.fingerprint)
      return {
        status: "stale",
        citation,
        observedFingerprint: observed,
        reason: "外部内容已变化：指纹与记录时不一致，引用已失效。",
      };
    return {
      status: "valid",
      citation,
      observedFingerprint: observed,
    };
  } catch (error) {
    if (error instanceof CommandError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR")
      return {
        status: "missing",
        citation,
        reason: "外部资源取不到：引用已失效。",
      };
    throw error;
  }
}

function locatorOf(result: {
  uri: string;
  fingerprint: string;
  page: number;
}): ExternalLocator {
  return {
    kind: "pdf",
    uri: result.uri,
    fragment: `page=${result.page}`,
    fingerprint: result.fingerprint,
  };
}

function asLocator(value: unknown): ExternalLocator {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new CommandError(
      "INVALID_DATA",
      "复核引用要给出 citation 对象，里面有 kind、uri、fragment 和 fingerprint。",
      null,
    );
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  const uri = record.uri;
  const fragment = record.fragment;
  const fingerprint = record.fingerprint;
  const problems: string[] = [];
  if (kind !== "pdf") problems.push("引用的 kind 必须是 pdf。");
  if (typeof uri !== "string" || !uri.trim())
    problems.push("引用必须有来源地址。");
  if (typeof fragment !== "string" || !PAGE_FRAGMENT.test(fragment))
    problems.push("引用必须定位到页码（形如 page=42）。");
  if (typeof fingerprint !== "string" || !fingerprint.trim())
    problems.push("引用必须带内容指纹。");
  if (
    problems.length ||
    kind !== "pdf" ||
    typeof uri !== "string" ||
    typeof fragment !== "string" ||
    typeof fingerprint !== "string"
  )
    throw new CommandError(
      "INVALID_DATA",
      problems.join(" ") || "引用不完整。",
      null,
    );
  const locator: ExternalLocator = {
    kind: "pdf",
    uri,
    fragment,
    fingerprint,
  };
  if (typeof record.version === "string" && record.version)
    locator.version = record.version;
  return locator;
}
