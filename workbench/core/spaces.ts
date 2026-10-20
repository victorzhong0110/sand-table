export type Camera = { x: number; y: number; zoom: number };
export type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
  pinned: boolean;
};
export type Space = { id: string; title: string; parentId?: string };
export type ComponentInstance = {
  id: string;
  spaceId: string;
  type: string;
  objectId?: string;
  appearance?: { icon?: string; detail?: "full" | "label" | "icon" };
  title: string;
  data: Record<string, unknown>;
  rect: Rect;
  updatedAt: number;
  author: string;
};
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
  { type: "text", title: "说明／便签", width: 280, height: 180 },
  { type: "heading", title: "标题", width: 320, height: 90 },
  { type: "resource", title: "资源／媒体", width: 280, height: 180 },
  { type: "code", title: "代码片段", width: 340, height: 220 },
  { type: "metric", title: "指标", width: 220, height: 140 },
  { type: "status", title: "状态", width: 240, height: 150 },
  { type: "chart", title: "图表", width: 360, height: 240 },
  { type: "table", title: "表格", width: 360, height: 220 },
  { type: "events", title: "事件", width: 320, height: 220 },
  { type: "task", title: "任务／清单", width: 280, height: 200 },
  { type: "reasoning", title: "问题／证据／决策", width: 320, height: 220 },
  { type: "comparison", title: "比较", width: 340, height: 220 },
  { type: "intent", title: "改动意图", width: 300, height: 180 },
  { type: "proposal", title: "目标版本", width: 300, height: 180 },
  { type: "validation", title: "验证结果", width: 300, height: 180 },
] as const;
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
