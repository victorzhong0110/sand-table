import type { EChartsCoreOption } from "echarts/core";
import { cellValue, type Column, type TableData } from "./table-model.ts";

export type ChartKind = "bar" | "line" | "scatter";
export type ChartMapping = { x: string; y: string[] };
export type ChartConfig = {
  kind: ChartKind;
  mapping?: ChartMapping;
  title?: string;
  legacyPoints?: { label: string; value: number }[];
};
export const chartKinds: Record<ChartKind, string> = {
  bar: "柱状图",
  line: "折线图",
  scatter: "散点图",
};

export function chartOf(data: Record<string, unknown>): ChartConfig {
  return {
    kind: data.kind === "line" || data.kind === "scatter" ? data.kind : "bar",
    ...(typeof data.title === "string" ? { title: data.title } : {}),
    ...(data.mapping ? { mapping: data.mapping as ChartMapping } : {}),
    ...(Array.isArray(data.legacyPoints)
      ? { legacyPoints: data.legacyPoints }
      : {}),
  };
}

export function initialMapping(columns: Column[]): ChartMapping | undefined {
  if (!columns.length) return;
  const measure = columns.find(({ type }) => type === "number");
  return { x: columns[0].key, y: measure ? [measure.key] : [] };
}

export function seriesFor(chart: ChartConfig, table?: TableData) {
  if (!table) {
    const points = chart.legacyPoints ?? [];
    if (!points.length) throw Error("请绑定一张源表格。");
    return {
      categories: points.map(({ label }) => label),
      series: [
        {
          name: "数值",
          values: points.map(({ value }, index) => ({
            id: String(index),
            value: [index, value],
          })),
        },
      ],
    };
  }
  const mapping = chart.mapping ?? initialMapping(table.columns);
  if (!mapping) throw Error("表格还没有列。");
  const lookup = new Map(table.columns.map((column) => [column.key, column]));
  const x = lookup.get(mapping.x);
  if (!x) throw Error(`列「${mapping.x}」不存在。`);
  if (!mapping.y.length) throw Error("请从源表选择数字列。");
  const categories =
    x.type === "number" && chart.kind !== "bar"
      ? undefined
      : table.rows.map((row) => String(cellValue(row, x.key) ?? ""));
  const series = mapping.y.map((key) => {
    const column = lookup.get(key);
    if (!column) throw Error(`列「${key}」不存在。`);
    if (column.type !== "number")
      throw Error(`列「${column.label}」需要是数字列。`);
    return {
      name: column.unit ? `${column.label}（${column.unit}）` : column.label,
      values: table.rows.map((row, index) => {
        const xValue = cellValue(row, x.key);
        const yValue = cellValue(row, key);
        return {
          id: row.key,
          value: [
            categories
              ? xValue == null
                ? null
                : index
              : typeof xValue === "number"
                ? xValue
                : null,
            typeof yValue === "number" ? yValue : null,
          ],
        };
      }),
    };
  });
  return { categories, series };
}

export function chartOptions(
  chart: ChartConfig,
  data: ReturnType<typeof seriesFor>,
  ink: string,
  color: string,
): EChartsCoreOption {
  return {
    animation: false,
    color: [color, "#587c6b", "#945b43", "#57769c"],
    textStyle: { color: ink },
    grid: {
      left: 42,
      right: 10,
      bottom: 28,
      top: data.series.length > 1 ? 28 : 10,
    },
    tooltip: { trigger: "item", renderMode: "richText", confine: true },
    legend: { show: data.series.length > 1, textStyle: { color: ink } },
    xAxis: {
      type: data.categories ? "category" : "value",
      data: data.categories,
      axisLabel: { color: ink, hideOverlap: true },
    },
    yAxis: {
      type: "value",
      axisLabel: { color: ink },
      scale: chart.kind !== "bar",
    },
    series: data.series.map(({ name, values }) => ({
      name,
      type: chart.kind,
      data: values,
      connectNulls: false,
      showSymbol: chart.kind !== "line",
      symbolSize: 4,
    })),
  };
}
