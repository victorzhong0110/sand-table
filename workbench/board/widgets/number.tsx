import { useState } from "react";
import {
  commitNumber,
  parseNumberDraft,
  widgetKind,
  type JsonSchema,
} from "../views/format.ts";
import type { WidgetProps } from "../views/registry.tsx";
import { WidgetShell } from "./shell.tsx";

export function NumberEditor({
  value,
  schema,
  readOnly,
  onChange,
  ariaLabel,
  label,
}: WidgetProps) {
  const integer = widgetKind(schema) === "integer";
  const [draft, setDraft] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const shown =
    draft !== null
      ? draft
      : value === undefined || value === null
        ? ""
        : String(value);
  const publish = (raw: string, blur: boolean) => {
    const result = commitNumber(raw, schema as JsonSchema);
    setMessage(result.ok ? "" : result.message);
    if (!result.ok) return;
    const complete =
      parseNumberDraft(raw, integer).complete || raw.trim() === "";
    if (blur || complete) {
      if (blur) setDraft(null);
      onChange(result.value);
    }
  };
  return (
    <WidgetShell
      label={label}
      readOnly={readOnly}
      onClear={() => {
        setDraft(null);
        setMessage("");
        onChange(undefined);
      }}
    >
      <input
        aria-label={ariaLabel || label}
        inputMode={integer ? "numeric" : "decimal"}
        readOnly={readOnly}
        disabled={readOnly}
        value={shown}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          publish(next, false);
        }}
        onBlur={() => publish(draft ?? shown, true)}
      />
      {message && <small className="field-warning">{message}</small>}
    </WidgetShell>
  );
}
