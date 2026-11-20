export function dataPoints(chart, rows) {
  return chart.mapping.y.map((column) => ({
    key: column,
    points: rows.map(({ key, cells }) => ({
      key,
      x: cells[chart.mapping.x] ?? null,
      y:
        typeof cells[column] === "number" && Number.isFinite(cells[column])
          ? cells[column]
          : null,
    })),
  }));
}

export const themes = {
  graphite: {
    ink: "#252525",
    paper: "#ffffff",
    line: "#777777",
    series: ["#222222", "#727272"],
  },
  warm: {
    ink: "#32241c",
    paper: "#fff5e0",
    line: "#85735b",
    series: ["#a4482a", "#556f45"],
  },
};
