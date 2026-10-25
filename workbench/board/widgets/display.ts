import type { JsonSchema } from "../views/format.ts";

export function formatNumber(value: unknown, schema: JsonSchema): string {
  if (typeof value !== "number" || Number.isNaN(value)) return "";
  const unit = schema["x-sand-unit"];
  return unit ? `${value} ${unit}` : String(value);
}

export function formatBoolean(value: unknown): string {
  if (value === true) return "是";
  if (value === false) return "否";
  return "";
}

export function formatEnum(value: unknown, schema: JsonSchema): string {
  const labels = schema["x-sand-enum-labels"] ?? {};
  const named = labels[String(value)];
  return named || String(value);
}

export function formatTags(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((item) => String(item).trim())
    .filter(Boolean)
    .join("、");
}

export function formatLongText(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > 200 ? text.slice(0, 200) : text;
}

export function formatMarkdown(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  const plain = value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > 200 ? plain.slice(0, 200) : plain;
}

export function formatDate(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return "";
  const [year, month, day] = value.split("-").map(Number);
  if (!year || month < 1 || month > 12 || day < 1 || day > 31) return "";
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  )
    return "";
  return `${year}年${month}月${day}日`;
}

export function parseDateInput(value: string): string | undefined {
  const text = value.trim();
  if (!text) return undefined;
  return formatDate(text) ? text : undefined;
}

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function formatUrl(value: unknown): string {
  if (typeof value !== "string" || !isHttpUrl(value)) return "";
  const url = new URL(value);
  const path = `${url.pathname}${url.search}`;
  const shown = path === "/" ? "" : path.slice(0, 40);
  return `${url.host}${shown}`;
}

export function formatColor(value: unknown): string {
  if (typeof value !== "string" || !/^#[0-9a-fA-F]{6}$/.test(value)) return "";
  return value.toLowerCase();
}

const FRAGMENT_KEYS = new Set([
  "quote",
  "prefix",
  "suffix",
  "page",
  "rect",
  "t",
  "rows",
  "cols",
  "lines",
]);

export type FragmentResult =
  { ok: true; parts: Record<string, string> } | { ok: false; message: string };

export function parseFragment(fragment: string): FragmentResult {
  const text = fragment.trim();
  if (!text) return { ok: true, parts: {} };
  const parts: Record<string, string> = {};
  for (const piece of text.split(";")) {
    const eq = piece.indexOf("=");
    if (eq <= 0)
      return {
        ok: false,
        message: "片段格式不对。请写成键=值，多项之间用分号分开。",
      };
    const key = piece.slice(0, eq);
    if (!FRAGMENT_KEYS.has(key))
      return {
        ok: false,
        message: `不认识片段「${key}」。请改成页码、行号或引用原文。`,
      };
    if (key in parts)
      return { ok: false, message: `片段「${key}」写了两次。请只留一次。` };
    let decoded = piece.slice(eq + 1);
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      return {
        ok: false,
        message: "片段里的百分号编码不完整。请检查后再保存。",
      };
    }
    parts[key] = decoded;
  }
  if (parts.page && !/^[1-9]\d*$/.test(parts.page))
    return { ok: false, message: "页码必须是从 1 开始的整数。" };
  if (
    parts.rect &&
    !/^(?:0|1|0?\.\d+),(?:0|1|0?\.\d+),(?:0|1|0?\.\d+),(?:0|1|0?\.\d+)$/.test(
      parts.rect,
    )
  )
    return {
      ok: false,
      message: "区域要写成四个 0 到 1 的小数，用逗号分开。",
    };
  if (parts.t && !/^\d+(?:\.\d+)?(?:,\d+(?:\.\d+)?)?$/.test(parts.t))
    return { ok: false, message: "时间要写成秒，或开始秒,结束秒。" };
  if (parts.lines && !/^[1-9]\d*-[1-9]\d*$/.test(parts.lines))
    return { ok: false, message: "行号要写成起始-结束，例如 12-20。" };
  if (parts.lines) {
    const [start, end] = parts.lines.split("-").map(Number);
    if (end < start) return { ok: false, message: "结束行不能小于起始行。" };
  }
  return { ok: true, parts };
}

export function formatLocator(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const locator = value as {
    kind?: unknown;
    uri?: unknown;
    fragment?: unknown;
  };
  const fragment = typeof locator.fragment === "string" ? locator.fragment : "";
  const parsed = parseFragment(fragment);
  if (!parsed.ok) return typeof locator.uri === "string" ? locator.uri : "";
  const parts = parsed.parts;
  if (locator.kind === "pdf" && parts.page) return `PDF 第 ${parts.page} 页`;
  if (parts.lines) {
    const [start, end] = parts.lines.split("-");
    return start === end ? `第 ${start} 行` : `第 ${start}–${end} 行`;
  }
  if (parts.page) return `第 ${parts.page} 页`;
  if (parts.t)
    return parts.t.includes(",")
      ? `第 ${parts.t.replace(",", "–")} 秒`
      : `第 ${parts.t} 秒`;
  return typeof locator.uri === "string" ? locator.uri : "";
}

export function formatBlob(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) return "";
  return value.slice(0, 8);
}

export function formatTable(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return "";
  const rows = value.filter((item) => Array.isArray(item));
  if (!rows.length) return "";
  const columns = rows.reduce((max, item) => Math.max(max, item.length), 0);
  return `${rows.length} 行 × ${columns} 列`;
}

export function formatList(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return "";
  return `${value.length} 项`;
}

export function normalizeTags(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const item of items) {
    const text = item.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    next.push(text);
  }
  return next;
}
