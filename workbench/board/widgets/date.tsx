import type { WidgetProps } from "../views/registry.tsx";
import { parseDateInput } from "./display.ts";
import { WidgetShell } from "./shell.tsx";

export function DateEditor({
  value,
  readOnly,
  onChange,
  ariaLabel,
  label,
}: WidgetProps) {
  const stored =
    typeof value === "string" && parseDateInput(value) ? value : "";
  return (
    <WidgetShell
      label={label}
      readOnly={readOnly}
      onClear={() => onChange(undefined)}
    >
      <input
        type="date"
        aria-label={ariaLabel || label}
        readOnly={readOnly}
        disabled={readOnly}
        value={stored}
        onChange={(event) => onChange(parseDateInput(event.target.value))}
      />
    </WidgetShell>
  );
}
