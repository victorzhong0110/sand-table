import type { Presentation, Rect } from "./objects.ts";
export type { Presentation, Rect } from "./objects.ts";
export type Camera = { x: number; y: number; zoom: number };
export type Space = { id: string; title: string; parentId?: string };
/**
 * 展示实例：对象在某白板上的一次呈现。
 * 内容由被绑定的对象提供，布局与展示状态由实例自己持有。
 * 见 docs/architecture/workspace-kernel.zh-CN.md 第 3 节。
 */
export type ComponentInstance = Presentation;
export type SpaceLink = {
  id: string;
  source: string;
  target: string;
  kind: "related" | "depends-on" | "supports" | "compares" | "belongs-to";
  description: string;
  author: string;
};
export type View = {
  id: string;
  spaceId: string;
  selection: string[];
  camera: Camera;
  updatedAt: number;
};
export type Asset = {
  id: string;
  name: string;
  mime: string;
  dataUrl?: string;
  bytes: number;
};
export type ThemeConfig = {
  base: "paper" | "mono";
  background: string;
  surface: string;
  ink: string;
  muted: string;
  line: string;
  accent: string;
  font: "system" | "serif" | "mono";
  density: "comfortable" | "compact";
  radius: number;
  reduceMotion: boolean;
};
export const componentTypes = [
  { type: "object", title: "对象引用", width: 252, height: 120 },
  { type: "board", title: "白板", width: 280, height: 160 },
  { type: "space-link", title: "白板入口", width: 252, height: 120 },
  { type: "text", title: "便签", width: 280, height: 180 },
  { type: "heading", title: "标题", width: 320, height: 90 },
  { type: "resource", title: "媒体", width: 280, height: 180 },
  { type: "code", title: "代码片段", width: 340, height: 220 },
  { type: "metric", title: "指标", width: 220, height: 140 },
  { type: "status", title: "状态", width: 240, height: 150 },
  { type: "chart", title: "图表", width: 360, height: 240 },
  { type: "table", title: "表格", width: 360, height: 220 },
  { type: "events", title: "事件", width: 320, height: 220 },
  { type: "task", title: "任务", width: 280, height: 200 },
  { type: "reasoning", title: "推理", width: 320, height: 220 },
  { type: "comparison", title: "比较", width: 340, height: 220 },
  { type: "intent", title: "改动意图", width: 300, height: 180 },
  { type: "proposal", title: "目标版本", width: 300, height: 180 },
  { type: "validation", title: "验证结果", width: 300, height: 180 },
] as const;
/**
 * 原生内容类型：内容进入对象，实例只负责呈现与布局。
 * 同一个对象可以出现在多块白板上，改内容会同时更新所有展示。
 * 见 docs/architecture/workspace-kernel.zh-CN.md 第 3 节。
 */
export const nativeContentTypes = [
  "text",
  "heading",
  "code",
  "metric",
  "status",
  "chart",
  "table",
  "events",
  "task",
  "reasoning",
  "comparison",
] as const;

/** 指向外部资源的类型：内容是引用，失效必须可识别。 */
export const referenceContentTypes = ["resource"] as const;

export function isNativeContent(type: string) {
  return (nativeContentTypes as readonly string[]).includes(type);
}

export function isReferenceContent(type: string) {
  return (referenceContentTypes as readonly string[]).includes(type);
}

export function defaultData(type: string): Record<string, unknown> {
  switch (type) {
    case "text":
      return { text: "" };
    case "heading":
      return { text: "" };
    case "resource":
      return { url: "", description: "" };
    case "code":
      return { language: "text", text: "" };
    case "metric":
      return { value: "—", unit: "", description: "" };
    case "status":
      return { state: "unknown", description: "尚无状态来源", sourceUrl: "" };
    case "chart":
      return { kind: "bar", points: [] };
    case "table":
      return { columns: ["项目", "内容"], rows: [] };
    case "events":
      return { events: [] };
    case "task":
      return { goal: "", items: [] };
    case "reasoning":
      return {
        question: "",
        evidence: [],
        options: [],
        decision: "",
        unknowns: "",
      };
    case "comparison":
      return {
        left: { title: "方案 A", text: "" },
        right: { title: "方案 B", text: "" },
        conclusion: "",
      };
    default:
      return {};
  }
}
/**
 * The check every write of component data goes through — the editor, the
 * Agent's tools and an imported component pack all use this one function, so
 * there is a single set of rules rather than several that drift apart.
 */
export function checkComponentData(type: string, data: Record<string, unknown>) {
  if (JSON.stringify(data).length > 40000)
    throw Error("Component data exceeds 40 KB.");
  if (data.url && !safeUrl(data.url))
    throw Error("Resource URL must use HTTP(S).");
  if (data.sourceUrl && !safeUrl(data.sourceUrl))
    throw Error("Source URL must use HTTP(S).");
  if (type === "chart") {
    const p = data.points;
    if (!Array.isArray(p)) throw Error("Chart needs up to 100 finite labeled values: points must be an array.");
    if (p.length > 100) throw Error("Chart needs up to 100 finite labeled values: at most 100 points.");
    p.forEach((v: any, index: number) => {
      if (!v || typeof v !== "object") throw Error(`Chart needs up to 100 finite labeled values: points[${index}] must be an object.`);
      if (typeof v.label !== "string")
        throw Error(`Chart needs up to 100 finite labeled values: points[${index}].label must be a string.`);
      if (v.label.length > 100)
        throw Error(`Chart needs up to 100 finite labeled values: points[${index}].label is longer than 100 characters.`);
      if (!Number.isFinite(v.value))
        throw Error(`Chart needs up to 100 finite labeled values: points[${index}].value must be a finite number.`);
    });
  }
  if (type === "table") {
    if (!Array.isArray(data.columns)) throw Error("Table dimensions or values are invalid: columns must be an array.");
    if (data.columns.length > 20) throw Error("Table dimensions or values are invalid: at most 20 columns.");
    data.columns.forEach((v, index) => {
      if (typeof v !== "string") throw Error(`Table dimensions or values are invalid: columns[${index}] must be a string.`);
    });
    if (!Array.isArray(data.rows)) throw Error("Table dimensions or values are invalid: rows must be an array.");
    if (data.rows.length > 200) throw Error("Table dimensions or values are invalid: at most 200 rows.");
    data.rows.forEach((row, rowIndex) => {
      if (!Array.isArray(row)) throw Error(`Table dimensions or values are invalid: rows[${rowIndex}] must be an array.`);
      const columns = data.columns as unknown[];
      if (row.length !== columns.length)
        throw Error(
          `Table dimensions or values are invalid: rows[${rowIndex}] must have ${columns.length} columns, got ${row.length}.`,
        );
      row.forEach((v, cellIndex) => {
        if (!["string", "number", "boolean"].includes(typeof v) && v !== null)
          throw Error(
            `Table dimensions or values are invalid: rows[${rowIndex}][${cellIndex}] must be a string, number, boolean or null.`,
          );
      });
    });
  }
  if (type === "task") {
    // 报错要能指到具体位置：items[1].done 应为 boolean，而不是一句"清单值不合法"。
    if (!Array.isArray(data.items)) throw Error("Checklist values are invalid: items must be an array.");
    if (data.items.length > 100) throw Error("Checklist values are invalid: at most 100 items.");
    data.items.forEach((item: any, index: number) => {
      if (!item || typeof item !== "object")
        throw Error(`Checklist values are invalid: items[${index}] must be an object.`);
      if (typeof item.text !== "string")
        throw Error(`Checklist values are invalid: items[${index}].text must be a string.`);
      if (typeof item.done !== "boolean")
        throw Error(`Checklist values are invalid: items[${index}].done must be a boolean.`);
    });
  }
  if (type === "events") {
    if (!Array.isArray(data.events)) throw Error("At most 100 current events: events must be an array.");
    if (data.events.length > 100) throw Error("At most 100 current events: at most 100 events.");
  }
}
export function safeUrl(value: unknown) {
  if (typeof value !== "string" || !value) return undefined;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

// Presentation changes never replace the expanded geometry or source data.
export const componentIcons = [
  "text",
  "board",
  "code",
  "resource",
  "chart",
  "table",
  "task",
  "reasoning",
  "comparison",
  "events",
  "metric",
  "status",
  "ai",
  "intent",
  "proposal",
  "validation",
];
export function displayRect(c: ComponentInstance, rect = c.rect): Rect {
  return c.appearance?.detail === "icon"
    ? { ...rect, width: 48, height: 48 }
    : c.appearance?.detail === "label"
      ? { ...rect, width: Math.min(rect.width, 240), height: 48 }
      : rect;
}
export function material(type: string) {
  return ["text", "heading", "reasoning", "comparison", "task"].includes(type)
    ? "paper"
    : ["board", "space-link"].includes(type)
      ? "container"
      : ["code"].includes(type)
        ? "screen"
        : [
              "chart",
              "table",
              "metric",
              "status",
              "events",
              "validation",
            ].includes(type)
          ? "instrument"
          : type === "resource"
            ? "media"
            : "document";
}
