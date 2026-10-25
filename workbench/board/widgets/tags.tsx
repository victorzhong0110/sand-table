import { useState } from "react";
import type { WidgetProps } from "../views/registry.tsx";
import { normalizeTags } from "./display.ts";
import { WidgetShell } from "./shell.tsx";

export function TagsEditor({
  value,
  readOnly,
  onChange,
  ariaLabel,
  label,
}: WidgetProps) {
  const [draft, setDraft] = useState("");
  const tags = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
  const commit = (next: string[]) => {
    const unique = normalizeTags(next);
    onChange(unique.length ? unique : undefined);
  };
  const add = () => {
    commit([...tags, draft]);
    setDraft("");
  };
  return (
    <WidgetShell
      label={label}
      readOnly={readOnly}
      onClear={() => {
        setDraft("");
        onChange(undefined);
      }}
    >
      <span className="tag-list">
        {tags.map((tag) => (
          <span key={tag} className="tag-chip">
            {tag}
            {!readOnly && (
              <button
                type="button"
                aria-label={`删除${tag}`}
                onClick={() => commit(tags.filter((item) => item !== tag))}
              >
                ×
              </button>
            )}
          </span>
        ))}
      </span>
      {!readOnly && (
        <input
          aria-label={ariaLabel || label}
          value={draft}
          placeholder="输入后按回车"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            add();
          }}
        />
      )}
    </WidgetShell>
  );
}
