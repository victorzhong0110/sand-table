// 基础内置包：白板、便签、图表、任务等通用类型与关系。
//
// 这个包只写声明：数据长什么样、怎么显示、怎么编辑、能和谁建立什么关系。
// 不含工具，也不含界面。
//
// 字段限制从 v2 搬来（workbench/core/spaces.ts 的 checkComponentData 与
// workbench/domains/ 的 check 函数）：v2 给了数字的就用 v2 的数字；v2 没给
// 数字的地方，长文本用 20000、中等文本用 2000、短文本用 200、链接用 2000。
//
// v2 的占位值不留：内容字段不写 default，配置类默认值写在 x-sand-default，
// 没填就是字段不存在。

import type { JsonSchema, PackSpec } from "../../kernel/index.ts";

/** 空字符串表示还没填；填了就必须是 http 或 https。 */
const HTTP_URL = "^(?:[hH][tT][tT][pP][sS]?://\\S+)?$";

const tableKey = {
  type: "string",
  pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$",
  "x-sand-label": "标识",
  "x-sand-widget": "text",
};
const cell = {
  anyOf: [
    { type: "string" },
    { type: "number" },
    { type: "boolean" },
    { type: "null" },
  ],
};
const filterFields: Record<string, JsonSchema> = {
  column: { ...tableKey, "x-sand-label": "列" },
  op: {
    type: "string",
    enum: ["eq", "contains", "gt", "lt", "between", "empty", "not_empty"],
    "x-sand-label": "条件",
    "x-sand-widget": "enum",
  },
  value: { ...cell, "x-sand-label": "筛选值", "x-sand-widget": "text" },
  upper: { ...cell, "x-sand-label": "上限", "x-sand-widget": "text" },
};
const tableView: JsonSchema = {
  type: "object",
  additionalProperties: false,
  "x-sand-label": "表格视图",
  "x-sand-widget": "table",
  "x-sand-hidden": true,
  properties: {
    calculated: {
      type: "array",
      maxItems: 200,
      "x-sand-label": "计算列",
      "x-sand-widget": "list",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "label", "formula"],
        properties: {
          key: tableKey,
          label: {
            type: "string",
            maxLength: 200,
            "x-sand-label": "名称",
            "x-sand-widget": "text",
          },
          formula: {
            type: "string",
            minLength: 1,
            maxLength: 20000,
            "x-sand-label": "公式",
            "x-sand-widget": "text",
          },
        },
      },
    },
    filters: {
      type: "array",
      maxItems: 200,
      "x-sand-label": "筛选条件",
      "x-sand-widget": "list",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["column", "op"],
        properties: filterFields,
      },
    },
    sort: {
      type: "array",
      maxItems: 200,
      "x-sand-label": "排序",
      "x-sand-widget": "list",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["column", "direction"],
        properties: {
          column: { ...tableKey, "x-sand-label": "列" },
          direction: {
            type: "string",
            enum: ["asc", "desc"],
            "x-sand-label": "方向",
            "x-sand-widget": "enum",
          },
        },
      },
    },
    groupBy: { ...tableKey, "x-sand-label": "分组列" },
  },
};
const oldChartPoints: JsonSchema = {
  type: "array",
  maxItems: 100,
  "x-sand-label": "旧图表数据点",
  "x-sand-widget": "list",
  "x-sand-hidden": true,
  items: {
    type: "object",
    additionalProperties: false,
    required: ["label", "value"],
    properties: {
      label: {
        type: "string",
        maxLength: 100,
        "x-sand-label": "标签",
        "x-sand-widget": "text",
      },
      value: {
        type: "number",
        "x-sand-label": "数值",
        "x-sand-widget": "number",
      },
    },
  },
};

function numericCell(value: unknown) {
  return (
    (typeof value === "number" && Number.isFinite(value)) ||
    (typeof value === "string" &&
      Number.isFinite(Number(value)) &&
      String(Number(value)) === value)
  );
}

export function migrateTable(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const labels = Array.isArray(data.columns) ? data.columns : [];
  const rows = Array.isArray(data.rows) ? data.rows : [];
  if (rows.length > 200) throw Error("原表超过 200 行。");
  const width = Math.max(labels.length, ...rows.map((row) => row.length));
  if (width > 200) throw Error("原表超过 200 列。");
  const columns = Array.from({ length: width }, (_, index) => {
    const items = rows
      .map((row) => row[index])
      .filter((value) => value != null && value !== "");
    return {
      key: `c${index + 1}`,
      label: labels[index] ?? `列 ${index + 1}`,
      type: items.length && items.every(numericCell) ? "number" : "text",
    };
  });
  return {
    columns,
    rows: rows.map((row, index) => ({
      key: `r${index + 1}`,
      cells: Object.fromEntries(
        columns.map(({ key, type }, column) => {
          const value = row[column] ?? null;
          return [
            key,
            type === "number" && value !== "" && value !== null
              ? Number(value)
              : value,
          ];
        }),
      ),
    })),
  };
}

export function migrateMetric(data: Record<string, unknown>) {
  const { value, description, ...rest } = data;
  const legacy = {
    ...(value === undefined ? {} : { value }),
    ...(description === undefined ? {} : { description }),
  };
  return {
    aggregate: "count",
    ...rest,
    ...(Object.keys(legacy).length ? { legacy } : {}),
  };
}

export function migrateChart(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const { points, ...rest } = data;
  return { ...rest, ...(points === undefined ? {} : { legacyPoints: points }) };
}

export function migrateComparison(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const { left, right, legacy, ...rest } = data;
  if (left === undefined && right === undefined) return data;
  const previous =
    legacy && typeof legacy === "object" && !Array.isArray(legacy)
      ? legacy
      : {};
  return {
    ...rest,
    legacy: {
      ...previous,
      ...(left === undefined ? {} : { left }),
      ...(right === undefined ? {} : { right }),
    },
  };
}

const comparisonSide = (label: string) => ({
  type: "object",
  additionalProperties: false,
  "x-sand-label": label,
  "x-sand-widget": "list",
  properties: {
    title: {
      type: "string",
      maxLength: 200,
      "x-sand-label": "方案名称",
      "x-sand-widget": "text",
    },
    text: {
      type: "string",
      maxLength: 2000,
      "x-sand-label": "方案内容",
      "x-sand-widget": "markdown",
    },
  },
});

export const basePack: PackSpec = {
  id: "base",
  title: "基础",
  version: 1,
  description: "白板、便签、图表、任务等通用类型与关系。",
  types: [
    {
      type: "base.board",
      title: "白板",
      description: "一块白板：可以进入，里面摆放展示。",
      icon: "board",
      version: 1,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      capabilities: { container: true, cover: true },
      display: {
        material: "container",
        defaultSize: { width: 280, height: 160 },
        summary: [],
      },
    },
    {
      type: "base.frame",
      title: "框",
      description: "画布上的一块框，用来给对象分组。",
      icon: "arrange",
      version: 1,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      display: {
        material: "document",
        defaultSize: { width: 280, height: 180 },
        summary: [],
      },
    },
    {
      type: "base.resource_reference",
      title: "资源引用",
      description: "引用插件管理的资源；本地只保存说明，正文由原插件管理。",
      icon: "link",
      version: 1,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          note: {
            type: "string",
            maxLength: 20000,
            "x-sand-label": "本地说明",
            "x-sand-widget": "longtext",
          },
        },
      },
      display: {
        material: "paper",
        defaultSize: { width: 320, height: 280 },
        summary: ["note"],
      },
    },
    {
      type: "base.timeline",
      title: "时间轴",
      description: "按明确选择的时间字段排列绑定条目。",
      icon: "events",
      version: 1,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          dimension: {
            type: "object",
            additionalProperties: false,
            required: ["kind", "field", "label"],
            "x-sand-label": "时间维度",
            "x-sand-widget": "table",
            "x-sand-hidden": true,
            properties: {
              kind: {
                type: "string",
                enum: ["number", "date"],
                "x-sand-label": "维度类型",
                "x-sand-widget": "enum",
              },
              field: {
                type: "string",
                minLength: 1,
                maxLength: 100,
                "x-sand-label": "时间字段",
                "x-sand-widget": "text",
              },
              endField: {
                type: "string",
                minLength: 1,
                maxLength: 100,
                "x-sand-label": "结束字段",
                "x-sand-widget": "text",
              },
              label: {
                type: "string",
                minLength: 1,
                maxLength: 200,
                "x-sand-label": "维度名称",
                "x-sand-widget": "text",
              },
            },
          },
          tracks: {
            type: "string",
            enum: ["type", "none"],
            "x-sand-default": "type",
            "x-sand-label": "按类型分轨",
            "x-sand-widget": "enum",
            "x-sand-enum-labels": { type: "按类型", none: "单轨" },
          },
        },
      },
      display: {
        material: "document",
        defaultSize: { width: 600, height: 400 },
        summary: ["tracks"],
        view: "timeline",
      },
      relationSlots: [
        {
          key: "items",
          label: "时间条目",
          kind: "base.timeline_item",
          direction: "out",
          many: true,
        },
      ],
    },
    {
      type: "base.relation_graph",
      title: "关系图",
      description: "从中心对象展开工作空间中已有的关系。",
      icon: "link",
      version: 1,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          depth: {
            type: "integer",
            enum: [1, 2, 3],
            "x-sand-default": 1,
            "x-sand-label": "展开层数",
            "x-sand-widget": "integer",
          },
          kinds: {
            type: "array",
            items: { type: "string", maxLength: 100 },
            maxItems: 200,
            uniqueItems: true,
            "x-sand-label": "关系类型",
            "x-sand-widget": "list",
            "x-sand-hidden": true,
          },
          layout: {
            type: "string",
            enum: ["layered", "radial"],
            "x-sand-default": "layered",
            "x-sand-label": "布局",
            "x-sand-widget": "enum",
            "x-sand-enum-labels": { layered: "分层", radial: "放射" },
          },
        },
      },
      display: {
        view: "relation-graph",
        material: "document",
        defaultSize: { width: 520, height: 390 },
        summary: ["depth", "layout"],
      },
      relationSlots: [
        {
          key: "focus",
          label: "中心对象",
          kind: "base.graph_focus",
          direction: "out",
          many: true,
        },
      ],
    },
    {
      type: "base.note",
      title: "便签",
      description: "一段文字：可以关于某个对象。",
      icon: "text",
      version: 1,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          body: {
            type: "string",
            maxLength: 20000,
            "x-sand-label": "正文",
            "x-sand-widget": "markdown",
          },
        },
      },
      display: {
        material: "paper",
        defaultSize: { width: 280, height: 180 },
        summary: ["body"],
      },
      relationSlots: [
        {
          key: "about",
          label: "关于",
          kind: "base.about",
          direction: "out",
          many: false,
        },
      ],
    },
    {
      type: "base.comment",
      title: "评论",
      description: "附在对象或单处展示上的讨论。",
      icon: "text",
      version: 1,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["body"],
        properties: {
          body: {
            type: "string",
            minLength: 1,
            maxLength: 20000,
            "x-sand-label": "评论正文",
            "x-sand-widget": "markdown",
          },
          resolved: {
            type: "boolean",
            "x-sand-label": "已解决",
            "x-sand-widget": "boolean",
          },
        },
      },
      display: {
        material: "paper",
        defaultSize: { width: 280, height: 160 },
        summary: ["body", "resolved"],
      },
    },
    {
      type: "base.heading",
      title: "标题",
      description: "分段的标题文字。",
      icon: "heading",
      version: 1,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          text: {
            type: "string",
            maxLength: 200,
            "x-sand-label": "标题文字",
            "x-sand-widget": "text",
          },
          level: {
            type: "integer",
            minimum: 1,
            maximum: 3,
            "x-sand-label": "层级",
            "x-sand-widget": "integer",
            "x-sand-default": 1,
            "x-sand-enum-labels": { "1": "一级", "2": "二级", "3": "三级" },
          },
        },
      },
      display: {
        material: "paper",
        defaultSize: { width: 320, height: 90 },
        summary: ["text", "level"],
      },
    },
    {
      type: "base.link",
      title: "链接",
      description: "一个外部链接。",
      icon: "browse",
      version: 1,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          url: {
            type: "string",
            maxLength: 2000,
            pattern: HTTP_URL,
            "x-sand-label": "链接",
            "x-sand-widget": "url",
          },
          description: {
            type: "string",
            maxLength: 200,
            "x-sand-label": "说明",
            "x-sand-widget": "text",
          },
        },
      },
      display: {
        material: "document",
        defaultSize: { width: 280, height: 180 },
        summary: ["url", "description"],
      },
    },
    {
      type: "base.media",
      title: "媒体",
      description: "图片、音频或视频，内容存在附件里。",
      icon: "resource",
      version: 1,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          blob: {
            type: "string",
            pattern: "^[0-9a-f]{64}$",
            "x-sand-label": "附件",
            "x-sand-widget": "blob",
          },
          mime: {
            type: "string",
            maxLength: 200,
            "x-sand-label": "媒体类型",
            "x-sand-widget": "text",
          },
          caption: {
            type: "string",
            maxLength: 200,
            "x-sand-label": "说明文字",
            "x-sand-widget": "text",
          },
          alt: {
            type: "string",
            maxLength: 200,
            "x-sand-label": "替代文字",
            "x-sand-widget": "text",
          },
        },
      },
      display: {
        material: "media",
        defaultSize: { width: 280, height: 180 },
        summary: ["caption", "mime"],
      },
    },
    {
      type: "base.code_snippet",
      title: "代码片段",
      description: "一小段代码。",
      icon: "code",
      version: 1,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          language: {
            type: "string",
            maxLength: 40,
            "x-sand-label": "语言",
            "x-sand-widget": "text",
            "x-sand-default": "text",
          },
          text: {
            type: "string",
            maxLength: 20000,
            "x-sand-label": "代码",
            "x-sand-widget": "markdown",
          },
        },
      },
      display: {
        material: "screen",
        defaultSize: { width: 340, height: 220 },
        summary: ["language", "text"],
      },
    },
    {
      type: "base.metric",
      title: "指标",
      description: "手填数值，或统计源表的可见行。",
      icon: "metric",
      version: 2,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          column: {
            ...tableKey,
            "x-sand-label": "统计列",
            "x-sand-hidden": true,
          },
          aggregate: {
            type: "string",
            enum: ["count", "sum", "avg", "min", "max"],
            "x-sand-label": "统计方式",
            "x-sand-widget": "enum",
            "x-sand-default": "count",
          },
          unit: {
            type: "string",
            maxLength: 200,
            "x-sand-label": "单位",
            "x-sand-widget": "text",
          },
          legacy: {
            type: "object",
            additionalProperties: false,
            "x-sand-label": "手填指标",
            "x-sand-widget": "table",
            "x-sand-hidden": true,
            properties: {
              value: {
                type: "string",
                maxLength: 200,
                "x-sand-label": "数值",
                "x-sand-widget": "text",
              },
              description: {
                type: "string",
                maxLength: 200,
                "x-sand-label": "说明",
                "x-sand-widget": "text",
              },
            },
          },
        },
      },
      migrations: [{ from: 1, migrate: migrateMetric }],
      relationSlots: [
        {
          key: "source",
          label: "源表格",
          kind: "base.data_source",
          direction: "out",
          many: false,
          targetTypes: ["base.table"],
        },
      ],
      display: {
        material: "gauge",
        defaultSize: { width: 260, height: 170 },
        summary: ["aggregate", "unit"],
        view: "metric",
      },
    },
    {
      type: "base.status",
      title: "状态",
      description: "某个服务或环节现在好不好。",
      icon: "status",
      version: 1,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          state: {
            type: "string",
            enum: ["operational", "degraded", "down", "unknown"],
            "x-sand-label": "状态",
            "x-sand-widget": "enum",
            "x-sand-default": "unknown",
            "x-sand-enum-labels": {
              operational: "可用",
              degraded: "降级",
              down: "不可用",
              unknown: "未知",
            },
          },
          description: {
            type: "string",
            maxLength: 200,
            "x-sand-label": "说明",
            "x-sand-widget": "text",
          },
          sourceUrl: {
            type: "string",
            maxLength: 2000,
            pattern: HTTP_URL,
            "x-sand-label": "状态来源",
            "x-sand-widget": "url",
          },
          observedAt: {
            type: "integer",
            minimum: 0,
            "x-sand-label": "观测时间",
            "x-sand-widget": "integer",
          },
        },
      },
      display: {
        material: "gauge",
        defaultSize: { width: 240, height: 150 },
        summary: ["state", "description"],
      },
    },
    {
      type: "base.table",
      title: "表格",
      description: "按列类型保存、编辑和引用数据。",
      icon: "table",
      version: 2,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          view: tableView,
          columns: {
            type: "array",
            maxItems: 200,
            "x-sand-label": "列定义",
            "x-sand-widget": "list",
            "x-sand-hidden": true,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["key", "label", "type"],
              properties: {
                key: tableKey,
                label: {
                  type: "string",
                  maxLength: 200,
                  "x-sand-label": "名称",
                  "x-sand-widget": "text",
                },
                type: {
                  type: "string",
                  enum: ["text", "number", "date", "boolean"],
                  "x-sand-label": "类型",
                  "x-sand-widget": "enum",
                },
                unit: {
                  type: "string",
                  maxLength: 200,
                  "x-sand-label": "单位",
                  "x-sand-widget": "text",
                },
              },
            },
          },
          rows: {
            type: "array",
            maxItems: 200,
            "x-sand-label": "行数据",
            "x-sand-widget": "list",
            "x-sand-hidden": true,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["key", "cells"],
              properties: {
                key: tableKey,
                cells: {
                  type: "object",
                  propertyNames: tableKey,
                  additionalProperties: cell,
                  "x-sand-label": "单元格",
                  "x-sand-widget": "table",
                },
              },
            },
          },
        },
      },
      migrations: [{ from: 1, migrate: migrateTable }],
      display: {
        material: "document",
        defaultSize: { width: 420, height: 255 },
        summary: [],
        view: "table",
      },
    },
    {
      type: "base.filter",
      title: "筛选器",
      description: "筛选显式连接的表格及其同源数据视图。",
      icon: "search",
      version: 1,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: {
            type: "string",
            enum: ["select", "range", "text"],
            "x-sand-default": "select",
            "x-sand-label": "控件类型",
            "x-sand-widget": "enum",
            "x-sand-enum-labels": {
              select: "下拉",
              range: "范围",
              text: "文本",
            },
          },
          ...Object.fromEntries(
            Object.entries(filterFields).map(([key, field]) => [
              key,
              {
                ...field,
                "x-sand-hidden": true,
              },
            ]),
          ),
        },
      },
      relationSlots: [
        {
          key: "targets",
          label: "作用表格",
          kind: "base.filters",
          direction: "out",
          many: true,
          targetTypes: ["base.table"],
        },
      ],
      display: {
        material: "document",
        defaultSize: { width: 300, height: 240 },
        summary: ["kind"],
        view: "filter",
      },
    },
    {
      type: "base.chart",
      title: "图表",
      description: "用柱状图、折线或散点查看同一份表格数据。",
      icon: "chart",
      version: 2,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: {
            type: "string",
            enum: ["bar", "line", "scatter"],
            "x-sand-default": "bar",
            "x-sand-label": "图表形式",
            "x-sand-widget": "enum",
            "x-sand-enum-labels": {
              bar: "柱状图",
              line: "折线图",
              scatter: "散点图",
            },
          },
          title: {
            type: "string",
            maxLength: 200,
            "x-sand-label": "图表标题",
            "x-sand-widget": "text",
          },
          mapping: {
            type: "object",
            additionalProperties: false,
            required: ["x", "y"],
            "x-sand-label": "字段映射",
            "x-sand-widget": "table",
            "x-sand-hidden": true,
            properties: {
              x: tableKey,
              y: {
                type: "array",
                maxItems: 20,
                uniqueItems: true,
                items: tableKey,
                "x-sand-label": "数值列",
                "x-sand-widget": "tags",
              },
            },
          },
          aggregation: {
            type: "string",
            enum: ["none", "sum", "mean", "count", "min", "max"],
            "x-sand-label": "聚合",
            "x-sand-widget": "enum",
            "x-sand-hidden": true,
          },
          rowScope: {
            type: "array",
            items: tableKey,
            maxItems: 200,
            uniqueItems: true,
            "x-sand-label": "所选行",
            "x-sand-widget": "tags",
            "x-sand-hidden": true,
          },
          showLegend: {
            type: "boolean",
            "x-sand-label": "显示图例",
            "x-sand-widget": "boolean",
            "x-sand-hidden": true,
          },
          legacyPoints: oldChartPoints,
        },
      },
      migrations: [{ from: 1, migrate: migrateChart }],
      relationSlots: [
        {
          key: "filteredByCharts",
          label: "图表筛选来源",
          kind: "base.filters",
          direction: "in",
          targetTypes: ["base.chart"],
          many: true,
        },
        {
          key: "filtersCharts",
          label: "筛选同源图表",
          kind: "base.filters",
          direction: "out",
          targetTypes: ["base.chart"],
          many: true,
        },
        {
          key: "highlightedBy",
          label: "高亮来源",
          kind: "base.highlights",
          direction: "in",
          targetTypes: ["base.chart"],
          many: true,
        },
        {
          key: "highlights",
          label: "联动高亮",
          kind: "base.highlights",
          direction: "out",
          targetTypes: ["base.chart"],
          many: true,
        },
        {
          key: "source",
          label: "源表格",
          kind: "base.data_source",
          direction: "out",
          targetTypes: ["base.table"],
          many: false,
        },
      ],
      display: {
        material: "gauge",
        defaultSize: { width: 360, height: 240 },
        summary: ["kind", "title"],
        view: "chart",
      },
    },
    {
      type: "base.events",
      title: "事件",
      description: "当前正在发生的事件片段。",
      icon: "events",
      version: 1,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          events: {
            type: "array",
            maxItems: 100,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                at: {
                  type: "string",
                  maxLength: 200,
                  "x-sand-label": "时间",
                  "x-sand-widget": "text",
                },
                label: {
                  type: "string",
                  maxLength: 200,
                  "x-sand-label": "事件",
                  "x-sand-widget": "text",
                },
                detail: {
                  type: "string",
                  maxLength: 2000,
                  "x-sand-label": "详情",
                  "x-sand-widget": "markdown",
                },
              },
            },
            "x-sand-label": "事件",
            "x-sand-widget": "list",
          },
        },
      },
      display: {
        material: "gauge",
        defaultSize: { width: 320, height: 220 },
        summary: ["events"],
      },
    },
    {
      type: "base.task",
      title: "任务",
      description: "一个目标和一份清单。",
      icon: "task",
      version: 1,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          goal: {
            type: "string",
            maxLength: 2000,
            "x-sand-label": "任务目标",
            "x-sand-widget": "markdown",
          },
          items: {
            type: "array",
            maxItems: 100,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["text", "done"],
              properties: {
                text: {
                  type: "string",
                  maxLength: 200,
                  "x-sand-label": "事项",
                  "x-sand-widget": "text",
                },
                done: {
                  type: "boolean",
                  "x-sand-label": "已完成",
                  "x-sand-widget": "boolean",
                },
              },
            },
            "x-sand-label": "清单",
            "x-sand-widget": "list",
          },
        },
      },
      display: {
        material: "paper",
        defaultSize: { width: 280, height: 200 },
        summary: ["goal", "items"],
      },
    },
    {
      type: "base.reasoning",
      title: "推理",
      description: "一个问题、证据、判断和还没弄清的地方。",
      icon: "reasoning",
      version: 1,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          question: {
            type: "string",
            maxLength: 2000,
            "x-sand-label": "问题",
            "x-sand-widget": "markdown",
          },
          evidence: {
            type: "array",
            maxItems: 50,
            items: {
              anyOf: [
                { type: "string", maxLength: 2000 },
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["text"],
                  properties: {
                    text: {
                      type: "string",
                      maxLength: 2000,
                      "x-sand-label": "证据",
                      "x-sand-widget": "markdown",
                    },
                  },
                },
              ],
            },
            "x-sand-label": "证据",
            "x-sand-widget": "list",
          },
          options: {
            type: "array",
            maxItems: 20,
            items: { type: "string", maxLength: 200 },
            "x-sand-label": "备选判断",
            "x-sand-widget": "tags",
          },
          decision: {
            type: "string",
            maxLength: 2000,
            "x-sand-label": "当前判断",
            "x-sand-widget": "markdown",
          },
          unknowns: {
            type: "string",
            maxLength: 2000,
            "x-sand-label": "仍不确定的事",
            "x-sand-widget": "markdown",
          },
        },
      },
      display: {
        material: "paper",
        defaultSize: { width: 320, height: 220 },
        summary: ["question", "decision"],
      },
    },
    {
      type: "base.comparison",
      title: "比较",
      description: "并排对照绑定对象或它们的指定版本。",
      icon: "comparison",
      version: 2,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          legacy: {
            type: "object",
            additionalProperties: false,
            "x-sand-label": "已有内联内容",
            "x-sand-widget": "list",
            properties: {
              left: comparisonSide("方案一"),
              right: comparisonSide("方案二"),
            },
          },
          pinnedVersions: {
            type: "object",
            additionalProperties: false,
            "x-sand-label": "固定版本",
            "x-sand-widget": "list",
            "x-sand-hidden": true,
            properties: {
              left: {
                type: "integer",
                minimum: 1,
                "x-sand-label": "左侧版本",
                "x-sand-widget": "integer",
              },
              right: {
                type: "integer",
                minimum: 1,
                "x-sand-label": "右侧版本",
                "x-sand-widget": "integer",
              },
            },
          },
          conclusion: {
            type: "string",
            maxLength: 2000,
            "x-sand-label": "比较结论",
            "x-sand-widget": "markdown",
          },
        },
      },
      display: {
        material: "paper",
        defaultSize: { width: 620, height: 365 },
        summary: ["legacy", "conclusion"],
        view: "comparison",
      },
      relationSlots: [
        {
          key: "left",
          label: "左侧",
          kind: "base.compare_left",
          direction: "out",
          many: false,
        },
        {
          key: "right",
          label: "右侧",
          kind: "base.compare_right",
          direction: "out",
          many: false,
        },
      ],
      migrations: [{ from: 1, migrate: migrateComparison }],
    },
    {
      type: "base.tour",
      title: "导览",
      description: "一条讲解路线：每一站是一个站点对象。",
      icon: "pin",
      version: 1,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          purpose: {
            type: "string",
            maxLength: 2000,
            "x-sand-label": "导览目的",
            "x-sand-widget": "markdown",
          },
          legacySteps: {
            type: "array",
            maxItems: 100,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["title"],
              properties: {
                title: {
                  type: "string",
                  maxLength: 200,
                  "x-sand-label": "站点",
                  "x-sand-widget": "text",
                },
                explanation: {
                  type: "string",
                  maxLength: 2000,
                  "x-sand-label": "讲解",
                  "x-sand-widget": "markdown",
                },
                uncertainty: {
                  type: "string",
                  maxLength: 2000,
                  "x-sand-label": "尚未确定",
                  "x-sand-widget": "markdown",
                },
              },
            },
            "x-sand-label": "旧版站点",
            "x-sand-widget": "list",
            "x-sand-hidden": true,
          },
        },
      },
      display: {
        material: "document",
        defaultSize: { width: 280, height: 180 },
        summary: ["purpose"],
      },
      relationSlots: [
        {
          key: "stops",
          label: "导览站点",
          kind: "base.tour_stop",
          direction: "out",
          many: true,
        },
      ],
    },
  ],
  relationKinds: [
    {
      kind: "base.filters",
      title: "筛选",
      inverseTitle: "受筛选",
      allowsInferred: false,
      sourceTypes: ["base.filter", "base.chart"],
      targetTypes: ["base.table", "base.chart"],
    },
    {
      kind: "base.highlights",
      title: "高亮联动",
      inverseTitle: "高亮联动",
      allowsInferred: false,
      sourceTypes: ["base.chart"],
      targetTypes: ["base.chart"],
    },
    {
      kind: "base.compare_left",
      title: "左侧比较对象",
      inverseTitle: "作为比较左侧",
      allowsInferred: false,
      sourceTypes: ["base.comparison"],
    },
    {
      kind: "base.compare_right",
      title: "右侧比较对象",
      inverseTitle: "作为比较右侧",
      allowsInferred: false,
      sourceTypes: ["base.comparison"],
    },
    {
      kind: "base.timeline_item",
      title: "时间条目",
      inverseTitle: "所在时间轴",
      allowsInferred: false,
      sourceTypes: ["base.timeline"],
    },
    {
      kind: "base.data_source",
      title: "数据来源",
      inverseTitle: "被数据组件引用",
      allowsInferred: false,
      sourceTypes: ["base.chart", "base.metric"],
      targetTypes: ["base.table"],
    },
    {
      kind: "base.graph_focus",
      title: "图中心",
      inverseTitle: "所在关系图",
      sourceTypes: ["base.relation_graph"],
      allowsInferred: false,
    },
    {
      kind: "base.related",
      title: "相关",
      inverseTitle: "相关",
      allowsInferred: false,
    },
    {
      kind: "base.depends_on",
      title: "依赖",
      inverseTitle: "被依赖",
      allowsInferred: false,
    },
    {
      kind: "base.supports",
      title: "支持",
      inverseTitle: "被支持",
      allowsInferred: false,
      requiresBasis: true,
    },
    {
      kind: "base.compares",
      title: "比较",
      inverseTitle: "被比较",
      allowsInferred: false,
    },
    {
      kind: "base.belongs_to",
      title: "从属于",
      inverseTitle: "包含",
      allowsInferred: false,
    },
    {
      kind: "base.about",
      title: "关于",
      inverseTitle: "被讲解",
      allowsInferred: false,
    },
    {
      kind: "base.comments_on",
      title: "评论对象",
      inverseTitle: "评论",
      sourceTypes: ["base.comment"],
      allowsInferred: false,
    },
    {
      kind: "base.reply_to",
      title: "回复评论",
      inverseTitle: "回复",
      sourceTypes: ["base.comment"],
      targetTypes: ["base.comment"],
      allowsInferred: false,
    },
    {
      kind: "base.tour_stop",
      title: "导览站点",
      inverseTitle: "所属导览",
      allowsInferred: false,
    },
  ],
};
