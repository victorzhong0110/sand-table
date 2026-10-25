import {
  formatBlob,
  formatBoolean,
  formatColor,
  formatDate,
  formatEnum,
  formatList,
  formatLocator,
  formatLongText,
  formatMarkdown,
  formatNumber,
  formatTable,
  formatTags,
  formatUrl,
} from "../widgets/display.ts";

/** 界面用的 Schema 子集。校验仍由内核做，这里只读提示关键字。 */
export type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  enum?: unknown[];
  anyOf?: JsonSchema[];
  additionalProperties?: boolean;
  maxLength?: number;
  minLength?: number;
  minimum?: number;
  maximum?: number;
  "x-sand-label"?: string;
  "x-sand-widget"?: string;
  "x-sand-placeholder"?: string;
  "x-sand-unit"?: string;
  "x-sand-enum-labels"?: Record<string, string>;
  "x-sand-hidden"?: boolean;
  "x-sand-default"?: unknown;
};

export type TypeSpecView = {
  type: string;
  title: string;
  description?: string;
  icon?: string;
  version?: number;
  schema?: JsonSchema;
  capabilities?: { container?: boolean; cover?: boolean };
  display?: {
    material?: string;
    summary?: string[];
    view?: string;
  };
  relationSlots?: RelationSlotView[];
};

export type RelationSlotView = {
  key: string;
  label: string;
  kind: string;
  direction: "out" | "in";
  targetTypes?: string[];
  many: boolean;
};

/** 没填是 undefined。0、false、空数组都算有值。 */
export function hasValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

export function schemaType(schema: JsonSchema): string | undefined {
  if (Array.isArray(schema.type))
    return schema.type.find((item) => item !== "null");
  return schema.type;
}

export function widgetKind(schema: JsonSchema): string {
  const named = schema["x-sand-widget"];
  if (typeof named === "string" && named) return named;
  if (schema.enum?.length) return "enum";
  const type = schemaType(schema);
  if (type === "integer") return "integer";
  if (type === "number") return "number";
  if (type === "boolean") return "boolean";
  if (type === "object") return "object";
  if (type === "array")
    return schema.items && schemaType(schema.items) === "string"
      ? "tags"
      : "list";
  return "text";
}

export function fieldLabel(
  key: string,
  schema: JsonSchema | undefined,
): string {
  const label = schema?.["x-sand-label"];
  return typeof label === "string" && label ? label : key;
}

/** 把一个值格式化成卡片上的一行。对象按字段展开，不把对象变成字符串。 */
export function formatValue(value: unknown, schema: JsonSchema = {}): string {
  if (!hasValue(value)) return "";
  const kind = widgetKind(schema);
  if (kind === "integer" || kind === "number")
    return formatNumber(value, schema);
  if (kind === "boolean") return formatBoolean(value);
  if (kind === "enum") return formatEnum(value, schema);
  if (kind === "tags") return formatTags(value);
  if (kind === "date") return formatDate(value);
  if (kind === "url") return formatUrl(value);
  if (kind === "longtext") return formatLongText(value);
  if (kind === "markdown") return formatMarkdown(value);
  if (kind === "color") return formatColor(value);
  if (kind === "locator") return formatLocator(value);
  if (kind === "blob") return formatBlob(value);
  if (kind === "table") return formatTable(value);
  if (kind === "list") return formatList(value);
  if (value && typeof value === "object" && !Array.isArray(value))
    return formatObject(value as Record<string, unknown>, schema);
  if (
    kind === "object" &&
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
  )
    return formatObject(value as Record<string, unknown>, schema);
  if (Array.isArray(value)) {
    const itemSchema = schema.items ?? {};
    const parts = value
      .map((item) => formatValue(item, itemSchema))
      .filter(Boolean);
    return parts.join(value.some((item) => Array.isArray(item)) ? "；" : "、");
  }
  return String(value);
}

/** 这一格允许的 JSON 类型。anyOf 里的每一支都算。 */
export function scalarTypes(schema: JsonSchema): Set<string> {
  const found = new Set<string>();
  const own = schemaType(schema);
  if (own) found.add(own);
  for (const alt of schema.anyOf ?? []) {
    const type = schemaType(alt);
    if (type) found.add(type);
  }
  return found;
}

/**
 * 列表要不要按项递归编辑。
 *
 * 字符串标签可以打成一行。数组的数组、对象和数字格不能：
 * 打成标签会把一行表格拆成扁平字符串，内核按模式拒绝。
 */
export function listEditorKind(schema: JsonSchema): "tags" | "nested" {
  if (schema["x-sand-widget"] === "list" || schema["x-sand-widget"] === "table")
    return "nested";
  if (schema["x-sand-widget"] === "tags") return "tags";
  const item = schema.items ?? {};
  if (item["x-sand-widget"] === "tags") return "tags";
  const kind = widgetKind(item);
  if (kind === "object" || kind === "list" || kind === "table") return "nested";
  const type = schemaType(item);
  if (
    type === "array" ||
    type === "object" ||
    type === "number" ||
    type === "integer" ||
    type === "boolean"
  )
    return "nested";
  if (item.anyOf?.length) return "nested";
  return "tags";
}

/** 改列表里的一项。允许空值时留 null，避免把后面的格子挤掉。 */
export function nextListItem(
  items: readonly unknown[],
  index: number,
  next: unknown,
  itemSchema: JsonSchema,
): unknown[] {
  const copy = [...items];
  if (next === undefined) {
    if (scalarTypes(itemSchema).has("null")) copy[index] = null;
    else copy.splice(index, 1);
  } else copy[index] = next;
  return copy;
}

/** 按格子的类型把文本解析回去。数字格继续是数字，不变成字符串。 */
export function parseScalar(raw: string, schema: JsonSchema): unknown {
  const text = raw.trim();
  if (!text) return undefined;
  const types = scalarTypes(schema);
  if (types.has("null") && text === "null") return null;
  if (types.has("boolean") && (text === "true" || text === "是")) return true;
  if (types.has("boolean") && (text === "false" || text === "否")) return false;
  if (types.has("number") || types.has("integer")) {
    if (/^-?\d+(?:\.\d+)?$/.test(text)) {
      const value = Number(text);
      if (!Number.isNaN(value)) {
        if (types.has("integer") && !types.has("number"))
          return Math.trunc(value);
        return value;
      }
    }
  }
  if (types.has("string") || types.size === 0) return text;
  return text;
}

export type NumberDraft = { complete: boolean; value: number | undefined };

/**
 * 打字过程中的数字。`0.` 和单独的 `-` 还没写完，不能先变成 0，
 * 否则下一字会接到 0 后面变成 05。
 */
export function parseNumberDraft(raw: string, integer: boolean): NumberDraft {
  const text = raw.trim();
  if (!text) return { complete: true, value: undefined };
  if (text === "-" || text === "." || text === "-." || text.endsWith("."))
    return { complete: false, value: undefined };
  const pattern = integer ? /^-?\d+$/ : /^-?(?:\d+\.\d+|\d+|\.\d+)$/;
  if (!pattern.test(text)) return { complete: false, value: undefined };
  const value = integer ? Number.parseInt(text, 10) : Number(text);
  if (Number.isNaN(value)) return { complete: false, value: undefined };
  return { complete: true, value };
}

/** 离开输入框时把还没写完的小数收成数字。单独的负号清空。 */
export function commitNumberDraft(
  raw: string,
  integer: boolean,
): number | undefined {
  const parsed = parseNumberDraft(raw, integer);
  if (parsed.complete) return parsed.value;
  const trimmed = parseNumberDraft(raw.trim().replace(/\.$/, ""), integer);
  return trimmed.complete ? trimmed.value : undefined;
}

export type NumberCommit =
  { ok: true; value: number | undefined } | { ok: false; message: string };

/** 空输入清空。整数拒绝小数。超出上下限时说明原因，不写入。 */
export function commitNumber(raw: string, schema: JsonSchema): NumberCommit {
  const integer = widgetKind(schema) === "integer";
  const text = raw.trim();
  if (!text) return { ok: true, value: undefined };
  if (integer && /^-?\d+\.\d+$/.test(text))
    return { ok: false, message: "整数不能有小数。请改成整数后再保存。" };
  const draft = parseNumberDraft(text, integer);
  const value = draft.complete ? draft.value : commitNumberDraft(text, integer);
  if (value === undefined)
    return {
      ok: false,
      message: integer ? "请输入整数。" : "请输入数字。",
    };
  if (typeof schema.minimum === "number" && value < schema.minimum)
    return { ok: false, message: `不能小于 ${schema.minimum}。` };
  if (typeof schema.maximum === "number" && value > schema.maximum)
    return { ok: false, message: `不能大于 ${schema.maximum}。` };
  return { ok: true, value };
}

const IMAGE_PREFIXES: readonly [string, string][] = [
  ["iVBORw0KGgo", "image/png"],
  ["/9j/", "image/jpeg"],
  ["R0lGOD", "image/gif"],
  ["UklGR", "image/webp"],
];

/** 附件读取给出的 data URL。不是图片，或认不出格式时返回 undefined。 */
export function imageDataUrl(dataUrl: string): string | undefined {
  const match = /^data:([^;,]*);base64,([A-Za-z0-9+/=\s]+)$/s.exec(
    dataUrl.trim(),
  );
  if (!match) return undefined;
  const payload = match[2].replace(/\s/g, "");
  if (!payload) return undefined;
  if (match[1].startsWith("image/"))
    return `data:${match[1]};base64,${payload}`;
  const sniffed = IMAGE_PREFIXES.find(([prefix]) => payload.startsWith(prefix));
  if (!sniffed) return undefined;
  return `data:${sniffed[1]};base64,${payload}`;
}

function formatObject(
  value: Record<string, unknown>,
  schema: JsonSchema,
): string {
  const properties = schema.properties ?? {};
  const keys = Object.keys(properties).length
    ? Object.keys(properties)
    : Object.keys(value);
  return keys
    .flatMap((key) => {
      const child = value[key];
      if (!hasValue(child)) return [];
      const childSchema = properties[key] ?? {};
      if (childSchema["x-sand-hidden"]) return [];
      const shown = formatValue(child, childSchema);
      if (!shown) return [];
      return [`${fieldLabel(key, childSchema)} ${shown}`];
    })
    .join("，");
}

export type SummaryLine = { key: string; label: string; text: string };

/** summary 里有值的字段才出现。0 要出现，没填的不出现。 */
export function summaryLines(
  data: Record<string, unknown>,
  summary: readonly string[] | undefined,
  properties: Record<string, JsonSchema> | undefined,
): SummaryLine[] {
  const lines: SummaryLine[] = [];
  for (const key of summary ?? []) {
    const schema = properties?.[key] ?? {};
    if (schema["x-sand-hidden"]) continue;
    if (!hasValue(data[key])) continue;
    const text = formatValue(data[key], schema);
    if (!text) continue;
    lines.push({ key, label: fieldLabel(key, schema), text });
  }
  return lines;
}

export function packIdOf(type: string): string {
  const dot = type.indexOf(".");
  return dot > 0 ? type.slice(0, dot) : type;
}

export function parseToolError(text: string): {
  code: string;
  message: string;
} {
  try {
    const parsed = JSON.parse(text) as { code?: unknown; message?: unknown };
    if (parsed && typeof parsed === "object")
      return {
        code: typeof parsed.code === "string" ? parsed.code : "",
        message: typeof parsed.message === "string" ? parsed.message : text,
      };
  } catch {
    /* 普通错误文本不是 JSON。 */
  }
  return { code: "", message: text };
}
