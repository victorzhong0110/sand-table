import { useState } from "react";
import {
  resolveFormulaColumn,
  type TableFilter,
  type TableSort,
  type TableViewConfig,
} from "./derive-table.ts";
import { compileFormula } from "./formula.ts";
import {
  convertCell,
  newColumn,
  tableLimit,
  type Column,
} from "./table-model.ts";

const conditions: Record<TableFilter["op"], string> = {
  eq: "等于",
  contains: "包含",
  gt: "大于",
  lt: "小于",
  between: "介于",
  empty: "为空",
  not_empty: "不为空",
};

export function TableAnalysisControls({
  columns,
  config,
  save,
  disabled,
}: {
  columns: Column[];
  config: TableViewConfig;
  save(next: TableViewConfig): Promise<boolean>;
  disabled: boolean;
}) {
  const [filterColumn, setFilterColumn] = useState("");
  const [op, setOp] = useState<TableFilter["op"]>("eq");
  const [filterValue, setFilterValue] = useState("");
  const [filterUpper, setFilterUpper] = useState("");
  const [sortColumn, setSortColumn] = useState("");
  const [direction, setDirection] = useState<TableSort["direction"]>("asc");
  const [name, setName] = useState("");
  const [formula, setFormula] = useState("");
  const [formulaError, setFormulaError] = useState("");
  const [editingCalculation, setEditingCalculation] = useState<string>();
  const filters = config.filters ?? [];
  const sort = config.sort ?? [];
  const selectedFilter =
    columns.find((column) => column.key === filterColumn) ?? columns[0];
  const selectedSort =
    columns.find((column) => column.key === sortColumn) ?? columns[0];
  const columnOptions = columns.map((column) => (
    <option value={column.key} key={column.key}>
      {column.label || column.key}
    </option>
  ));
  const labelOf = (key: string) =>
    columns.find((column) => column.key === key)?.label || key;
  function referenceOf(key: string) {
    const label = labelOf(key);
    if (columns.filter((column) => column.label === label).length !== 1)
      return key;
    return resolveFormulaColumn(columns, label) === key ? label : key;
  }
  function addFilter() {
    if (!selectedFilter) return;
    const read = (value: string) =>
      convertCell(value, selectedFilter.type).value;
    const filter: TableFilter = {
      column: selectedFilter.key,
      op,
      ...(op === "empty" || op === "not_empty"
        ? {}
        : { value: read(filterValue) }),
      ...(op === "between" ? { upper: read(filterUpper) } : {}),
    };
    void save({ ...config, filters: [...filters, filter] });
  }
  function addSort() {
    if (selectedSort)
      void save({
        ...config,
        sort: [
          ...sort.filter(({ column }) => column !== selectedSort.key),
          { column: selectedSort.key, direction },
        ],
      });
  }
  async function addCalculation() {
    const title = name.trim();
    if (!title || !formula.trim()) {
      setFormulaError("请填写计算列名称和公式。");
      return;
    }
    try {
      const normalized = compileFormula(formula, (reference) =>
        resolveFormulaColumn(columns, reference),
      );
      setFormulaError("");
      const calculated = config.calculated ?? [];
      const key = editingCalculation ?? newColumn(title).key;
      const definition = { key, label: title, formula: normalized.source };
      const saved = await save({
        ...config,
        calculated: editingCalculation
          ? calculated.map((item) => (item.key === key ? definition : item))
          : [...calculated, definition],
      });
      if (saved) clearCalculation();
    } catch (error) {
      setFormulaError(
        error instanceof Error ? error.message : "无法读取公式。",
      );
    }
  }
  function clearCalculation() {
    setEditingCalculation(undefined);
    setName("");
    setFormula("");
    setFormulaError("");
  }
  return (
    <details>
      <summary>
        表格分析{filters.length ? `（${filters.length} 个筛选条件）` : ""}
      </summary>
      <fieldset disabled={disabled}>
        <legend>筛选</legend>
        <select
          aria-label="筛选列"
          value={selectedFilter?.key ?? ""}
          onChange={(event) => setFilterColumn(event.target.value)}
        >
          {columnOptions}
        </select>
        <select
          aria-label="筛选条件"
          value={op}
          onChange={(event) => setOp(event.target.value as TableFilter["op"])}
        >
          {Object.entries(conditions).map(([value, label]) => (
            <option value={value} key={value}>
              {label}
            </option>
          ))}
        </select>
        {op !== "empty" && op !== "not_empty" && (
          <input
            aria-label="筛选值"
            value={filterValue}
            onChange={(event) => setFilterValue(event.target.value)}
          />
        )}
        {op === "between" && (
          <input
            aria-label="筛选上限"
            value={filterUpper}
            onChange={(event) => setFilterUpper(event.target.value)}
          />
        )}
        <button
          type="button"
          disabled={!columns.length || filters.length >= tableLimit}
          onClick={addFilter}
        >
          添加筛选条件
        </button>
        {filters.map((filter, index) => (
          <div key={index}>
            {labelOf(filter.column)} {conditions[filter.op]}{" "}
            {String(filter.value ?? "")}
            {filter.op === "between" && ` 至 ${String(filter.upper ?? "")}`}
            <button
              type="button"
              aria-label={`移除第 ${index + 1} 个筛选条件`}
              onClick={() =>
                void save({
                  ...config,
                  filters: filters.filter((_, i) => i !== index),
                })
              }
            >
              移除
            </button>
          </div>
        ))}
        {!!filters.length && (
          <button
            type="button"
            onClick={() => void save({ ...config, filters: [] })}
          >
            清除筛选
          </button>
        )}
      </fieldset>
      <fieldset disabled={disabled}>
        <legend>排序和分组</legend>
        <select
          aria-label="排序列"
          value={selectedSort?.key ?? ""}
          onChange={(event) => setSortColumn(event.target.value)}
        >
          {columnOptions}
        </select>
        <select
          aria-label="排序方向"
          value={direction}
          onChange={(event) =>
            setDirection(event.target.value as TableSort["direction"])
          }
        >
          <option value="asc">升序</option>
          <option value="desc">降序</option>
        </select>
        <button type="button" disabled={!columns.length} onClick={addSort}>
          添加排序
        </button>
        {sort.map(({ column, direction }, index) => (
          <div key={column}>
            {index + 1}. {labelOf(column)}{" "}
            {direction === "asc" ? "升序" : "降序"}
            <button
              type="button"
              onClick={() =>
                void save({
                  ...config,
                  sort: sort.filter((entry) => entry.column !== column),
                })
              }
            >
              移除排序
            </button>
          </div>
        ))}
        <label>
          分组列
          <select
            value={config.groupBy ?? ""}
            onChange={(event) => {
              const { groupBy: _, ...rest } = config;
              const groupBy = event.target.value;
              void save(groupBy ? { ...rest, groupBy } : rest);
            }}
          >
            <option value="">不分组</option>
            {columnOptions}
          </select>
        </label>
      </fieldset>
      <fieldset disabled={disabled}>
        <legend>计算列</legend>
        <input
          required
          aria-label="计算列名称"
          maxLength={200}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <input
          required
          aria-label="计算列公式"
          placeholder="[单价]*[数量]"
          maxLength={20000}
          value={formula}
          onChange={(event) => setFormula(event.target.value)}
        />
        <select
          aria-label="插入公式列"
          value=""
          onChange={(event) => {
            const reference = referenceOf(event.target.value);
            setFormula(
              (value) => value + "[" + reference.replaceAll("]", "]]") + "]",
            );
          }}
        >
          <option value="">插入公式列</option>
          {columns.map(({ key, label }) => (
            <option key={key} value={key}>
              {label && referenceOf(key) !== label
                ? `${label}（${key}）`
                : labelOf(key)}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={!editingCalculation && columns.length >= tableLimit}
          onClick={() => void addCalculation()}
        >
          {editingCalculation ? "保存计算列" : "添加计算列"}
        </button>
        {editingCalculation && (
          <button type="button" onClick={clearCalculation}>
            取消编辑计算列
          </button>
        )}
        {formulaError && <p role="status">{formulaError}</p>}
        {!!config.calculated?.length &&
          config.calculated.map((column) => (
            <div key={column.key}>
              {column.label}
              <button
                type="button"
                aria-label={`编辑计算列「${column.label}」`}
                onClick={() => {
                  setEditingCalculation(column.key);
                  setName(column.label);
                  setFormulaError("");
                  try {
                    setFormula(
                      compileFormula(column.formula, referenceOf).source,
                    );
                  } catch {
                    setFormula(column.formula);
                  }
                }}
              >
                编辑
              </button>
              <button
                type="button"
                aria-label={`删除计算列「${column.label}」`}
                onClick={() =>
                  void save({
                    ...config,
                    calculated: config.calculated?.filter(
                      ({ key }) => key !== column.key,
                    ),
                  })
                }
              >
                删除计算列
              </button>
            </div>
          ))}
      </fieldset>
    </details>
  );
}
