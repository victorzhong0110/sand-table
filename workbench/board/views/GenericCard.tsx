import type { ReactNode } from "react";
import { Icon } from "../Icon.tsx";
import { summaryLines, type TypeSpecView } from "./format.ts";
import { UnknownType } from "./UnknownType.tsx";

export function GenericCard({
  title,
  kernelType,
  data,
  spec,
  detail,
  packTitle,
  catalogReady,
  relationLabels,
  coverBlob,
  editor,
  editingField,
  onEnter,
}: {
  title: string;
  kernelType: string;
  data: Record<string, unknown>;
  spec: TypeSpecView | undefined;
  detail: "full" | "label" | "icon";
  packTitle: string;
  catalogReady: boolean;
  relationLabels: { key: string; label: string; titles: string[] }[];
  coverBlob?: string;
  editor?: ReactNode;
  editingField?: "title" | "text";
  onEnter?: () => void;
}) {
  if (!catalogReady) return editor ?? <strong>{title}</strong>;
  if (!spec)
    return (
      <UnknownType
        title={title}
        typeName={kernelType}
        packTitle={packTitle}
        data={data}
        readOnly
      />
    );
  if (detail === "icon") return null;
  if (detail === "label")
    return editor && editingField === "title" ? (
      editor
    ) : (
      <strong>{title}</strong>
    );
  const lines = summaryLines(
    data,
    spec.display?.summary,
    spec.schema?.properties,
  );
  const cover = spec.capabilities?.cover === true && coverBlob;
  return (
    <div
      className={`generic-card material-${spec.display?.material ?? "paper"}`}
    >
      {cover ? (
        <figure className="card-cover">
          <span className="card-cover-mark">封面</span>
          {editingField === "title" && editor ? (
            editor
          ) : (
            <strong>{title}</strong>
          )}
        </figure>
      ) : editingField === "title" && editor ? (
        editor
      ) : (
        <strong>{title}</strong>
      )}
      {editingField === "text" && editor
        ? editor
        : lines.map((line) => (
            <p
              key={line.key}
              className={`summary-line${line.key === "body" || line.key === "text" ? " component-text" : ""}`}
            >
              {line.label} {line.text}
            </p>
          ))}
      {relationLabels.map((slot) =>
        slot.titles.length ? (
          <p key={slot.key} className="summary-line">
            {slot.label} {slot.titles.join("、")}
          </p>
        ) : null,
      )}
      {spec.capabilities?.container && onEnter && (
        <button
          type="button"
          className="nodrag nopan"
          onClick={(event) => {
            event.stopPropagation();
            onEnter();
          }}
        >
          进入白板
        </button>
      )}
      <span className="card-type">
        <Icon name={spec.icon || "board"} size={14} /> {spec.title}
      </span>
    </div>
  );
}
