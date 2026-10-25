import { useState } from "react";
import { parseScalar } from "../views/format.ts";
import type { WidgetProps } from "../views/registry.tsx";
import { WidgetShell } from "./shell.tsx";

export function ScalarEditor({
  value,
  schema,
  readOnly,
  onChange,
  ariaLabel,
  label,
}: WidgetProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown =
    draft !== null
      ? draft
      : value === undefined || value === null
        ? ""
        : String(value);
  return (
    <WidgetShell
      label={label}
      readOnly={readOnly}
      onClear={() => {
        setDraft(null);
        onChange(undefined);
      }}
    >
      <input
        aria-label={ariaLabel || label}
        readOnly={readOnly}
        disabled={readOnly}
        value={shown}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          const raw = draft ?? shown;
          setDraft(null);
          onChange(parseScalar(raw, schema));
        }}
      />
    </WidgetShell>
  );
}
