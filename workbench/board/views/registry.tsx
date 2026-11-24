import { createContext, useContext, type JSX } from "react";
import type {
  Command,
  CommandResult,
  MigratedObjectRow,
  ExpandedBindings,
  GraphNode,
  PresentationRow,
  TypeSpec,
} from "../../kernel/index.ts";
import type { V3Store, V3Tool } from "../data-client/store.ts";
import type { Bindings } from "./bindings.ts";
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
import { FilterView } from "../data/FilterView.tsx";
import { MetricView } from "../data/MetricView.tsx";
import { ChartView } from "../data/ChartView.tsx";
import { TableView } from "../data/TableView.tsx";
import { RelationGraphView } from "../graph/GraphView.tsx";
import { TimelineView } from "../timeline/TimelineView.tsx";
import type { Dimension } from "../timeline/scale.ts";
import { CompareComponent } from "../compare/CompareComponent.tsx";
import { MediaComponent, LinkComponent } from "../media/MediaComponent.tsx";
import type { DownloadFile } from "../media/host.ts";
import type { TableData } from "../data/table-model.ts";

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
  workspaceId: string;
  object: MigratedObjectRow;
  spec: TypeSpec;
  presentation: PresentationRow;
  detail: "full" | "label" | "icon";
  readOnly: boolean;
  dispatch: (
    commands: Command[],
    options?: { intentId?: string },
  ) => Promise<CommandResult>;
  bindings: Bindings;
  timeline?: { addFromBoard(dimension?: Dimension): Promise<number> };
  graph?: {
    read(): Promise<ExpandedBindings>;
    subscribe(onChange: () => void): () => void;
    locate(id: string): Promise<GraphNode | null>;
    addCenter(id: string): Promise<void>;
  };
  tableFiles?: {
    create(title: string, table: TableData): Promise<void>;
    download?(filename: string, text: string): Promise<void>;
  };
  actions: {
    focusObject(slot: string, targetId: string): Promise<void>;
    openObjectPicker(
      slot: string,
      text?: string,
    ): Promise<{ id: string; title: string; type: string }[]>;
    createLinkedComponent(
      slot: string,
      input: {
        type: string;
        title: string;
        expectedVersion: number;
      },
    ): Promise<CommandResult>;
  };
};

export const ViewRuntimeContext = createContext<{
  store: V3Store;
  call: V3Tool;
  focusObject?: (objectId: string) => Promise<boolean>;
  downloadFile?: DownloadFile;
  openLink?: (url: string) => void;
} | null>(null);
export function useViewRuntime() {
  return useContext(ViewRuntimeContext);
}

export const customViews: Record<string, (props: ViewProps) => JSX.Element> = {
  table: TableView,
  chart: ChartView,
  filter: FilterView,
  metric: MetricView,
  "relation-graph": RelationGraphView,
  timeline: TimelineView,
  comparison: CompareComponent,
  media: MediaComponent,
  link: LinkComponent,
};

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
