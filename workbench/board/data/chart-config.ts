import type { EChartsCoreOption } from "echarts/core";
import { aggregateValues, type Aggregate } from "./derive-table.ts";
import {
  cellValue,
  type Cell,
  type Column,
  type TableData,
  type TableRow,
} from "./table-model.ts";

export type ChartKind = "bar" | "line" | "scatter";
export type ChartMapping = { x: string; y: string[] };
export const chartAggregates = {
  none: "无",
  count: "计数",
  sum: "合计",
  mean: "平均",
  min: "最小",
  max: "最大",
} as const;
type ChartAggregate = keyof typeof chartAggregates;
export type ChartConfig = {
  aggregation?: ChartAggregate;
  rowScope?: string[];
  showLegend?: boolean;
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
    ...(typeof data.aggregation === "string" &&
    Object.hasOwn(chartAggregates, data.aggregation)
      ? { aggregation: data.aggregation as ChartAggregate }
      : {}),
    ...(Array.isArray(data.rowScope) ? { rowScope: data.rowScope } : {}),
    ...(typeof data.showLegend === "boolean"
      ? { showLegend: data.showLegend }
      : {}),
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

function grouped(rows: TableRow[], column: string) {
  const groups = new Map<Cell, TableRow[]>();
  for (const row of rows) {
    const x = cellValue(row, column);
    if (x === null) continue;
    const group = groups.get(x);
    if (group) group.push(row);
    else groups.set(x, [row]);
  }
  return [...groups].map(([x, rows]) => ({ x, rows }));
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
  const aggregate: Aggregate | undefined =
    chart.aggregation === "mean"
      ? "avg"
      : chart.aggregation === "none"
        ? undefined
        : chart.aggregation;
  const scoped = chart.rowScope ? new Set(chart.rowScope) : undefined;
  const rows = scoped
    ? table.rows.filter(({ key }) => scoped.has(key))
    : table.rows;
  const groups = aggregate
    ? grouped(rows, x.key)
    : rows.map((row) => ({ x: cellValue(row, x.key), rows: [row] }));
  const categories =
    x.type === "number" && chart.kind !== "bar"
      ? undefined
      : groups.map((group) => String(group.x ?? ""));
  const series = mapping.y.map((key) => {
    const column = lookup.get(key);
    if (!column) throw Error(`列「${key}」不存在。`);
    if (column.type !== "number")
      throw Error(`列「${column.label}」需要是数字列。`);
    return {
      name: column.unit ? `${column.label}（${column.unit}）` : column.label,
      values: groups.map(({ x, rows }, index) => {
        const numbers = rows
          .map((row) => cellValue(row, key))
          .filter(
            (value): value is number =>
              typeof value === "number" && Number.isFinite(value),
          );
        return {
          id: rows[0].key,
          ...(aggregate ? { rowKeys: rows.map(({ key }) => key) } : {}),
          value: [
            categories
              ? x == null
                ? null
                : index
              : typeof x === "number"
                ? x
                : null,
            aggregate && numbers.length
              ? aggregateValues(numbers, aggregate)
              : (numbers[0] ?? null),
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
  focused: ReadonlySet<string> = new Set(),
): EChartsCoreOption {
  return {
    animation: false,
    color: [color, "#587c6b", "#945b43", "#57769c"],
    textStyle: { color: ink },
    grid: {
      left: 42,
      right: 10,
      bottom: 28,
      top: (chart.showLegend ?? data.series.length > 1) ? 28 : 10,
    },
    tooltip: { trigger: "item", renderMode: "richText", confine: true },
    legend: {
      show: chart.showLegend ?? data.series.length > 1,
      textStyle: { color: ink },
    },
    brush: { brushMode: "single", xAxisIndex: 0 },
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
      data: values.map((point) =>
        pointKeys(point).some((key) => focused.has(key))
          ? {
              ...point,
              itemStyle: { borderColor: ink, borderWidth: 2 },
              symbolSize: 8,
            }
          : point,
      ),
      connectNulls: false,
      showSymbol: true,
      symbolSize: 4,
    })),
  };
}

export function pointKeys(point: { id: string; rowKeys?: string[] }): string[] {
  return point.rowKeys ?? [point.id];
}
