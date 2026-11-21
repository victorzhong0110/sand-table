import { useEffect, useRef, useState } from "react";
import {
  clearDraft,
  editIntent,
  endEditSession,
  readDraft,
  writeDraft,
} from "../edit-session.ts";
import type { ViewProps } from "../views/registry.tsx";
import { pasteCells } from "./paste.ts";
import {
  cellValue,
  columnNames,
  convertCell,
  editValue,
  newColumn,
  newRow,
  reinterpretColumn,
  tableLimit,
  tableOf,
  type Column,
  type ColumnKind,
  type TableData,
} from "./table-model.ts";

export function TableView({
  workspaceId,
  object,
  presentation,
  readOnly,
  dispatch,
}: ViewProps) {
  const instanceId = `${workspaceId}:${presentation.id}`;
  const existing = () => readDraft(instanceId);
  const [draft, setDraft] = useState(() =>
    existing() ? tableOf(existing()!.edits) : tableOf(object.data),
  );
  const [error, setError] = useState("");
  const [pendingType, setPendingType] = useState<{
    key: string;
    type: ColumnKind;
  }>();
  const active = useRef(draft);
  const version = useRef(object.version);
  const latest = useRef({ object, dispatch });
  latest.current = { object, dispatch };
  const timer = useRef(0);
  const writing = useRef(false);

  function queue() {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void commit(), 600);
  }

  async function commit() {
    if (writing.current || readOnly) return;
    const pending = existing();
    if (!pending) return;
    const { object, dispatch } = latest.current;
    if (
      !Object.keys(pending.starts).every(
        (key) =>
          JSON.stringify(
            (object.data as Record<string, unknown>)[key] ?? [],
          ) === JSON.stringify(pending.starts[key] ?? []),
      ) &&
      version.current <= object.version
    ) {
      setError("表格在编辑时被更新。草稿还在，请先核对源表版本。");
      return;
    }
    writing.current = true;
    const expected = Math.max(version.current, object.version);
    try {
      const result = await dispatch(
        [
          {
            op: "object.update",
            id: object.id,
            expectedVersion: expected,
            set: pending.edits,
          },
        ],
        { intentId: editIntent(instanceId) },
      );
      version.current =
        result.changed.find(
          (row) => row.table === "objects" && row.id === object.id,
        )?.version ?? expected;
      const remaining = existing();
      if (remaining === pending) {
        clearDraft(instanceId);
        endEditSession(instanceId);
      } else if (remaining) {
        writeDraft(instanceId, { ...remaining, starts: pending.edits });
        queue();
      }
      setError("");
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "表格保存失败，编辑内容仍在草稿中。",
      );
      if (latest.current.object.version > expected) queue();
    } finally {
      writing.current = false;
    }
  }
  useEffect(() => {
    if (writing.current || object.version < version.current) return;
    if (existing()) {
      if (object.version > version.current) queue();
      return;
    }
    const table = tableOf(object.data);
    version.current = object.version;
    active.current = table;
    setDraft(table);
  }, [object]);
  useEffect(() => {
    if (existing()) queue();
    return () => window.clearTimeout(timer.current);
  }, [instanceId]);

  function update(table: TableData) {
    const previous = existing();
    const current = latest.current.object;
    if (!previous && !writing.current)
      version.current = Math.max(version.current, current.version);
    active.current = table;
    setDraft(table);
    writeDraft(instanceId, {
      title: current.title,
      startTitle: current.title,
      edits: table,
      starts: previous?.starts ?? tableOf(current.data),
    });
    setError("");
    queue();
  }
  function changeColumn(column: Column, patch: Partial<Column>) {
    const table = active.current;
    update({
      ...table,
      columns: table.columns.map((value) =>
        value.key === column.key ? { ...column, ...patch } : value,
      ),
    });
  }
  function removeColumn(key: string) {
    const table = active.current;
    update({
      columns: table.columns.filter((value) => value.key !== key),
      rows: table.rows.map((row) => {
        const cells = { ...row.cells };
        delete cells[key];
        return { ...row, cells };
      }),
    });
  }
  const converted = pendingType
    ? reinterpretColumn(draft, pendingType.key, pendingType.type)
    : undefined;
  if (object.migrationError)
    return <p role="status">{object.migrationError}</p>;

  return (
    <section
      className="nodrag nowheel nopan data-table"
      aria-label="表格编辑器"
      style={{ overflow: "auto", maxHeight: 240 }}
    >
      <table>
        <thead>
          <tr>
            {draft.columns.map((column) => (
              <th key={column.key} scope="col">
                <input
                  aria-label={column.label + "列名"}
                  value={column.label}
                  disabled={readOnly}
                  maxLength={200}
                  onChange={(event) =>
                    changeColumn(column, { label: event.target.value })
                  }
                />
                <select
                  aria-label={column.label + "列类型"}
                  value={column.type}
                  disabled={readOnly}
                  onChange={(event) =>
                    setPendingType({
                      key: column.key,
                      type: event.target.value as ColumnKind,
                    })
                  }
                >
                  {Object.entries(columnNames).map(([value, name]) => (
                    <option key={value} value={value}>
                      {name}
                    </option>
                  ))}
                </select>
                <input
                  aria-label={column.label + "单位"}
                  placeholder="单位"
                  value={column.unit ?? ""}
                  disabled={readOnly}
                  maxLength={200}
                  onChange={(event) =>
                    changeColumn(column, { unit: event.target.value })
                  }
                />
                <button
                  type="button"
                  disabled={readOnly}
                  aria-label={`删除「${column.label}」列`}
                  onClick={() => removeColumn(column.key)}
                >
                  删列
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {draft.rows.map((row, rowIndex) => (
            <tr key={row.key}>
              {draft.columns.map((column, columnIndex) => {
                const cell = cellValue(row, column.key);
                const invalid = !convertCell(cell, column.type).valid;
                return (
                  <td key={column.key}>
                    <input
                      aria-label={`第 ${rowIndex + 1} 行 ${column.label}`}
                      value={cell == null ? "" : String(cell)}
                      disabled={readOnly}
                      aria-invalid={invalid}
                      title={
                        invalid
                          ? `这个值不能作为${columnNames[column.type]}，原值已保留。`
                          : undefined
                      }
                      onChange={(event) => {
                        const table = active.current,
                          value = editValue(event.target.value, column.type);
                        update({
                          ...table,
                          rows: table.rows.map((entry) =>
                            entry.key === row.key
                              ? {
                                  ...entry,
                                  cells: {
                                    ...entry.cells,
                                    [column.key]: value,
                                  },
                                }
                              : entry,
                          ),
                        });
                      }}
                      onPaste={(event) => {
                        const text = event.clipboardData.getData("text/plain");
                        if (!/[\t\n\r]/.test(text)) return;
                        event.preventDefault();
                        try {
                          update(
                            pasteCells(
                              active.current,
                              text,
                              rowIndex,
                              columnIndex,
                            ),
                          );
                        } catch (e) {
                          setError(
                            e instanceof Error
                              ? e.message
                              : "无法粘贴这些单元格。",
                          );
                        }
                      }}
                    />
                  </td>
                );
              })}
              <td>
                <button
                  type="button"
                  aria-label={`删除第 ${rowIndex + 1} 行`}
                  disabled={readOnly}
                  onClick={() =>
                    update({
                      ...active.current,
                      rows: active.current.rows.filter(
                        ({ key }) => key !== row.key,
                      ),
                    })
                  }
                >
                  删行
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!readOnly && (
        <div>
          <button
            type="button"
            disabled={draft.columns.length >= tableLimit}
            onClick={() =>
              update({
                ...active.current,
                columns: [
                  ...active.current.columns,
                  newColumn(`列 ${active.current.columns.length + 1}`),
                ],
              })
            }
          >
            添加列
          </button>
          <button
            type="button"
            disabled={draft.rows.length >= tableLimit || !draft.columns.length}
            onClick={() =>
              update({
                ...active.current,
                rows: [...active.current.rows, newRow()],
              })
            }
          >
            添加行
          </button>
          {error && <p role="status">{error}</p>}
        </div>
      )}
      {converted && (
        <div role="group" aria-label="列类型转换预览">
          <p>
            {converted.invalid
              ? `${converted.invalid} 个值无法转换，将保留原值并标错。`
              : "当前值可以转换。"}
          </p>
          <button
            type="button"
            onClick={() => {
              update(converted.data);
              setPendingType(undefined);
            }}
          >
            应用转换
          </button>
          <button type="button" onClick={() => setPendingType(undefined)}>
            取消
          </button>
        </div>
      )}
    </section>
  );
}
