import {
  cellValue,
  convertCell,
  newColumn,
  newRow,
  tableLimit,
  type Cell,
  type ColumnKind,
  type TableData,
} from "./table-model.ts";

type Delimiter = "," | "\t";
export const csvMaxBytes = 1_000_000;

function delimiterOf(text: string): Delimiter {
  let quoted = false;
  let commas = 0;
  let tabs = 0;
  for (const char of text) {
    if (char === '"') quoted = !quoted;
    if (quoted) continue;
    if (char === "\r" || char === "\n") break;
    if (char === ",") commas++;
    if (char === "\t") tabs++;
  }
  return tabs > commas ? "\t" : ",";
}

function readRecords(text: string, separator: Delimiter): (string | null)[][] {
  const records: (string | null)[][] = [];
  let record: (string | null)[] = [];
  let field = "";
  let state: "plain" | "quoted" | "closed" = "plain";
  function finishField() {
    if (record.length >= tableLimit)
      throw Error(`每张表最多包含 ${tableLimit} 列。`);
    record.push(field || (state === "closed" ? "" : null));
    field = "";
    state = "plain";
  }
  function finishRecord() {
    if (records.length > tableLimit)
      throw Error(`每张表最多包含 ${tableLimit} 行数据。`);
    finishField();
    records.push(record);
    record = [];
  }
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (state === "quoted") {
      if (char !== '"') field += char;
      else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else state = "closed";
      continue;
    }
    if (char === separator) {
      finishField();
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      finishRecord();
    } else if (char === '"' && state === "plain" && !field) {
      state = "quoted";
    } else if (state === "closed" || char === '"') {
      throw Error(`第 ${records.length + 1} 条记录的引号位置不正确。`);
    } else {
      field += char;
    }
  }
  if (state === "quoted")
    throw Error(`第 ${records.length + 1} 条记录的引号未闭合。`);
  if (record.length || field || state === "closed") finishRecord();
  return records;
}

function infer(values: (string | null)[]): ColumnKind {
  const present = values.filter(
    (value): value is string => value !== null && value !== "",
  );
  if (!present.length) return "text";
  if (present.every((value) => value === "true" || value === "false"))
    return "boolean";
  if (
    present.every(
      (value) =>
        String(Number(value)) === value && Number.isFinite(Number(value)),
    )
  )
    return "number";
  if (present.every((value) => convertCell(value, "date").valid)) return "date";
  return "text";
}

export function parseCsv(source: string): TableData {
  if (new TextEncoder().encode(source).byteLength > csvMaxBytes)
    throw Error("CSV 文件最多 1 MB，请拆分后导入。");
  const text = source.replace(/^\uFEFF/, "");
  const [head, ...body] = readRecords(text, delimiterOf(text));
  if (!head || head.every((label) => !label))
    throw Error("CSV 第一行需要至少一个列名。");
  const columns = head.map((label, index) => {
    const name = label || `列 ${index + 1}`;
    if ([...name].length > 200)
      throw Error(`第 ${index + 1} 列的列名最多 200 字。`);
    return {
      ...newColumn(name),
      type: infer(body.map((row) => row[index] ?? null)),
    };
  });
  const rows = body.map((values, index) => {
    if (values.length > columns.length)
      throw Error(`第 ${index + 2} 条记录的列数超过表头。`);
    return {
      ...newRow(),
      cells: Object.fromEntries(
        columns.map((column, i) => [
          column.key,
          convertCell(values[i] ?? null, column.type).value,
        ]),
      ),
    };
  });
  const table = { columns, rows };
  if (new TextEncoder().encode(JSON.stringify(table)).byteLength > csvMaxBytes)
    throw Error("导入后表格超过 1 MB，请拆分文件。");
  return table;
}

function encode(value: Cell): string {
  if (value === null) return "";
  const text = String(value);
  return text === "" || /[,"\n\r\t]/.test(text)
    ? '"' + text.replaceAll('"', '""') + '"'
    : text;
}

export function formatCsv(table: TableData): string {
  if (!table.columns.length) return "";
  const titles = table.columns.map((column) => encode(column.label)).join(",");
  const rows = table.rows.map((row) =>
    table.columns.map((column) => encode(cellValue(row, column.key))).join(","),
  );
  return [titles, ...rows].join("\r\n") + "\r\n";
}
