import { compile } from "vega-lite";
import { View, parse } from "vega";
import { expressionInterpreter } from "vega-interpreter";
import { dataPoints } from "./config.mjs";

globalThis.chartProbe = async (node, chart, rows, theme) => {
  const points = dataPoints(chart, rows).flatMap(({ key, points }) =>
    points.map((row) => ({ ...row, group: key })),
  );
  const config = {
    axis: {
      labelColor: theme.ink,
      titleColor: theme.ink,
      gridColor: theme.line,
      gridOpacity: 0.25,
    },
    legend: { labelColor: theme.ink },
  };
  const spec = {
    width: 300,
    height: 200,
    padding: 6,
    autosize: { type: "fit", contains: "padding" },
    background: theme.paper,
    data: { values: points },
    params: [
      { name: "brush", select: "interval" },
      {
        name: "groups",
        select: { type: "point", fields: ["group"] },
        bind: "legend",
      },
      { name: "highlightRows", value: [] },
    ],
    mark: {
      type: chart.kind === "scatter" ? "point" : chart.kind,
      tooltip: true,
      ...(chart.kind === "line"
        ? { invalid: "break-paths-filter-domains" }
        : {}),
    },
    encoding: {
      x: {
        field: "x",
        type: chart.kind === "bar" ? "ordinal" : "quantitative",
      },
      y: { field: "y", type: "quantitative" },
      color: {
        field: "group",
        type: "nominal",
        scale: { range: theme.series },
      },
      opacity: {
        condition: [
          { test: "indexof(highlightRows, datum.key) >= 0", value: 1 },
          { param: "groups", value: 0.7 },
        ],
        value: 0.12,
      },
    },
    config,
  };
  const view = new View(parse(compile(spec).spec, null, { ast: true }), {
    renderer: "svg",
    container: node,
    expr: expressionInterpreter,
  });
  await view.runAsync();
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
    interact: async () => {
      const rendered = view.scenegraph().root;
      const visible = [];
      const collect = (item) => {
        if (item.datum?.key === rows[4].key && "opacity" in item)
          visible.push(item);
        item.items?.forEach(collect);
      };
      collect(rendered);
      const before = visible.map((item) => item.opacity);
      await view.signal("highlightRows", [rows[4].key]).runAsync();
      const after = visible.map((item) => item.opacity);
      return {
        hover: !!node.querySelector("[aria-label*=x]"),
        legend: !!node.querySelector(".role-legend"),
        brush: view.signal("brush") !== undefined,
        highlight: before.some((value, i) => value !== after[i]),
      };
    },
    dispose: () => view.finalize(),
  };
};
