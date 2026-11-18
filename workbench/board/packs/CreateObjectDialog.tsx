import { useEffect, useRef, useState } from "react";
import { fieldLabel, type JsonSchema } from "../views/format.ts";
import { widgetFor } from "../views/registry.tsx";

export function CreateObjectDialog({
  title,
  schema,
  initial,
  onCreate,
  onCancel,
}: {
  title: string;
  schema: JsonSchema;
  initial: Record<string, unknown>;
  onCreate: (data: Record<string, unknown>) => Promise<string | undefined>;
  onCancel: () => void;
}) {
  const [values, setValues] = useState(initial);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const fields = Object.entries(schema.properties ?? {}).filter(
    ([, field]) => !field["x-sand-hidden"],
  );
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current
      ?.querySelector<HTMLElement>("input, select, textarea, button")
      ?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, []);
  async function submit() {
    const missing = (schema.required ?? []).filter(
      (key) => !Object.prototype.hasOwnProperty.call(values, key),
    );
    if (missing.length) {
      setError(
        `请填写：${missing.map((key) => fieldLabel(key, schema.properties?.[key])).join("、")}。`,
      );
      return;
    }
    setBusy(true);
    setError("");
    try {
      const failure = await onCreate(values);
      if (failure) setError(failure);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      ref={dialog}
      className="arrange-confirm create-object-dialog"
      role="dialog"
      aria-modal="true"
      aria-label={`填写${title}`}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) {
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        }
        if (event.key === "Tab") {
          const controls = [
            ...(dialog.current?.querySelectorAll<HTMLElement>(
              "input:not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled)",
            ) ?? []),
          ].filter((element) => element.getClientRects().length > 0);
          const first = controls[0];
          const last = controls.at(-1);
          if (event.shiftKey && document.activeElement === first && last) {
            event.preventDefault();
            last.focus();
          } else if (
            !event.shiftKey &&
            document.activeElement === last &&
            first
          ) {
            event.preventDefault();
            first.focus();
          }
        }
      }}
    >
      <h2>填写{title}</h2>
      <p>先填写创建组件需要的内容。</p>
      {fields.map(([key, field]) => {
        const Editor = widgetFor(field).Editor;
        const label = fieldLabel(key, field);
        return (
          <label key={key}>
            {label}
            {schema.required?.includes(key) ? " *" : ""}
            <Editor
              value={values[key]}
              schema={field}
              label={label}
              readOnly={false}
              onChange={(next) =>
                setValues((old) => {
                  const copy = { ...old };
                  if (next === undefined) delete copy[key];
                  else copy[key] = next;
                  return copy;
                })
              }
            />
          </label>
        );
      })}
      {!fields.length && (
        <p>这个组件没有提供可填写的字段，请联系组件包作者。</p>
      )}
      {error && <p role="alert">{error}</p>}
      <div className="row">
        <button type="button" disabled={busy} onClick={onCancel}>
          取消
        </button>
        <button
          type="button"
          disabled={busy || !fields.length}
          onClick={() => void submit()}
        >
          创建组件
        </button>
      </div>
    </div>
  );
}
