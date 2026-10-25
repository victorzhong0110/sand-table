import type { JSX } from "react";
import {
  formatValue,
  hasValue,
  widgetKind,
  type JsonSchema,
} from "./format.ts";
import { BooleanEditor } from "../widgets/boolean.tsx";
import { BlobEditor } from "../widgets/blob.tsx";
import { ColorEditor } from "../widgets/color.tsx";
import { DateEditor } from "../widgets/date.tsx";
import { EnumEditor } from "../widgets/enum.tsx";
import { ListEditor } from "../widgets/list.tsx";
import { LocatorEditor } from "../widgets/locator.tsx";
import { LongTextEditor } from "../widgets/longtext.tsx";
import { MarkdownEditor } from "../widgets/markdown.tsx";
import { NumberEditor } from "../widgets/number.tsx";
import { ObjectEditor } from "../widgets/object.tsx";
import { ScalarEditor } from "../widgets/scalar.tsx";
import { TableEditor } from "../widgets/table.tsx";
import { TagsEditor } from "../widgets/tags.tsx";
import { TextEditor } from "../widgets/text.tsx";
import { UrlEditor } from "../widgets/url.tsx";

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

const EDITORS: Record<string, Widget["Editor"]> = {
  text: TextEditor,
  longtext: LongTextEditor,
  markdown: MarkdownEditor,
  url: UrlEditor,
  date: DateEditor,
  color: ColorEditor,
  locator: LocatorEditor,
  blob: BlobEditor,
  number: NumberEditor,
  integer: NumberEditor,
  boolean: BooleanEditor,
  enum: EnumEditor,
  tags: TagsEditor,
  table: TableEditor,
};

function BoundList(props: WidgetProps) {
  return <ListEditor {...props} widgetFor={widgetFor} />;
}

function BoundObject(props: WidgetProps) {
  return <ObjectEditor {...props} widgetFor={widgetFor} />;
}

export function widgetFor(schema: JsonSchema): Widget {
  const kind = widgetKind(schema);
  const Editor =
    kind === "text" && schema.anyOf?.length
      ? ScalarEditor
      : kind === "list"
        ? BoundList
        : kind === "object"
          ? BoundObject
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
