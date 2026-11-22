import type { ViewProps } from "../views/registry.tsx";
import {
  aggregateValues,
  tableViewOf,
  type Aggregate,
} from "./derive-table.ts";
import { cellValue } from "./table-model.ts";
import { useDerivedTableSource } from "./use-table-source.ts";
import { useViewSave } from "./use-view-save.ts";

export const aggregateLabels: Record<Aggregate, string> = {
  count: "计数",
  sum: "合计",
  avg: "平均",
  min: "最小",
  max: "最大",
};

export function MetricView(props: ViewProps) {
  const {
    object: { data },
    bindings,
    readOnly,
  } = props;
  const { source, table, filters, reading, error } =
    useDerivedTableSource(bindings);
  const edit = useViewSave(props);
  const aggregate =
    (Object.keys(aggregateLabels) as Aggregate[]).find(
      (value) => data.aggregate === value,
    ) ?? "count";
  const key = typeof data.column === "string" ? data.column : "";
  const configuredUnit = typeof data.unit === "string" ? data.unit : undefined;
  const legacy = (data.legacy ?? {}) as {
    value?: string;
    description?: string;
  };
  const columns =
    table?.columns.filter(
      (col) => aggregate === "count" || col.type === "number",
    ) ?? [];
  const column = columns.find((col) => col.key === key);
  const invalid = Boolean(table && !column && (key || aggregate !== "count"));
  const value =
    table && !invalid
      ? column
        ? aggregateValues(
            table.rows.map((row) => cellValue(row, column.key)),
            aggregate,
          )
        : table.rows.length
      : null;
  const unit =
    configuredUnit ?? (aggregate === "count" ? undefined : column?.unit);
  const count =
    filters.length +
    (source ? (tableViewOf(source.data).filters?.length ?? 0) : 0);
  return (
    <section className="nodrag nopan nowheel" aria-label="指标">
      {reading && <p role="status">正在读取源表格…</p>}
      {(error || edit.error) && <p role="status">{error || edit.error}</p>}
      {!reading && !error && (
        <>
          <p className="metric-value">
            {(source ? value : legacy.value) ?? "—"}
            {unit && <span> {unit}</span>}
          </p>
          {source ? (
            <>
              <p>
                {source.title} · 版本 {source.version}
              </p>
              <p>
                {aggregateLabels[aggregate]} · {column?.label ?? "可见行"} ·{" "}
                {count} 个筛选条件
              </p>
              {invalid && <p role="status">请选择适合此统计方式的源表列。</p>}
              {table?.configurationErrors.map((problem) => (
                <p key={problem} role="status">
                  {problem}
                </p>
              ))}
            </>
          ) : (
            legacy.description && <p>{legacy.description}</p>
          )}
        </>
      )}
      {!readOnly && (
        <details>
          <summary>配置指标</summary>
          <input
            aria-label="指标单位"
            key={configuredUnit}
            defaultValue={configuredUnit ?? ""}
            maxLength={200}
            disabled={edit.disabled}
            onBlur={(event) => {
              const unit = event.target.value;
              if (unit !== (configuredUnit ?? ""))
                void edit.save(unit ? { unit } : {}, unit ? [] : ["unit"]);
            }}
          />
          {source ? (
            <>
              <select
                aria-label="指标统计方式"
                value={aggregate}
                disabled={edit.disabled}
                onChange={(event) =>
                  void edit.save({ aggregate: event.target.value })
                }
              >
                {Object.entries(aggregateLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <select
                aria-label="指标统计列"
                value={key}
                disabled={edit.disabled}
                onChange={(event) => {
                  const column = event.target.value;
                  void edit.save(
                    column ? { column } : {},
                    column ? [] : ["column"],
                  );
                }}
              >
                <option value="">
                  {aggregate === "count" ? "计所有可见行" : "选择一列"}
                </option>
                {key && !column && <option value={key}>原列不可用</option>}
                {columns.map(({ key, label }) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </>
          ) : (
            (["value", "description"] as const).map((field) => (
              <input
                key={field + legacy[field]}
                aria-label={field === "value" ? "手填指标值" : "手填指标说明"}
                defaultValue={legacy[field] ?? ""}
                maxLength={200}
                disabled={edit.disabled}
                onBlur={(event) => {
                  if (event.target.value !== (legacy[field] ?? ""))
                    void edit.save({
                      legacy: { ...legacy, [field]: event.target.value },
                    });
                }}
              />
            ))
          )}
        </details>
      )}
    </section>
  );
}
