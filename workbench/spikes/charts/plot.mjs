import { barY, dot, lineY, plot, tip, pointer } from "@observablehq/plot";
import { dataPoints } from "./config.mjs";

globalThis.chartProbe = (node, chart, rows, theme) => {
  const points = dataPoints(chart, rows).flatMap(({ key, points }) =>
    points.map((row) => ({ ...row, group: key })),
  );
  const encoding = { x: "x", y: "y" };
  const mark =
    chart.kind === "bar"
      ? barY(
          points.filter(({ y }) => y !== null),
          { ...encoding, fill: "group", inset: 0.5 },
        )
      : chart.kind === "line"
        ? lineY(points, { ...encoding, z: "group", stroke: "group" })
        : dot(
            points.filter(({ y }) => y !== null),
            { ...encoding, fill: "group", r: 2 },
          );
  const output = plot({
    width: 300,
    height: 200,
    marginLeft: 42,
    style: { color: theme.ink, background: theme.paper },
    color: { domain: chart.mapping.y, range: theme.series, legend: true },
    marks: [
      mark,
      tip(
        points.filter(({ y }) => y !== null),
        pointer(encoding),
      ),
    ],
  });
  node.append(output);
  return {
    inspect: () => ({
      surface: node.querySelectorAll("svg").length,
      missing: points[0].y === null,
      lineBreaks:
        chart.kind === "line" &&
        [...node.querySelectorAll("path[d]")].some(
          (p) => (p.getAttribute("d").match(/M/g) ?? []).length > 2,
        ),
    }),
    interact: () => ({
      legend: "静态",
      brush: "需要外部实现",
      highlight: "需按行键增加标记或重绘",
    }),
    dispose: () => output.remove(),
  };
};
