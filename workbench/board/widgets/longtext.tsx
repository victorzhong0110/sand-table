import { useLayoutEffect, useRef } from "react";
import type { WidgetProps } from "../views/registry.tsx";
import { WidgetShell } from "./shell.tsx";

function fit(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

export function LongTextEditor({
  value,
  schema,
  readOnly,
  onChange,
  ariaLabel,
  label,
}: WidgetProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const text = typeof value === "string" ? value : "";
  useLayoutEffect(() => {
    if (ref.current) fit(ref.current);
  }, [text]);
  return (
    <WidgetShell
      label={label}
      readOnly={readOnly}
      onClear={() => onChange(undefined)}
    >
      <textarea
        ref={ref}
        aria-label={ariaLabel || label}
        placeholder={schema["x-sand-placeholder"]}
        readOnly={readOnly}
        disabled={readOnly}
        rows={2}
        value={text}
        onChange={(event) => {
          fit(event.currentTarget);
          onChange(event.target.value === "" ? undefined : event.target.value);
        }}
      />
    </WidgetShell>
  );
}
