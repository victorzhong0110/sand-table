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
