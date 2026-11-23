import { useMemo, useState } from "react";
import type { ViewProps } from "../views/registry.tsx";
import { deriveTable, tableViewOf } from "./derive-table.ts";
import { cellValue, tableOf } from "./table-model.ts";
import { useBoundTables } from "./use-table-source.ts";
import { useViewSave } from "./use-view-save.ts";

function RangeFilter({
  min,
  max,
  savedLower,
  savedUpper,
  disabled,
  apply,
}: {
  min: number;
  max: number;
  savedLower?: number;
  savedUpper?: number;
  disabled: boolean;
  apply: (lower: number, upper: number) => void;
}) {
  const [lower, setLower] = useState(savedLower ?? min);
  const [upper, setUpper] = useState(savedUpper ?? max);
  return (
    <div>
      <label>
        范围下限
        <input
          type="range"
          min={min}
          max={max}
          step="any"
          value={lower}
          disabled={disabled}
          onChange={(event) =>
            setLower(Math.min(event.target.valueAsNumber, upper))
          }
        />
      </label>
      <label>
        范围上限
        <input
          type="range"
          min={min}
          max={max}
          step="any"
          value={upper}
          disabled={disabled}
          onChange={(event) =>
            setUpper(Math.max(event.target.valueAsNumber, lower))
          }
        />
      </label>
      <span>
        {lower} 至 {upper}
      </span>
      <button
        type="button"
        disabled={
          disabled ||
          lower > upper ||
          (lower === savedLower && upper === savedUpper)
        }
        onClick={() => apply(lower, upper)}
      >
        应用范围
      </button>
    </div>
  );
}

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
  const savedLower =
    data.op === "between" && typeof data.value === "number"
      ? data.value
      : undefined;
  const savedUpper =
    data.op === "between" && typeof data.upper === "number"
      ? data.upper
      : undefined;
  const min = Math.min(
    savedLower ?? Infinity,
    savedUpper ?? Infinity,
    ...numbers,
  );
  const max = Math.max(
    savedLower ?? -Infinity,
    savedUpper ?? -Infinity,
    ...numbers,
  );
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
        <RangeFilter
          key={JSON.stringify([column.key, min, max, savedLower, savedUpper])}
          min={min}
          max={max}
          savedLower={savedLower}
          savedUpper={savedUpper}
          disabled={edit.disabled}
          apply={(value, upper) =>
            void edit.save({ op: "between", value, upper })
          }
        />
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
