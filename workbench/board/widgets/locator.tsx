import { useState } from "react";
import type { WidgetProps } from "../views/registry.tsx";
import { parseFragment } from "./display.ts";
import { WidgetShell } from "./shell.tsx";

const KINDS = ["file", "git", "pdf", "url", "dataset", "symbol"] as const;
const KIND_LABELS: Record<(typeof KINDS)[number], string> = {
  file: "文件",
  git: "代码仓库",
  pdf: "PDF",
  url: "网页",
  dataset: "数据集",
  symbol: "符号",
};

type LocatorValue = {
  kind: (typeof KINDS)[number];
  uri: string;
  fragment: string;
};

function readLocator(value: unknown): LocatorValue {
  const raw =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const kind = KINDS.find((item) => item === raw.kind) ?? "url";
  return {
    kind,
    uri: typeof raw.uri === "string" ? raw.uri : "",
    fragment: typeof raw.fragment === "string" ? raw.fragment : "",
  };
}

export function LocatorEditor({
  value,
  readOnly,
  onChange,
  label,
}: WidgetProps) {
  const current = readLocator(value);
  const [message, setMessage] = useState("");
  const write = (next: LocatorValue) => {
    if (!next.uri.trim() && !next.fragment.trim()) {
      setMessage("");
      onChange(undefined);
      return;
    }
    const parsed = parseFragment(next.fragment);
    if (!parsed.ok) {
      setMessage(parsed.message);
      return;
    }
    setMessage("");
    onChange({
      kind: next.kind,
      uri: next.uri.trim(),
      ...(next.fragment.trim() ? { fragment: next.fragment.trim() } : {}),
    });
  };
  return (
    <WidgetShell
      label={label}
      readOnly={readOnly}
      onClear={() => {
        setMessage("");
        onChange(undefined);
      }}
    >
      <label>
        资源种类
        <select
          aria-label={`${label}种类`}
          disabled={readOnly}
          value={current.kind}
          onChange={(event) =>
            write({
              ...current,
              kind: KINDS.find((item) => item === event.target.value) ?? "url",
            })
          }
        >
          {KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {KIND_LABELS[kind]}
            </option>
          ))}
        </select>
      </label>
      <label>
        地址
        <input
          aria-label={`${label}地址`}
          readOnly={readOnly}
          disabled={readOnly}
          value={current.uri}
          onChange={(event) => write({ ...current, uri: event.target.value })}
        />
      </label>
      <label>
        片段
        <input
          aria-label={`${label}片段`}
          readOnly={readOnly}
          disabled={readOnly}
          placeholder="page=3 或 lines=12-20"
          value={current.fragment}
          onChange={(event) =>
            write({ ...current, fragment: event.target.value })
          }
        />
      </label>
      {message && <small className="field-warning">{message}</small>}
    </WidgetShell>
  );
}
