import { useState } from "react";
import type { WidgetProps } from "../views/registry.tsx";
import { formatMarkdown } from "./display.ts";
import { WidgetShell } from "./shell.tsx";

export function MarkdownEditor({
  value,
  schema,
  readOnly,
  onChange,
  ariaLabel,
  label,
}: WidgetProps) {
  const [preview, setPreview] = useState(false);
  const text = typeof value === "string" ? value : "";
  return (
    <WidgetShell
      label={label}
      readOnly={readOnly}
      onClear={() => onChange(undefined)}
    >
      <button type="button" onClick={() => setPreview((current) => !current)}>
        {preview ? "编辑" : "预览"}
      </button>
      {preview ? (
        <p className="markdown-preview">
          {formatMarkdown(text) || "没有可预览的文字"}
        </p>
      ) : (
        <textarea
          aria-label={ariaLabel || label}
          placeholder={schema["x-sand-placeholder"]}
          readOnly={readOnly}
          disabled={readOnly}
          rows={4}
          value={text}
          onChange={(event) =>
            onChange(event.target.value === "" ? undefined : event.target.value)
          }
        />
      )}
    </WidgetShell>
  );
}
