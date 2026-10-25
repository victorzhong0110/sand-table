import type { WidgetProps } from "../views/registry.tsx";
import { formatColor } from "./display.ts";
import { WidgetShell } from "./shell.tsx";

export function ColorEditor({ value, readOnly, onChange, label }: WidgetProps) {
  const hex = formatColor(value);
  return (
    <WidgetShell
      label={label}
      readOnly={readOnly}
      onClear={() => onChange(undefined)}
    >
      <input
        type="color"
        aria-label={`${label}色块`}
        disabled={readOnly}
        value={hex || "#000000"}
        onChange={(event) => onChange(event.target.value)}
      />
      <input
        aria-label={`${label}色值`}
        readOnly={readOnly}
        disabled={readOnly}
        value={typeof value === "string" ? value : ""}
        placeholder="#336699"
        onChange={(event) => {
          const text = event.target.value.trim();
          if (!text) {
            onChange(undefined);
            return;
          }
          if (/^#[0-9a-fA-F]{6}$/.test(text)) onChange(text.toLowerCase());
        }}
      />
    </WidgetShell>
  );
}
