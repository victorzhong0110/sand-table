import type { Widget, WidgetProps } from "../views/registry.tsx";
import type { JsonSchema } from "../views/format.ts";
import { nextListItem } from "../views/format.ts";
import { WidgetShell } from "./shell.tsx";

export function ListEditor({
  value,
  schema,
  readOnly,
  onChange,
  label,
  widgetFor,
}: WidgetProps & { widgetFor: (schema: JsonSchema) => Widget }) {
  const items = Array.isArray(value) ? value : [];
  const itemSchema = schema.items ?? {};
  const Editor = widgetFor(itemSchema).Editor;
  const write = (next: unknown[]) => onChange(next.length ? next : undefined);
  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= items.length) return;
    const copy = [...items];
    const [item] = copy.splice(index, 1);
    copy.splice(target, 0, item);
    write(copy);
  };
  return (
    <WidgetShell
      label={label}
      readOnly={readOnly}
      onClear={() => onChange(undefined)}
    >
      <div className="nested-fields">
        {items.map((item, index) => (
          <div key={index} className="list-item">
            <Editor
              value={item}
              schema={itemSchema}
              label={`${label}第 ${index + 1} 项`}
              readOnly={readOnly}
              onChange={(next) =>
                write(nextListItem(items, index, next, itemSchema))
              }
            />
            {!readOnly && (
              <span className="widget-actions">
                <button type="button" onClick={() => move(index, -1)}>
                  上移
                </button>
                <button type="button" onClick={() => move(index, 1)}>
                  下移
                </button>
                <button
                  type="button"
                  aria-label={`删除${label}第 ${index + 1} 项`}
                  onClick={() =>
                    write(items.filter((_, itemIndex) => itemIndex !== index))
                  }
                >
                  删除
                </button>
              </span>
            )}
          </div>
        ))}
      </div>
      {!readOnly && (
        <button type="button" onClick={() => write([...items, undefined])}>
          添加一项
        </button>
      )}
    </WidgetShell>
  );
}
