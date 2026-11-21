import {
  editValue,
  newRow,
  tableLimit,
  type TableData,
} from "./table-model.ts";

export function pasteCells(
  table: TableData,
  text: string,
  rowIndex: number,
  columnIndex: number,
): TableData {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .replace(/\n$/, "")
    .split("\n")
    .map((line) => line.split("\t"));
  if (rowIndex + lines.length > tableLimit)
    throw Error("最多支持 200 行，请粘贴较少的数据。");
  if (lines.some((line) => columnIndex + line.length > table.columns.length)) {
    throw Error("粘贴内容超出表格列数。请先增加对应的列。");
  }
  const rows = [...table.rows];
  while (rows.length < rowIndex + lines.length) rows.push(newRow());
  lines.forEach((line, offset) => {
    const row = rows[rowIndex + offset];
    const cells = { ...row.cells };
    line.forEach((raw, index) => {
      const column = table.columns[columnIndex + index];
      cells[column.key] = editValue(raw, column.type);
    });
    rows[rowIndex + offset] = { ...row, cells };
  });
  return { ...table, rows };
}
