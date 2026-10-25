/** 界面用的 Schema 子集。校验仍由内核做，这里只读提示关键字。 */
export type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  enum?: unknown[];
  additionalProperties?: boolean;
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
  if (kind === "integer" || kind === "number") {
    const text = String(value);
    const unit = schema["x-sand-unit"];
    return unit ? `${text} ${unit}` : text;
  }
  if (value && typeof value === "object" && !Array.isArray(value))
    return formatObject(value as Record<string, unknown>, schema);
  if (kind === "boolean") return value ? "是" : "否";
  if (kind === "enum") {
    const labels = schema["x-sand-enum-labels"] ?? {};
    const named = labels[String(value)];
    return named || String(value);
  }
  if (
    kind === "object" &&
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
  )
    return formatObject(value as Record<string, unknown>, schema);
  if (Array.isArray(value)) {
    const itemSchema = schema.items ?? {};
    return value
      .map((item) =>
        item && typeof item === "object"
          ? formatObject(item as Record<string, unknown>, itemSchema)
          : formatValue(item, itemSchema),
      )
      .filter(Boolean)
      .join("、");
  }
  return String(value);
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
