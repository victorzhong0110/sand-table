import type { WidgetProps } from "../views/registry.tsx";
import { WidgetShell } from "./shell.tsx";

export function EnumEditor({
  value,
  schema,
  readOnly,
  onChange,
  ariaLabel,
  label,
}: WidgetProps) {
  const labels = schema["x-sand-enum-labels"] ?? {};
  const options = schema.enum ?? Object.keys(labels);
  return (
    <WidgetShell
      label={label}
      readOnly={readOnly}
      onClear={() => onChange(undefined)}
    >
      <select
        aria-label={ariaLabel || label}
        disabled={readOnly}
        value={value === undefined || value === null ? "" : String(value)}
        onChange={(event) =>
          onChange(event.target.value === "" ? undefined : event.target.value)
        }
      >
        <option value="">未设置</option>
        {options.map((option) => (
          <option key={String(option)} value={String(option)}>
            {labels[String(option)] || String(option)}
          </option>
        ))}
      </select>
    </WidgetShell>
  );
}
