import type { TypeSpec } from "./types.ts";

const SUMMARY_LIMIT = 160;

export function summarize(
  spec: TypeSpec | undefined,
  data: Record<string, unknown>,
  title: string,
): string {
  for (const field of spec?.display.summary ?? []) {
    if (!Object.prototype.hasOwnProperty.call(data, field)) continue;
    const text = fieldText(data[field]);
    if (!text) continue;
    return clip(stripMarkdown(text), SUMMARY_LIMIT);
  }
  return clip(stripMarkdown(title), SUMMARY_LIMIT);
}

function fieldText(value: unknown): string {
  if (typeof value === "string") return value.trim() ? value : "";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => fieldText(item))
      .filter((item) => item !== "");
    return parts.join("、");
  }
  return "";
}

function stripMarkdown(input: string) {
  const code: string[] = [];
  const hold = (body: string) => {
    code.push(body);
    return `\uE000${String(code.length - 1)}\uE000`;
  };
  const text = input
    .replace(/```[^\n]*\n([\s\S]*?)```/g, (_, body: string) => hold(body))
    .replace(
      /(^|[^`])`([^`]+)`(?!`)/g,
      (_, lead: string, body: string) => lead + hold(body),
    )
    .replace(/!\[[^\]]*]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/\*\*\*(.*?)\*\*\*/g, "$1")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    // 紧贴文字的下划线是标识符，不是强调。
    .replace(/(^|[^\p{L}\p{N}_])_([^_\n]+?)_(?=$|[^\p{L}\p{N}_])/gu, "$1$2")
    .replace(/~~(.*?)~~/g, "$1")
    .replace(
      /\uE000(\d+)\uE000/g,
      (_, index: string) => code[Number(index)] ?? "",
    );
  return text.trim();
}

function clip(text: string, max: number) {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return chars.slice(0, max).join("");
}
