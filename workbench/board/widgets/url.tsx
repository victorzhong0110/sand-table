import { useState } from "react";
import type { WidgetProps } from "../views/registry.tsx";
import { isHttpUrl } from "./display.ts";
import { useWidgetHost } from "./host.tsx";
import { WidgetShell } from "./shell.tsx";

export function UrlEditor({
  value,
  readOnly,
  onChange,
  ariaLabel,
  label,
}: WidgetProps) {
  const host = useWidgetHost();
  const stored = typeof value === "string" ? value : "";
  const [draft, setDraft] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const shown = draft ?? stored;
  const commit = () => {
    const text = (draft ?? stored).trim();
    setDraft(null);
    if (!text) {
      setMessage("");
      onChange(undefined);
      return;
    }
    if (!isHttpUrl(text)) {
      setMessage("只接受 http 或 https 链接。请改成完整网址后再保存。");
      return;
    }
    setMessage("");
    onChange(text);
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
        type="url"
        aria-label={ariaLabel || label}
        readOnly={readOnly}
        disabled={readOnly}
        value={shown}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
      />
      {isHttpUrl(stored) && (
        <button
          type="button"
          onClick={() => {
            if (!host) return;
            host.openUrl(stored);
          }}
        >
          打开
        </button>
      )}
      {message && <small className="field-warning">{message}</small>}
    </WidgetShell>
  );
}
