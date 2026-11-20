import { init, use } from "echarts/core";
import { BarChart, LineChart, ScatterChart } from "echarts/charts";
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  BrushComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { dataPoints } from "./config.mjs";
use([
  BarChart,
  LineChart,
  ScatterChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  BrushComponent,
  CanvasRenderer,
]);

export function toECharts(chart, rows, theme, highlighted = new Set()) {
  const groups = dataPoints(chart, rows);
  const categorical =
    chart.kind === "bar" ||
    groups.some(({ points }) =>
      points.some(({ x }) => x !== null && typeof x !== "number"),
    );
  const names = chart.mapping.y;
  return {
    animation: false,
    color: theme.series,
    backgroundColor: theme.paper,
    textStyle: { color: theme.ink },
    grid: { left: 52, right: 12, bottom: 32, top: 36 },
    tooltip: { trigger: "item", renderMode: "richText", confine: true },
    legend: { data: names, textStyle: { color: theme.ink } },
    brush: {
      toolbox: ["rect"],
      brushMode: "single",
      xAxisIndex: 0,
      yAxisIndex: 0,
    },
    xAxis: {
      type: categorical ? "category" : "value",
      ...(categorical
        ? {
            data: groups[0].points.map(({ x }) => (x == null ? "" : String(x))),
          }
        : {}),
      axisLabel: { color: theme.ink, hideOverlap: true },
    },
    yAxis: {
      type: "value",
      scale: chart.kind !== "bar",
      axisLabel: { color: theme.ink },
      splitLine: { lineStyle: { color: theme.line, opacity: 0.25 } },
    },
    series: groups.map(({ key, points }) => ({
      name: key,
      type: chart.kind,
      connectNulls: false,
      showSymbol: chart.kind !== "line",
      symbolSize: 4,
      data: points.map((row, index) => ({
        id: row.key,
        value: [categorical ? index : row.x, row.y],
        ...(highlighted.has(row.key)
          ? { itemStyle: { borderColor: theme.ink, borderWidth: 2 } }
          : {}),
      })),
    })),
  };
}

globalThis.chartProbe = (node, chart, rows, theme) => {
  const instance = init(node, null, { renderer: "canvas" });
  const option = toECharts(chart, rows, theme);
  let hovered = false;
  let legend = false;
  let brushed = 0;
  instance.on("showTip", () => {
    hovered = true;
  });
  instance.on("legendselectchanged", ({ selected }) => {
    legend = selected.B === false;
  });
  instance.on("brushSelected", ({ batch }) => {
    brushed = batch[0]?.selected[0]?.dataIndex.length ?? 0;
  });
  instance.setOption(option);
  return {
    inspect: () => {
      const renderer = instance.getZr();
      const drawables = renderer.storage.getDisplayList();
      const lineBreaks = drawables
        .filter((item) => item.type === "ec-polyline")
        .flatMap((line) =>
          [...line.shape.points].filter(
            (n, index) => index % 2 === 1 && Number.isNaN(n),
          ),
        ).length;
      return {
        surface: node.querySelectorAll("canvas").length,
        missing: option.series[0].data[0].value[1] === null,
        lineBreaks,
      };
    },
    interact: async () => {
      const dispatch = (action) => instance.dispatchAction(action);
      dispatch({ type: "showTip", seriesIndex: 0, dataIndex: 4 });
      dispatch({ type: "legendToggleSelect", name: "B" });
      dispatch({
        type: "brush",
        areas: [
          {
            brushType: "rect",
            xAxisIndex: 0,
            yAxisIndex: 0,
            coordRange: [
              [2, 8],
              [0, 100],
            ],
          },
        ],
      });
      // Explicit row IDs map to transient data indices without persisting engine state.
      const key = rows[4].key;
      const index = option.series[0].data.findIndex(
        (value) => value.id === key,
      );
      instance.setOption({
        series: toECharts(chart, rows, theme, new Set([key])).series,
      });
      await new Promise(requestAnimationFrame);
      const model = instance.getModel().getSeriesByIndex(0);
      const graphic = model.getData().getItemGraphicEl(index);
      return {
        hovered,
        legend,
        brushed,
        highlight: graphic?.childAt(0)?.style?.stroke === theme.ink,
      };
    },
    dispose: () => instance.dispose(),
  };
};
