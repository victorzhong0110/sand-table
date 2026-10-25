import { useState, type JSX } from "react";
import {
  commitNumberDraft,
  fieldLabel,
  formatValue,
  hasValue,
  listEditorKind,
  nextListItem,
  parseNumberDraft,
  parseScalar,
  widgetKind,
  type JsonSchema,
} from "./format.ts";

export type WidgetProps = {
  value: unknown;
  schema: JsonSchema;
  label: string;
  readOnly: boolean;
  onChange(next: unknown | undefined): void;
  /** 盖过外层 label 的无障碍名字。便签正文仍叫「内容」，旧的编辑路径认这个名字。 */
  ariaLabel?: string;
};

export type Widget = {
  display(value: unknown, schema: JsonSchema): string;
  Editor: (props: WidgetProps) => JSX.Element;
};

export type ViewProps = {
  objectId: string;
  type: string;
  title: string;
  data: Record<string, unknown>;
  detail: "full" | "label" | "icon";
  readOnly: boolean;
  dispatch: (
    commands: Record<string, unknown>[],
    options?: { intentId?: string },
  ) => Promise<unknown>;
};

/** 本卡只留空表。display.view 对上名字才用，对不上就用通用视图。 */
export const customViews: Record<string, (props: ViewProps) => JSX.Element> =
  {};

export function customView(name: string | undefined) {
  if (!name) return undefined;
  return customViews[name];
}

function textOf(value: unknown): string {
  if (value === undefined || value === null) return "";
  return String(value);
}

function TextEditor({
  value,
  schema,
  readOnly,
  onChange,
  ariaLabel,
  label,
}: WidgetProps) {
  const kind = widgetKind(schema);
  const long = kind === "longtext" || kind === "markdown";
  const name = ariaLabel || label;
  if (long)
    return (
      <textarea
        aria-label={name}
        placeholder={schema["x-sand-placeholder"]}
        readOnly={readOnly}
        disabled={readOnly}
        value={textOf(value)}
        onChange={(event) =>
          onChange(event.target.value === "" ? undefined : event.target.value)
        }
      />
    );
  return (
    <input
      aria-label={name}
      placeholder={schema["x-sand-placeholder"]}
      readOnly={readOnly}
      disabled={readOnly}
      value={textOf(value)}
      onChange={(event) =>
        onChange(event.target.value === "" ? undefined : event.target.value)
      }
    />
  );
}

function NumberEditor({
  value,
  schema,
  readOnly,
  onChange,
  ariaLabel,
  label,
}: WidgetProps) {
  const integer = widgetKind(schema) === "integer";
  const [draft, setDraft] = useState<string | null>(null);
  const shown =
    draft !== null
      ? draft
      : value === undefined || value === null
        ? ""
        : String(value);
  return (
    <input
      aria-label={ariaLabel || label}
      inputMode={integer ? "numeric" : "decimal"}
      readOnly={readOnly}
      disabled={readOnly}
      value={shown}
      onChange={(event) => {
        const next = event.target.value;
        setDraft(next);
        const parsed = parseNumberDraft(next, integer);
        if (parsed.complete) onChange(parsed.value);
      }}
      onBlur={() => {
        const raw = draft ?? shown;
        setDraft(null);
        onChange(commitNumberDraft(raw, integer));
      }}
    />
  );
}

function ScalarEditor({
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
  );
}

function BooleanEditor({
  value,
  readOnly,
  onChange,
  ariaLabel,
  label,
}: WidgetProps) {
  return (
    <input
      aria-label={ariaLabel || label}
      type="checkbox"
      disabled={readOnly}
      checked={value === true}
      onChange={(event) => onChange(event.target.checked)}
    />
  );
}

function EnumEditor({
  value,
  schema,
  readOnly,
  onChange,
  ariaLabel,
  label,
}: WidgetProps) {
  const labels = schema["x-sand-enum-labels"] ?? {};
  const options = schema.enum ?? Object.keys(labels);
  return (
    <select
      aria-label={ariaLabel || label}
      disabled={readOnly}
      value={value === undefined || value === null ? "" : String(value)}
      onChange={(event) =>
        onChange(event.target.value === "" ? undefined : event.target.value)
      }
    >
      <option value="">未填</option>
      {options.map((option) => (
        <option key={String(option)} value={String(option)}>
          {labels[String(option)] || String(option)}
        </option>
      ))}
    </select>
  );
}

function TagsEditor({
  value,
  readOnly,
  onChange,
  ariaLabel,
  label,
}: WidgetProps) {
  const text = Array.isArray(value)
    ? value.map((item) => String(item)).join("\n")
    : "";
  return (
    <textarea
      aria-label={ariaLabel || label}
      readOnly={readOnly}
      disabled={readOnly}
      value={text}
      onChange={(event) => {
        const items = event.target.value
          .split(/[\n,，]/)
          .map((item) => item.trim())
          .filter(Boolean);
        onChange(items.length ? items : undefined);
      }}
    />
  );
}

function ObjectEditor({ value, schema, readOnly, onChange }: WidgetProps) {
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const properties = schema.properties ?? {};
  const changeKey = (key: string, next: unknown | undefined) => {
    const copy = { ...record };
    if (next === undefined) delete copy[key];
    else copy[key] = next;
    onChange(Object.keys(copy).length ? copy : undefined);
  };
  return (
    <div className="nested-fields">
      {Object.entries(properties).map(([key, child]) => {
        if (child["x-sand-hidden"]) return null;
        const widget = widgetFor(child);
        const Editor = widget.Editor;
        return (
          <label key={key}>
            {fieldLabel(key, child)}
            <Editor
              value={record[key]}
              schema={child}
              label={fieldLabel(key, child)}
              readOnly={readOnly}
              onChange={(next) => changeKey(key, next)}
            />
          </label>
        );
      })}
    </div>
  );
}

function ListEditor({
  value,
  schema,
  readOnly,
  onChange,
  ariaLabel,
  label,
}: WidgetProps) {
  const items = Array.isArray(value) ? value : [];
  const itemSchema = schema.items ?? {};
  if (listEditorKind(schema) === "nested") {
    const Editor = widgetFor(itemSchema).Editor;
    return (
      <div className="nested-fields">
        {items.map((item, index) => (
          <Editor
            key={index}
            value={item}
            schema={itemSchema}
            label={`${label} ${index + 1}`}
            readOnly={readOnly}
            onChange={(next) => {
              const copy = nextListItem(items, index, next, itemSchema);
              onChange(copy.length ? copy : undefined);
            }}
          />
        ))}
      </div>
    );
  }
  return (
    <TagsEditor
      value={items}
      schema={schema}
      label={label}
      ariaLabel={ariaLabel}
      readOnly={readOnly}
      onChange={onChange}
    />
  );
}

const EDITORS: Record<string, Widget["Editor"]> = {
  text: TextEditor,
  longtext: TextEditor,
  markdown: TextEditor,
  url: TextEditor,
  date: TextEditor,
  color: TextEditor,
  locator: TextEditor,
  blob: TextEditor,
  number: NumberEditor,
  integer: NumberEditor,
  boolean: BooleanEditor,
  enum: EnumEditor,
  tags: TagsEditor,
  list: ListEditor,
  table: ListEditor,
  object: ObjectEditor,
};

export function widgetFor(schema: JsonSchema): Widget {
  const kind = widgetKind(schema);
  const Editor =
    kind === "text" && schema.anyOf?.length
      ? ScalarEditor
      : (EDITORS[kind] ?? TextEditor);
  return {
    display: (value) => formatValue(value, schema),
    Editor,
  };
}

export function propertyEntries(schema: JsonSchema | undefined) {
  return Object.entries(schema?.properties ?? {}).filter(
    ([, child]) => !child["x-sand-hidden"],
  );
}

export function requiredKeys(schema: JsonSchema | undefined): Set<string> {
  return new Set(schema?.required ?? []);
}

export function otherFieldKeys(
  data: Record<string, unknown>,
  schema: JsonSchema | undefined,
): string[] {
  const known = new Set(Object.keys(schema?.properties ?? {}));
  return Object.keys(data)
    .filter((key) => !known.has(key) && hasValue(data[key]))
    .sort();
}
