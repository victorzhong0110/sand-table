import { useEffect, useMemo, useRef, useState } from "react";
import type { BindingItem } from "../../kernel/index.ts";
import { useTypeCatalog } from "../views/catalog.tsx";
import type { ViewProps } from "../views/registry.tsx";
import { timelineFields } from "./fields.ts";
import {
  axisLabel,
  axisPosition,
  layoutTimeline,
  timelineTicks,
  type Dimension,
  type Placement,
} from "./scale.ts";

function keyOf({ kind, field }: Dimension) {
  return JSON.stringify([kind, field]);
}

export function TimelineView({
  object,
  bindings,
  dispatch,
  actions,
  timeline,
  readOnly,
}: ViewProps) {
  const catalog = useTypeCatalog();
  const [items, setItems] = useState<BindingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState("");
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const [zoom, setZoom] = useState(1);
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; scroll: number } | undefined>(
    undefined,
  );
  const dimension = object.data.dimension as Dimension | undefined;
  const tracks = object.data.tracks === "none" ? "none" : "type";
  useEffect(() => {
    let active = true;
    let serial = 0;
    async function refresh() {
      const token = ++serial;
      try {
        const result = await bindings.read("items", { limit: 200 });
        if (!active || token !== serial) return;
        setItems(result.items);
        setReadError(
          result.nextCursor ? "这里只显示前 200 个条目，请缩小范围。" : "",
        );
      } catch (error) {
        if (active && token === serial)
          setReadError(
            error instanceof Error ? error.message : "无法读取时间条目。",
          );
      } finally {
        if (active && token === serial) setLoading(false);
      }
    }
    const stop = bindings.subscribe("items", () => void refresh());
    void refresh();
    return () => {
      active = false;
      stop();
    };
  }, [bindings]);
  const choices = useMemo(() => {
    const types = [...new Set(items.map(({ type }) => type))];
    const values = (
      types.length
        ? types.map((type) => catalog.specs.get(type))
        : [...catalog.specs.values()]
    ).flatMap(timelineFields);
    const options = new Map(values.map((entry) => [keyOf(entry), entry]));
    if (dimension && !options.has(keyOf(dimension)))
      options.set(keyOf(dimension), dimension);
    return options;
  }, [catalog, items, dimension]);
  const layout = dimension ? layoutTimeline(items, dimension) : undefined;
  const lanes = new Map<string, Placement[]>();
  for (const row of layout?.placed ?? []) {
    const key = tracks === "type" ? row.item.type : "";
    const lane = lanes.get(key);
    if (lane) lane.push(row);
    else lanes.set(key, [row]);
  }
  async function save(set: Record<string, unknown>, unset: string[] = []) {
    if (readOnly || pending) return;
    setPending(true);
    setMessage("");
    try {
      await dispatch([
        {
          op: "object.update",
          id: object.id,
          expectedVersion: object.version,
          set,
          unset,
        },
      ]);
    } catch (reason) {
      setMessage(
        reason instanceof Error ? reason.message : "时间轴设置未保存。",
      );
    } finally {
      setPending(false);
    }
  }
  async function add() {
    if (!timeline || pending) return;
    setPending(true);
    try {
      const count = await timeline.addFromBoard(dimension);
      setMessage(
        count ? `已添加 ${count} 个条目。` : "当前白板没有可添加的新条目。",
      );
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "添加条目失败。");
    } finally {
      setPending(false);
    }
  }
  const locate = (id: string) =>
    void actions.focusObject("items", id).catch((reason: unknown) => {
      setMessage(reason instanceof Error ? reason.message : "该条目无法打开。");
    });
  return (
    <section
      aria-label="时间轴"
      className="nodrag nopan nowheel"
      style={{ overflow: "auto", maxHeight: 330 }}
    >
      {!readOnly && (
        <div>
          {timeline && (
            <button type="button" disabled={pending} onClick={() => void add()}>
              从白板添加
            </button>
          )}
          <label>
            时间维度
            <select
              aria-label="时间维度"
              disabled={pending}
              value={dimension ? keyOf(dimension) : ""}
              onChange={(event) => {
                const next = choices.get(event.target.value);
                void save(
                  next ? { dimension: next } : {},
                  next ? [] : ["dimension"],
                );
              }}
            >
              <option value="">选择时间字段</option>
              {[...choices].map(([key, { label, kind }]) => (
                <option key={key} value={key}>
                  {label}
                  {kind === "date" ? "（日期）" : ""}
                </option>
              ))}
            </select>
          </label>
          {dimension && (
            <label>
              区间结束
              <select
                aria-label="区间结束字段"
                disabled={pending}
                value={dimension.endField ?? ""}
                onChange={(event) => {
                  const { endField: _, ...start } = dimension;
                  const endField = event.target.value;
                  void save({
                    dimension: endField ? { ...start, endField } : start,
                  });
                }}
              >
                <option value="">仅时间点</option>
                {[...choices.values()]
                  .filter(
                    (entry) =>
                      entry.kind === dimension.kind &&
                      entry.field !== dimension.field,
                  )
                  .map(({ field, label }) => (
                    <option key={field} value={field}>
                      {label}
                    </option>
                  ))}
              </select>
            </label>
          )}
        </div>
      )}
      {loading && <p role="status">正在读取条目…</p>}
      {readError && <p role="status">{readError}</p>}
      {message && <p role="status">{message}</p>}
      {!loading && !dimension && <p>请选择时间维度。</p>}
      {dimension && layout && (
        <div>
          <p>{dimension.label}</p>
          <div
            ref={viewport}
            aria-label="时间轴横向视图"
            className="nodrag nopan nowheel"
            style={{
              overflowX: "auto",
              overflowY: "hidden",
              touchAction: "pan-y",
            }}
            onWheel={(event) =>
              setZoom((value) =>
                Math.max(
                  1,
                  Math.min(8, value * (event.deltaY < 0 ? 1.15 : 1 / 1.15)),
                ),
              )
            }
            onPointerDown={(event) => {
              if ((event.target as HTMLElement).closest("button")) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              drag.current = {
                id: event.pointerId,
                x: event.clientX,
                scroll: event.currentTarget.scrollLeft,
              };
            }}
            onPointerMove={(event) => {
              if (drag.current?.id === event.pointerId)
                event.currentTarget.scrollLeft =
                  drag.current.scroll + drag.current.x - event.clientX;
            }}
            onLostPointerCapture={() => {
              drag.current = undefined;
            }}
          >
            {layout.placed.length > 0 && (
              <div
                style={{
                  minWidth: `${zoom * 100}%`,
                  boxSizing: "border-box",
                  paddingInline: "14px 135px",
                }}
              >
                <div
                  style={{
                    position: "relative",
                    height: 32,
                    borderBottom: "1px solid var(--line)",
                  }}
                >
                  {timelineTicks(layout.low, layout.high, dimension.kind).map(
                    (tick) => (
                      <span
                        key={tick}
                        style={{
                          position: "absolute",
                          left: `${axisPosition(tick, layout.low, layout.high) * 100}%`,
                          whiteSpace: "nowrap",
                        }}
                      >
                        {axisLabel(tick, dimension.kind)}
                      </span>
                    ),
                  )}
                </div>
                {[...lanes].map(([id, rows]) => (
                  <div
                    key={id}
                    aria-label={catalog.specs.get(id)?.title ?? "时间条目"}
                  >
                    {id && (
                      <strong>{catalog.specs.get(id)?.title ?? id}</strong>
                    )}
                    <ol
                      aria-label="按时间排序的条目"
                      style={{ padding: 0, margin: 0 }}
                    >
                      {rows.map(({ item, start, end }) => {
                        const left = axisPosition(
                          start,
                          layout.low,
                          layout.high,
                        );
                        const width =
                          end === undefined
                            ? 0
                            : axisPosition(end, layout.low, layout.high) - left;
                        return (
                          <li
                            key={item.id}
                            style={{
                              position: "relative",
                              height: 31,
                              listStyle: "none",
                            }}
                          >
                            {width > 0 && (
                              <span
                                aria-hidden="true"
                                style={{
                                  position: "absolute",
                                  left: `${left * 100}%`,
                                  width: `${width * 100}%`,
                                  height: 2,
                                  top: 15,
                                  background: "var(--accent)",
                                }}
                              />
                            )}
                            <button
                              type="button"
                              title={
                                end === undefined
                                  ? axisLabel(start, dimension.kind)
                                  : `${axisLabel(start, dimension.kind)} 至 ${axisLabel(end, dimension.kind)}`
                              }
                              style={{
                                position: "absolute",
                                left: `${left * 100}%`,
                                whiteSpace: "nowrap",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                maxWidth: 134,
                              }}
                              onClick={() => locate(item.id)}
                            >
                              {item.title}
                              {typeof item.data.storyTime === "string" &&
                                item.data.storyTime && (
                                  <span> · {item.data.storyTime}</span>
                                )}
                            </button>
                          </li>
                        );
                      })}
                    </ol>
                  </div>
                ))}
              </div>
            )}
          </div>
          {layout.unsorted.length > 0 && (
            <section aria-label="未排序">
              <strong>未排序</strong>
              <ul>
                {layout.unsorted.map(({ item, reason }) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => locate(item.id)}
                      disabled={Boolean(item.unavailable)}
                    >
                      {item.title}
                    </button>{" "}
                    {reason}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </section>
  );
}
