import { parseScalar, type JsonSchema } from "../views/format.ts";
import type { WidgetProps } from "../views/registry.tsx";
import { WidgetShell } from "./shell.tsx";

function asRows(value: unknown): unknown[][] {
  if (!Array.isArray(value)) return [];
  return value.map((row) => (Array.isArray(row) ? [...row] : []));
}

export function TableEditor({
  value,
  schema,
  readOnly,
  onChange,
  label,
}: WidgetProps) {
  const rows = asRows(value);
  const cellSchema = schema.items?.items ?? {};
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const write = (next: unknown[][]) => onChange(next.length ? next : undefined);
  const setCell = (row: number, column: number, raw: string) => {
    const copy = rows.map((item) => [...item]);
    while (copy[row].length <= column) copy[row].push(null);
    copy[row][column] = raw.trim() ? parseScalar(raw, cellSchema) : null;
    write(copy);
  };
  return (
    <WidgetShell
      label={label}
      readOnly={readOnly}
      onClear={() => onChange(undefined)}
    >
      <table className="widget-table">
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {Array.from({ length: Math.max(width, 1) }, (_, column) => (
                <td key={column}>
                  <input
                    aria-label={`${label}第${rowIndex + 1}行第${column + 1}列`}
                    readOnly={readOnly}
                    disabled={readOnly}
                    defaultValue={
                      row[column] === undefined || row[column] === null
                        ? ""
                        : String(row[column])
                    }
                    onBlur={(event) =>
                      setCell(rowIndex, column, event.target.value)
                    }
                  />
                </td>
              ))}
              {!readOnly && (
                <td>
                  <button
                    type="button"
                    aria-label={`删除${label}第${rowIndex + 1}行`}
                    onClick={() =>
                      write(rows.filter((_, index) => index !== rowIndex))
                    }
                  >
                    删除行
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {!readOnly && (
        <span className="widget-actions">
          <button
            type="button"
            onClick={() =>
              write([...rows, Array.from({ length: width }, () => null)])
            }
          >
            加一行
          </button>
          <button
            type="button"
            onClick={() => write(rows.map((row) => [...row, null]))}
          >
            加一列
          </button>
          {width > 0 && (
            <button
              type="button"
              onClick={() =>
                write(
                  rows.map((row) => row.slice(0, Math.max(0, row.length - 1))),
                )
              }
            >
              删除最后一列
            </button>
          )}
        </span>
      )}
    </WidgetShell>
  );
}

export function tableCellSchema(schema: JsonSchema): JsonSchema {
  return schema.items?.items ?? {};
}
