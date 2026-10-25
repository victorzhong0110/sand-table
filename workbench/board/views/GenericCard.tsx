import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "../Icon.tsx";
import { imageDataUrl, summaryLines, type TypeSpecView } from "./format.ts";
import { UnknownType } from "./UnknownType.tsx";

type ToolCall = (
  name: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

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
  call,
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
  call?: ToolCall;
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
      {cover && coverBlob ? (
        <figure className="card-cover">
          <CoverImage sha={coverBlob} call={call} />
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

function CoverImage({ sha, call }: { sha: string; call?: ToolCall }) {
  const [src, setSrc] = useState("");
  const [failed, setFailed] = useState(false);
  const callRef = useRef(call);
  callRef.current = call;
  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    setSrc("");
    const read = callRef.current;
    if (!read) {
      setFailed(true);
      return;
    }
    void read("sand_read_asset", { assetId: sha })
      .then((asset) => {
        if (cancelled) return;
        const dataUrl =
          asset &&
          typeof asset === "object" &&
          "dataUrl" in asset &&
          typeof asset.dataUrl === "string"
            ? asset.dataUrl
            : "";
        const image = imageDataUrl(dataUrl);
        if (!image) {
          setFailed(true);
          return;
        }
        setSrc(image);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [sha]);
  if (failed)
    return (
      <span className="card-cover-mark">封面读不出来。请确认附件还在。</span>
    );
  if (!src) return <span className="card-cover-mark">正在读取封面</span>;
  return <img className="card-cover-image" alt="封面" src={src} />;
}
