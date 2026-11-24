import { useEffect, useMemo, useRef, useState } from "react";
import type { BindingItem } from "../../kernel/index.ts";
import { useComponentRuntime } from "../runtime/resources.ts";
import { useViewRuntime, type ViewProps } from "../views/registry.tsx";
import { imageDataUrl } from "../views/format.ts";
import type { compareBoundTables, compareText, LinePair } from "./diff.ts";
import { useComparisonSide } from "./use-comparison-side.ts";

type Diff = {
  compareBoundTables: typeof compareBoundTables;
  compareText: typeof compareText;
};
const sideNames = { left: "左侧", right: "右侧" } as const;
const plain = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

function textOf(entry?: BindingItem) {
  if (!entry) return;
  switch (entry.type) {
    case "base.note":
    case "novel.chapter":
      return String(entry.data.body ?? "");
    case "base.heading":
    case "base.code_snippet":
      return String(entry.data.text ?? "");
  }
}

function valueOf(value: unknown) {
  return value === undefined
    ? "—"
    : value === null
      ? "空值"
      : typeof value === "string"
        ? value
        : JSON.stringify(value);
}

function isImage(entry: BindingItem) {
  return (
    entry.type === "base.media" && String(entry.data.mime).startsWith("image/")
  );
}

function ComparisonImage({ entry }: { entry: BindingItem }) {
  const runtime = useViewRuntime();
  const read = useRef(runtime?.call);
  read.current = runtime?.call;
  const blob = typeof entry.data.blob === "string" ? entry.data.blob : "";
  const mime = String(entry.data.mime);
  const [error, setError] = useState(false);
  const [src, setSrc] = useState("");
  useEffect(() => {
    if (!read.current || !blob) return;
    let active = true;
    void read
      .current("app_asset", { action: "read", sha256: blob })
      .then((asset) => {
        if (!active) return;
        const data = plain(asset).base64;
        const decoded =
          typeof data === "string"
            ? imageDataUrl(`data:${mime};base64,${data}`)
            : undefined;
        if (decoded) setSrc(decoded);
        else setError(true);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [blob, mime]);
  return src ? (
    <img src={src} alt={String(entry.data.alt || entry.title)} />
  ) : (
    <p role="status">
      {error || !blob ? "这份图片暂时不可读。" : "正在读取图片…"}
    </p>
  );
}

export function CompareView({ bindings, object, actions }: ViewProps) {
  const pins = plain(object.data.pinnedVersions);
  const legacy = plain(object.data.legacy);
  const leftPin = typeof pins.left === "number" ? pins.left : undefined;
  const rightPin = typeof pins.right === "number" ? pins.right : undefined;
  const left = useComparisonSide(bindings, "left", leftPin);
  const right = useComparisonSide(bindings, "right", rightPin);
  const runtime = useComponentRuntime();
  const [diff, setDiff] = useState<Diff>();
  const [problem, setProblem] = useState("");
  const leftEntry = left.error ? undefined : left.entry;
  const rightEntry = right.error ? undefined : right.entry;
  const bothTables =
    leftEntry?.type === "base.table" && rightEntry?.type === "base.table";
  const leftText = textOf(leftEntry);
  const rightText = textOf(rightEntry);
  const bothText = leftText !== undefined && rightText !== undefined;
  const code =
    leftEntry?.type === "base.code_snippet" ||
    rightEntry?.type === "base.code_snippet";
  const needsDiff = bothTables || bothText;
  useEffect(() => {
    if (!needsDiff || diff) return;
    if (!runtime) {
      setProblem("此宿主暂时不能加载差异组件。");
      return;
    }
    const controller = new AbortController();
    void runtime
      .loadComponentResource("compare", controller.signal)
      .then(() => {
        if (controller.signal.aborted) return;
        const installed = (globalThis as { sandTableCompare?: Diff })
          .sandTableCompare;
        if (!installed) throw Error("差异组件未能注册。");
        setDiff(installed);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted)
          setProblem(
            reason instanceof Error ? reason.message : "暂时无法生成差异。",
          );
      });
    return () => controller.abort();
  }, [runtime, needsDiff, diff]);
  const textDiff = useMemo(
    () =>
      diff && leftText !== undefined && rightText !== undefined
        ? diff.compareText(leftText, rightText, !code)
        : undefined,
    [diff, leftText, rightText, code],
  );
  const tableDiff = useMemo(() => {
    if (!diff || !bothTables || !leftEntry || !rightEntry) return;
    return diff.compareBoundTables(leftEntry, rightEntry);
  }, [diff, bothTables, leftEntry, rightEntry]);
  const [tablePage, setTablePage] = useState(0);
  const pages = Math.max(1, Math.ceil((tableDiff?.rows.length ?? 0) / 30));
  const page = Math.min(tablePage, pages - 1);
  const compareFields =
    leftEntry &&
    rightEntry &&
    !bothTables &&
    !bothText &&
    !(isImage(leftEntry) && isImage(rightEntry));
  const keys = compareFields
    ? [
        ...new Set([
          ...Object.keys(leftEntry.data),
          ...Object.keys(rightEntry.data),
        ]),
      ].sort()
    : [];
  function side(slot: "left" | "right") {
    const state = slot === "left" ? left : right;
    const pinned = slot === "left" ? leftPin : rightPin;
    const inline = plain(legacy[slot]);
    const title = state.entry?.title || inline.title;
    return (
      <section aria-label={sideNames[slot]}>
        <strong>
          {sideNames[slot]}
          {typeof title === "string" && title ? ` · ${title}` : ""}
        </strong>
        {state.reading ? (
          <p role="status">正在读取来源…</p>
        ) : state.error ? (
          <p role="status">
            {pinned && `版本 ${pinned} · `}
            {state.error}
          </p>
        ) : state.entry ? (
          <>
            <p>
              版本 {state.entry.version}（{pinned ? "固定" : "当前"}）
            </p>
            <button
              type="button"
              onClick={() =>
                void actions
                  .focusObject(slot, state.entry!.id)
                  .catch((error) =>
                    setProblem(
                      error instanceof Error ? error.message : "无法打开来源。",
                    ),
                  )
              }
            >
              定位来源
            </button>
            {isImage(state.entry) && (
              <ComparisonImage
                key={JSON.stringify([
                  state.entry.id,
                  state.entry.data.blob,
                  state.entry.data.mime,
                ])}
                entry={state.entry}
              />
            )}
            {(!bothText || !textDiff || textDiff.unsupported) &&
              textOf(state.entry) !== undefined && (
                <pre>{textOf(state.entry)}</pre>
              )}
          </>
        ) : typeof inline.text === "string" ? (
          <p>{inline.text}</p>
        ) : (
          <p>请在编辑面板选定来源。</p>
        )}
      </section>
    );
  }
  const line = (row: LinePair, slot: "left" | "right") => {
    const entry = row[slot];
    return (
      <div
        className={`comparison-line ${row.changed ? `comparison-${slot}` : ""}`}
      >
        {code && entry && <span aria-label="行号">{entry.number} </span>}
        {entry?.pieces
          ? entry.pieces.map(({ text, changed }, index) =>
              changed ? (
                <mark key={index}>{text}</mark>
              ) : (
                <span key={index}>{text}</span>
              ),
            )
          : entry?.text || " "}
      </div>
    );
  };
  return (
    <section className="comparison-card nodrag nowheel nopan" aria-label="比较">
      <div className="comparison-columns">
        {side("left")}
        {side("right")}
      </div>
      {problem && <p role="status">{problem}</p>}
      {needsDiff && !diff && !problem && <p role="status">正在生成差异…</p>}
      {textDiff?.unsupported && <p role="status">{textDiff.unsupported}</p>}
      {textDiff && !textDiff.unsupported && (
        <div aria-label="逐行差异">
          {textDiff.rows.map((row, index) => (
            <div className="comparison-columns" key={index}>
              {line(row, "left")}
              {line(row, "right")}
            </div>
          ))}
        </div>
      )}
      {tableDiff && (
        <>
          <table aria-label="单元格差异">
            <thead>
              <tr>
                <th scope="col">行</th>
                {tableDiff.columns.map((column) => (
                  <th scope="col" key={column.key}>
                    {column.changed
                      ? `${column.left?.label ?? "—"} → ${column.right?.label ?? "—"}`
                      : column.left?.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tableDiff.rows.slice(page * 30, (page + 1) * 30).map((row) => (
                <tr key={row.key}>
                  <th scope="row">
                    {row.key}
                    {row.presence === "added"
                      ? " · 新增"
                      : row.presence === "removed"
                        ? " · 删除"
                        : ""}
                  </th>
                  {row.cells.map((cell) => (
                    <td key={cell.key}>
                      {cell.changed ? (
                        <>
                          <del>{valueOf(cell.left)}</del>
                          {" → "}
                          <ins>{valueOf(cell.right)}</ins>
                        </>
                      ) : (
                        valueOf(cell.left)
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {pages > 1 && (
            <nav aria-label="表格差异分页">
              <button
                type="button"
                disabled={!page}
                onClick={() => setTablePage(page - 1)}
              >
                上一页
              </button>
              <span>
                {page + 1} / {pages}
              </span>
              <button
                type="button"
                disabled={page + 1 >= pages}
                onClick={() => setTablePage(page + 1)}
              >
                下一页
              </button>
            </nav>
          )}
        </>
      )}
      {keys.length > 0 && (
        <dl aria-label="字段差异">
          {keys.flatMap((key) => {
            const a = valueOf(leftEntry?.data[key]);
            const b = valueOf(rightEntry?.data[key]);
            return a === b
              ? []
              : [
                  <dt key={`${key}-field`}>{key}</dt>,
                  <dd key={`${key}-delta`} className="comparison-columns">
                    <del>{a}</del>
                    <ins>{b}</ins>
                  </dd>,
                ];
          })}
        </dl>
      )}
      {typeof object.data.conclusion === "string" && object.data.conclusion && (
        <p>{object.data.conclusion}</p>
      )}
    </section>
  );
}
