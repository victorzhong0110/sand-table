export type Cell = string | number | boolean | null;
export type ColumnKind = "text" | "number" | "date" | "boolean";
export type Column = {
  key: string;
  label: string;
  type: ColumnKind;
  unit?: string;
};
export type TableRow = { key: string; cells: Record<string, Cell> };
export type TableData = { columns: Column[]; rows: TableRow[] };

export const columnNames: Record<ColumnKind, string> = {
  text: "文本",
  number: "数字",
  date: "日期",
  boolean: "布尔",
};
export const tableLimit = 200;

export function tableOf(data: Record<string, unknown> = {}): TableData {
  return {
    columns:
      Array.isArray(data.columns) &&
      data.columns.every((column) => typeof column?.key === "string")
        ? (data.columns as Column[])
        : [],
    rows:
      Array.isArray(data.rows) &&
      data.rows.every(
        (row) =>
          typeof row?.key === "string" &&
          row.cells &&
          typeof row.cells === "object",
      )
        ? (data.rows as TableRow[])
        : [],
  };
}

export function cellValue(row: TableRow, key: string): Cell {
  return Object.hasOwn(row.cells, key) ? (row.cells[key] ?? null) : null;
}

export function convertCell(
  value: Cell,
  kind: ColumnKind,
): { value: Cell; valid: boolean } {
  if (value === null || value === "") return { value, valid: true };
  switch (kind) {
    case "text":
      return { value: String(value), valid: true };
    case "number": {
      const number =
        typeof value === "number" || (typeof value === "string" && value.trim())
          ? Number(value)
          : NaN;
      return Number.isFinite(number)
        ? { value: number, valid: true }
        : { value, valid: false };
    }
    case "date": {
      const valid =
        typeof value === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(value) &&
        Number.isFinite(Date.parse(value)) &&
        new Date(value).toISOString().slice(0, 10) === value;
      return { value, valid };
    }
    case "boolean":
      if (typeof value === "boolean") return { value, valid: true };
      if (value === "true" || value === "false")
        return { value: value === "true", valid: true };
      return { value, valid: false };
  }
}

export function editValue(input: string, kind: ColumnKind): Cell {
  return input === "" ? null : convertCell(input, kind).value;
}

export function newColumn(label: string): Column {
  return { key: "c" + crypto.randomUUID(), label, type: "text" };
}
export function newRow(): TableRow {
  return { key: "r" + crypto.randomUUID(), cells: {} };
}

export function reinterpretColumn(
  table: TableData,
  key: string,
  type: ColumnKind,
) {
  let invalid = 0;
  const rows = table.rows.map((row) => {
    const result = convertCell(cellValue(row, key), type);
    if (!result.valid) invalid++;
    return { ...row, cells: { ...row.cells, [key]: result.value } };
  });
  const columns = table.columns.map((column) =>
    column.key === key ? { ...column, type } : column,
  );
  return { data: { columns, rows }, invalid };
}
