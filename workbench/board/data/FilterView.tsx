import { useMemo } from "react";
import type { ViewProps } from "../views/registry.tsx";
import { deriveTable, tableViewOf } from "./derive-table.ts";
import { cellValue, tableOf } from "./table-model.ts";
import { useBoundTables } from "./use-table-source.ts";
import { useViewSave } from "./use-view-save.ts";

export function FilterView(props: ViewProps) {
  const { data } = props.object;
  const { items, reading, error } = useBoundTables(props.bindings, "targets");
  const edit = useViewSave(props);
  const targets = useMemo(
    () => items.filter((item) => !item.unavailable && !item.migrationError),
    [items],
  );
  const tables = useMemo(
    () =>
      targets.map((item) =>
        deriveTable(tableOf(item.data), {
          calculated: tableViewOf(item.data).calculated,
        }),
      ),
    [targets],
  );
  const kind =
    data.kind === "range" || data.kind === "text" ? data.kind : "select";
  const columns = (tables[0]?.columns ?? []).filter(
    ({ key, type }) =>
      (kind !== "range" || type === "number") &&
      (kind !== "text" || type === "text") &&
      tables.every((table) =>
        table.columns.some((col) => col.key === key && col.type === type),
      ),
  );
  const column = columns.find(({ key }) => key === data.column);
  const values = column
    ? [
        ...new Set(
          tables.flatMap((table) =>
            table.rows.map((row) => cellValue(row, column.key)),
          ),
        ),
      ].filter((value) => value !== null)
    : [];
  const numbers = values.filter(
    (value): value is number =>
      typeof value === "number" && Number.isFinite(value),
  );
  const min = numbers.length ? Math.min(...numbers) : 0;
  const max = numbers.length ? Math.max(...numbers) : 0;
  const clear = ["op", "value", "upper"];
  const affected = new Map(
    targets.flatMap(({ id, title, tableConsumers }) => [
      [id, title] as const,
      ...(tableConsumers ?? []).map((item) => [item.id, item.title] as const),
    ]),
  );
  return (
    <section className="nodrag nowheel nopan" aria-label="筛选器">
      {reading ? (
        <p>正在读取目标表格…</p>
      ) : (
        <p>
          {affected.size
            ? `作用于 ${[...affected.values()].join("、")}`
            : "请在编辑面板连接要筛选的表格。"}
        </p>
      )}
      {targets.length > 0 && !columns.length && (
        <p role="status">目标表格需要同类型且同列标识的筛选列。</p>
      )}
      {targets.length < items.length && (
        <p role="status">部分目标表格无法读取。</p>
      )}
      <label>
        筛选列
        <select
          aria-label="筛选器的列"
          disabled={edit.disabled || !columns.length}
          value={column?.key ?? ""}
          onChange={(event) => {
            const key = event.target.value;
            void edit.save(
              key ? { column: key } : {},
              key ? clear : [...clear, "column"],
            );
          }}
        >
          <option value="">选择一列</option>
          {columns.map(({ key, label }) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {column && kind === "select" && (
        <select
          aria-label="筛选器的值"
          disabled={edit.disabled}
          value={data.value === undefined ? "" : JSON.stringify(data.value)}
          onChange={(event) => {
            const value = event.target.value;
            if (value)
              void edit.save({ op: "eq", value: JSON.parse(value) }, ["upper"]);
            else void edit.save({}, clear);
          }}
        >
          <option value="">全部</option>
          {values.slice(0, 200).map((value) => (
            <option key={JSON.stringify(value)} value={JSON.stringify(value)}>
              {value === "" ? "空字符串" : String(value)}
            </option>
          ))}
        </select>
      )}
      {column && kind === "text" && (
        <input
          aria-label="筛选器的文本"
          key={String(data.value)}
          disabled={edit.disabled}
          defaultValue={typeof data.value === "string" ? data.value : ""}
          onBlur={(event) => {
            const value = event.target.value;
            if (value !== (data.value ?? ""))
              void edit.save(
                value ? { op: "contains", value } : {},
                value ? ["upper"] : clear,
              );
          }}
        />
      )}
      {column && kind === "range" && numbers.length > 0 && (
        <label>
          范围上限
          <input
            aria-label="范围上限"
            type="range"
            min={min}
            max={max}
            step="any"
            key={String(data.upper)}
            defaultValue={typeof data.upper === "number" ? data.upper : max}
            disabled={edit.disabled}
            onBlur={(event) => {
              const upper = event.target.valueAsNumber;
              if (Number.isFinite(upper) && upper !== (data.upper ?? max))
                void edit.save({ op: "between", value: min, upper });
            }}
          />
          <span>
            {min} 至 {typeof data.upper === "number" ? data.upper : max}
          </span>
        </label>
      )}
      {!props.readOnly && data.op !== undefined && (
        <button
          type="button"
          disabled={edit.disabled}
          onClick={() => void edit.save({}, clear)}
        >
          清除筛选值
        </button>
      )}
      {(error || edit.error) && <p role="status">{error || edit.error}</p>}
    </section>
  );
}
