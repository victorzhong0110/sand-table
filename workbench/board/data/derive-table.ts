import {
  compileFormula,
  FormulaError,
  type CompiledFormula,
} from "./formula.ts";
import {
  cellValue,
  convertCell,
  type Cell,
  type Column,
  type TableData,
  type TableRow,
} from "./table-model.ts";

export type TableFilter = {
  column: string;
  op: "eq" | "contains" | "gt" | "lt" | "between" | "empty" | "not_empty";
  value?: Cell;
  upper?: Cell;
};
export type TableSort = { column: string; direction: "asc" | "desc" };
export type CalculatedColumn = {
  key: string;
  label: string;
  formula: string;
};
export type TableViewConfig = {
  calculated?: CalculatedColumn[];
  filters?: TableFilter[];
  sort?: TableSort[];
  groupBy?: string;
};
export type Aggregate = "count" | "sum" | "avg" | "min" | "max";

export function tableViewOf(data: Record<string, unknown>): TableViewConfig {
  if (!data.view || typeof data.view !== "object" || Array.isArray(data.view))
    return {};
  return data.view as TableViewConfig;
}

export function aggregateValues(
  values: Cell[],
  aggregate: Aggregate,
): number | null {
  if (aggregate === "count")
    return values.reduce<number>(
      (count, value) => count + Number(value !== null),
      0,
    );
  const numbers = values.filter(
    (value): value is number =>
      typeof value === "number" && Number.isFinite(value),
  );
  if (!numbers.length) return null;
  if (aggregate === "max") return Math.max(...numbers);
  if (aggregate === "min") return Math.min(...numbers);
  const sum = numbers.reduce((total, number) => total + number, 0);
  const result = aggregate === "avg" ? sum / numbers.length : sum;
  return Number.isFinite(result) ? result : null;
}

export function resolveFormulaColumn(
  columns: readonly Column[],
  reference: string,
) {
  const key = columns.find((column) => column.key === reference)?.key;
  if (key) return key;
  const matching = columns.filter((column) => column.label === reference);
  if (matching.length === 1) return matching[0].key;
  if (matching.length > 1)
    throw new FormulaError(`列名「${reference}」有重名，请选用对应的列标识。`);
  throw new FormulaError(`列「${reference}」不存在。`);
}

function issue(error: unknown) {
  return error instanceof Error ? error.message : "无法处理该表格配置。";
}

function calculatedFormulas(table: TableData, calculated: CalculatedColumn[]) {
  const sourceKeys = new Set(table.columns.map(({ key }) => key));
  const formulas = new Map<string, CompiledFormula>();
  const invalid = new Map<string, string>();
  for (const column of calculated) {
    if (sourceKeys.has(column.key) || formulas.has(column.key)) {
      invalid.set(column.key, "计算列标识已被使用。");
      continue;
    }
    try {
      formulas.set(column.key, compileFormula(column.formula));
    } catch (error) {
      invalid.set(column.key, issue(error));
    }
  }
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const order: string[] = [];
  function visit(key: string) {
    if (visiting.has(key)) {
      for (const affected of visiting)
        invalid.set(affected, "计算列之间存在循环引用。");
      return;
    }
    if (visited.has(key)) return;
    const formula = formulas.get(key);
    if (!formula) return;
    visiting.add(key);
    for (const dependency of formula.dependencies) visit(dependency);
    visiting.delete(key);
    visited.add(key);
    order.push(key);
  }
  for (const key of formulas.keys()) visit(key);
  for (const column of calculated)
    if (!visited.has(column.key)) order.push(column.key);
  return { formulas, invalid, order, sourceKeys };
}

function compare(a: Exclude<Cell, null>, b: Exclude<Cell, null>): number {
  if (a === b) return 0;
  if (typeof a !== typeof b) return String(typeof a).localeCompare(typeof b);
  return a < b ? -1 : 1;
}

function fitsColumn(column: Column, value: Cell): value is Exclude<Cell, null> {
  if (value === null) return false;
  if (column.type === "date")
    return (
      typeof value === "string" &&
      value !== "" &&
      convertCell(value, "date").valid
    );
  return typeof value === (column.type === "text" ? "string" : column.type);
}

function filterPredicate(
  column: Column,
  filter: TableFilter,
): (row: TableRow) => boolean {
  const get = (row: TableRow) => cellValue(row, column.key);
  const { op, value = null, upper = null } = filter;
  if (op === "empty") return (row) => get(row) === null;
  if (op === "not_empty") return (row) => get(row) !== null;
  if (op === "contains") {
    if (column.type !== "text" || typeof value !== "string")
      throw Error(`「${column.label}」需要文本筛选条件。`);
    return (row) => {
      const item = get(row);
      return typeof item === "string" && item.includes(value);
    };
  }
  if (!fitsColumn(column, value))
    throw Error(`「${column.label}」的筛选值类型不符。`);
  if (op !== "eq" && column.type !== "number" && column.type !== "date")
    throw Error(`「${column.label}」只能按数字或日期比较范围。`);
  if (
    op === "between" &&
    (!fitsColumn(column, upper) || compare(value, upper) > 0)
  )
    throw Error(`「${column.label}」的筛选范围无效。`);
  return (row) => {
    const item = get(row);
    if (!fitsColumn(column, item)) return false;
    if (op === "eq") return item === value;
    if (op === "gt") return compare(item, value) > 0;
    if (op === "lt") return compare(item, value) < 0;
    return (
      compare(item, value) >= 0 && upper !== null && compare(item, upper) <= 0
    );
  };
}

export function deriveTable(
  table: TableData,
  config: TableViewConfig = {},
  connected: readonly TableFilter[] = [],
) {
  const calculated = config.calculated ?? [];
  const { formulas, invalid, order, sourceKeys } = calculatedFormulas(
    table,
    calculated,
  );
  const errors = new Map<string, Map<string, string>>();
  const configurationErrors = [...invalid.values()];
  const columns: Column[] = [
    ...table.columns,
    ...calculated
      .filter(
        ({ key }, index) =>
          !sourceKeys.has(key) &&
          calculated.findIndex((column) => column.key === key) === index,
      )
      .map(({ key, label }) => ({ key, label, type: "number" as const })),
  ];
  const byKey = new Map(columns.map((column) => [column.key, column]));
  const rows = table.rows.map((source) => {
    const cells: Record<string, Cell> = Object.assign(
      Object.create(null),
      source.cells,
    );
    const rowErrors = new Map<string, string>();
    const row = { key: source.key, cells };
    for (const key of order) {
      if (sourceKeys.has(key)) continue;
      try {
        const message = invalid.get(key);
        if (message) throw new FormulaError(message);
        cells[key] = formulas.get(key)!.run((dependency) => {
          if (!byKey.has(dependency))
            throw new FormulaError(`引用的列「${dependency}」不存在。`);
          if (rowErrors.has(dependency))
            throw new FormulaError(rowErrors.get(dependency)!);
          return cellValue(row, dependency);
        });
      } catch (error) {
        cells[key] = null;
        rowErrors.set(key, issue(error));
      }
    }
    if (rowErrors.size) errors.set(source.key, rowErrors);
    return row;
  });
  const predicates = [...connected, ...(config.filters ?? [])].flatMap(
    (filter) => {
      const column = byKey.get(filter.column);
      if (!column) {
        configurationErrors.push(`筛选列「${filter.column}」不存在。`);
        return [];
      }
      try {
        return [filterPredicate(column, filter)];
      } catch (error) {
        configurationErrors.push(issue(error));
        return [];
      }
    },
  );
  const visible = rows.filter((row) => predicates.every((keep) => keep(row)));
  const sorting = (config.sort ?? []).filter(({ column }) => {
    if (byKey.has(column)) return true;
    configurationErrors.push(`排序列「${column}」不存在。`);
    return false;
  });
  if (sorting.length)
    visible.sort((left, right) => {
      for (const { column, direction } of sorting) {
        const a = cellValue(left, column);
        const b = cellValue(right, column);
        if (a === b) continue;
        if (a === null || b === null) return a === null ? 1 : -1;
        return compare(a, b) * (direction === "desc" ? -1 : 1);
      }
      return 0;
    });
  const groups = new Map<Cell, TableRow[]>();
  if (config.groupBy) {
    const groupBy = config.groupBy;
    if (!byKey.has(groupBy))
      configurationErrors.push(`分组列「${groupBy}」不存在。`);
    else
      for (const row of visible) {
        const value = cellValue(row, groupBy);
        const group = groups.get(value);
        if (group) group.push(row);
        else groups.set(value, [row]);
      }
  }
  return {
    columns,
    rows: visible,
    computedRows: rows,
    errors,
    configurationErrors: [...new Set(configurationErrors)],
    groups: [...groups].map(([value, rows]) => ({
      value,
      rows,
      count: rows.length,
      totals: Object.fromEntries(
        columns
          .filter(({ type }) => type === "number")
          .map(({ key }) => [
            key,
            aggregateValues(
              rows.map((row) => cellValue(row, key)),
              "sum",
            ),
          ]),
      ),
    })),
  };
}
