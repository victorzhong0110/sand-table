import type { ErrorObject } from "ajv";
import type { JsonSchema } from "./types.ts";

export type SchemaProblem = { path: string; message: string };

const TYPE_NAMES: Record<string, string> = {
  number: "数字",
  integer: "整数",
  string: "文字",
  array: "列表",
  object: "对象",
  boolean: "是或否",
  null: "空",
};

export function ajvErrorsToFieldErrors(
  errors: ErrorObject[] | null | undefined,
  schema: JsonSchema,
): SchemaProblem[] {
  return (errors ?? []).map((error) => {
    const path = errorPath(error);
    const located = locate(schema, path);
    const text = messageFor(error, located.node);
    return {
      path,
      message: located.label ? `${located.label}：${text}` : text,
    };
  });
}

function errorPath(error: ErrorObject) {
  if (error.keyword === "required") {
    const name = String(
      (error.params as { missingProperty?: string }).missingProperty ?? "",
    );
    return joinPointer(error.instancePath, name);
  }
  if (error.keyword === "additionalProperties") {
    const name = String(
      (error.params as { additionalProperty?: string }).additionalProperty ??
        "",
    );
    return joinPointer(error.instancePath, name);
  }
  return error.instancePath || "";
}

function messageFor(
  error: ErrorObject,
  node: Record<string, unknown> | undefined,
) {
  const limit = (error.params as { limit?: number }).limit;
  switch (error.keyword) {
    case "type":
      return `必须是${typeName((error.params as { type?: unknown }).type)}`;
    case "minimum":
      return `不能小于 ${limit}`;
    case "maximum":
      return `不能大于 ${limit}`;
    case "minLength":
      return `至少 ${limit} 个字`;
    case "maxLength":
      return `最多 ${limit} 个字`;
    case "minItems":
      return `至少 ${limit} 项`;
    case "maxItems":
      return `最多 ${limit} 项`;
    case "enum":
      return `只能是：${enumNames(error, node)}`;
    case "required":
      return "必须填写";
    case "additionalProperties":
      return "这个类型没有这个字段";
    case "format":
      return "格式不对";
    default:
      return error.message ?? "数据不符合这个类型的要求。";
  }
}

function typeName(type: unknown) {
  const names = (Array.isArray(type) ? type : [type]).map((item) =>
    TYPE_NAMES[String(item)] ? TYPE_NAMES[String(item)] : String(item),
  );
  return names.join("、");
}

function enumNames(
  error: ErrorObject,
  node: Record<string, unknown> | undefined,
) {
  const labels = node?.["x-sand-enum-labels"];
  const allowed =
    (error.params as { allowedValues?: unknown[] }).allowedValues ?? [];
  return allowed
    .map((value) => {
      const key = String(value);
      if (labels && typeof labels === "object" && !Array.isArray(labels)) {
        const label = (labels as Record<string, unknown>)[key];
        if (typeof label === "string" && label) return label;
      }
      return key;
    })
    .join("、");
}

function locate(schema: JsonSchema, path: string) {
  const parts = path.split("/").filter(Boolean).map(unescapePointer);
  let node: unknown = schema;
  let label = "";
  for (const part of parts) {
    if (!node || typeof node !== "object" || Array.isArray(node)) break;
    const record = node as Record<string, unknown>;
    const properties = record.properties;
    if (
      properties &&
      typeof properties === "object" &&
      !Array.isArray(properties) &&
      Object.prototype.hasOwnProperty.call(properties, part)
    ) {
      node = (properties as Record<string, unknown>)[part];
      const named =
        node &&
        typeof node === "object" &&
        !Array.isArray(node) &&
        typeof (node as Record<string, unknown>)["x-sand-label"] === "string"
          ? String((node as Record<string, unknown>)["x-sand-label"])
          : "";
      label = named || part;
      continue;
    }
    if (record.items && /^\d+$/.test(part)) {
      node = record.items;
      continue;
    }
    label = label || part;
    node = undefined;
  }
  return {
    label,
    node:
      node && typeof node === "object" && !Array.isArray(node)
        ? (node as Record<string, unknown>)
        : undefined,
  };
}

function joinPointer(base: string, name: string) {
  return `${base}/${escapePointer(name)}`;
}

function escapePointer(name: string) {
  return name.replaceAll("~", "~0").replaceAll("/", "~1");
}

function unescapePointer(name: string) {
  return name.replaceAll("~1", "/").replaceAll("~0", "~");
}
