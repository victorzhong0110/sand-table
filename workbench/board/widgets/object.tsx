import type { Widget, WidgetProps } from "../views/registry.tsx";
import { fieldLabel, type JsonSchema } from "../views/format.ts";
import { WidgetShell } from "./shell.tsx";

export function ObjectEditor({
  value,
  schema,
  readOnly,
  onChange,
  label,
  widgetFor,
}: WidgetProps & { widgetFor: (schema: JsonSchema) => Widget }) {
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const properties = schema.properties ?? {};
  const changeKey = (key: string, next: unknown | undefined) => {
    const copy = { ...record };
    if (next === undefined) delete copy[key];
    else copy[key] = next;
    onChange(Object.keys(copy).length ? copy : undefined);
  };
  return (
    <WidgetShell
      label={label}
      readOnly={readOnly}
      onClear={() => onChange(undefined)}
    >
      <div className="nested-fields">
        {Object.entries(properties).map(([key, child]) => {
          if (child["x-sand-hidden"]) return null;
          const Editor = widgetFor(child).Editor;
          const childLabel = fieldLabel(key, child);
          return (
            <label key={key}>
              {childLabel}
              <Editor
                value={record[key]}
                schema={child}
                label={childLabel}
                readOnly={readOnly}
                onChange={(next) => changeKey(key, next)}
              />
            </label>
          );
        })}
      </div>
    </WidgetShell>
  );
}
