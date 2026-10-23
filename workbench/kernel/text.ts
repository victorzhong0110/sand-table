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
  return input
    .replace(/```[\w-]*\n?([\s\S]*?)```/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/(\*\*\*|___)(.*?)\1/g, "$2")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/~~(.*?)~~/g, "$1")
    .trim();
}

function clip(text: string, max: number) {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return chars.slice(0, max).join("");
}
