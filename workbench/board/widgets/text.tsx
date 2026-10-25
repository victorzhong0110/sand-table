import type { WidgetProps } from "../views/registry.tsx";
import { WidgetShell } from "./shell.tsx";

export function TextEditor({
  value,
  schema,
  readOnly,
  onChange,
  ariaLabel,
  label,
}: WidgetProps) {
  const text = typeof value === "string" ? value : "";
  const max = schema.maxLength;
  const left =
    typeof max === "number" ? Math.max(0, max - text.length) : undefined;
  return (
    <WidgetShell
      label={label}
      readOnly={readOnly}
      onClear={() => onChange(undefined)}
    >
      <input
        aria-label={ariaLabel || label}
        placeholder={schema["x-sand-placeholder"]}
        readOnly={readOnly}
        disabled={readOnly}
        maxLength={max}
        value={text}
        onChange={(event) =>
          onChange(event.target.value === "" ? undefined : event.target.value)
        }
      />
      {left !== undefined && (
        <small className="widget-hint">还可输入 {left} 字</small>
      )}
    </WidgetShell>
  );
}
