import type { WidgetProps } from "../views/registry.tsx";
import { WidgetShell } from "./shell.tsx";

export function BooleanEditor({
  value,
  readOnly,
  onChange,
  label,
}: WidgetProps) {
  const current = value === true ? "yes" : value === false ? "no" : "";
  return (
    <WidgetShell
      label={label}
      readOnly={readOnly}
      onClear={() => onChange(undefined)}
    >
      <select
        aria-label={label}
        disabled={readOnly}
        value={current}
        onChange={(event) => {
          const next = event.target.value;
          if (next === "yes") onChange(true);
          else if (next === "no") onChange(false);
          else onChange(undefined);
        }}
      >
        <option value="">未设置</option>
        <option value="yes">是</option>
        <option value="no">否</option>
      </select>
    </WidgetShell>
  );
}
