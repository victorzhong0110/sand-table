import { useEffect, useRef, useState } from "react";
import type { Board } from "../core/model.ts";
import { Icon } from "./Icon.tsx";
import { componentTypes, displayRect, material } from "../core/spaces.ts";
import type { Camera, ComponentInstance, Rect } from "../core/spaces.ts";
import { ComponentRenderer } from "./ComponentRenderer.tsx";
import { peekContent } from "../core/content.ts";
type Props = {
  board: Board;
  viewId: string;
  mode: string;
  query: string;
  kind: string;
  scope: string;
  arrows: boolean;
  busy: boolean;
  operate: (op: any) => Promise<any>;
  call: (name: string, args?: Record<string, unknown>) => Promise<any>;
  onOpenLink: (url: string) => void;
  clearFilters: () => void;
};
export function SpaceCanvas({
  board: b,
  viewId,
  mode,
  query,
  kind,
  scope,
  arrows,
  busy,
  operate,
  call,
  onOpenLink,
  clearFilters,
}: Props) {
  const view = b.views[viewId],
    canvas = useRef<HTMLElement>(null);
  const [camera, setCamera] = useState<Camera>({ x: 24, y: 24, zoom: 1 }),
    [draft, setDraft] = useState<Record<string, Rect>>({});
  const live = useRef({ camera, draft });
  live.current = { camera, draft };
  const drag = useRef<
    | {
        id?: string;
        resize?: boolean;
        x: number;
        y: number;
        rect?: Rect;
        base: Camera;
        startX?: number;
        startY?: number;
        lasso?: boolean;
      }
    | undefined
  >(undefined);
  const [lasso, setLasso] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
  }>();
  useEffect(() => {
    if (view) setCamera(view.camera);
  }, [view?.spaceId]);
  const focusedGuide = b.guides.find((g) => g.id === b.guideFocus?.guideId);
  const routeIds = new Set(
    focusedGuide?.steps.flatMap((s) => s.objectIds) || [],
  );
  const matches = (c: ComponentInstance) => {
    const o = b.objects.find((o) => o.id === c.objectId);
    // 绑定了内容对象的组件：搜索用对象里的实际内容。
    const resolved = peekContent(c, b.contentObjects);
    return (
      c.spaceId === view?.spaceId &&
      (!o || kind === "all" || o.kind === kind) &&
      (scope === "all" || !o || o.workspaceId === scope) &&
      `${resolved.title} ${o?.source?.path || ""} ${c.type === "text" ? String(resolved.data.text) : ""}`
        .toLowerCase()
        .includes(query.toLowerCase())
    );
  };
  const filtered = b.instances.filter(matches);
  const fit = (instances: ComponentInstance[]) => {
    if (!instances.length || !canvas.current) return;
    const x = Math.min(...instances.map((c) => c.rect.x)),
      y = Math.min(...instances.map((c) => c.rect.y)),
      right = Math.max(
        ...instances.map((c) => c.rect.x + displayRect(c).width),
      ),
      bottom = Math.max(
        ...instances.map((c) => c.rect.y + displayRect(c).height),
      );
    const w = canvas.current.clientWidth,
      h = canvas.current.clientHeight;
    const zoom = Math.min(
      1,
      Math.max(
        0.05,
        Math.min((w - 70) / (right - x), (h - 120) / (bottom - y)),
      ),
    );
    const next = {
      x: w / 2 - ((x + right) * zoom) / 2,
      y: (h - 40) / 2 - ((y + bottom) * zoom) / 2,
      zoom,
    };
    setCamera(next);
    void operate({ kind: "camera", camera: next });
  };
  const guideKey = b.guideFocus
    ? `${b.guideFocus.guideId}:${b.guideFocus.step}`
    : "";
  useEffect(() => {
    if (!view || !guideKey) return;
    clearFilters();
    fit(
      b.instances.filter(
        (c) =>
          c.spaceId === view.spaceId && c.objectId && routeIds.has(c.objectId),
      ),
    );
  }, [guideKey, view?.spaceId]);
  useEffect(() => {
    if (!view || !query.trim() || !filtered.length) return;
    const timer = setTimeout(() => fit(filtered.slice(0, 30)), 160);
    return () => clearTimeout(timer);
  }, [query, kind, scope, view?.spaceId]);
  useEffect(() => {
    if (!view?.selection.length || !canvas.current) return;
    const selected = b.instances.filter(
      (c) => view.selection.includes(c.id) && c.spaceId === view.spaceId,
    );
    if (!selected.length) return;
    const c = selected.at(-1)!,
      r = displayRect(c),
      w = canvas.current.clientWidth,
      h = canvas.current.clientHeight;
    if (
      r.x * camera.zoom + camera.x < 0 ||
      (r.x + r.width) * camera.zoom + camera.x > w ||
      r.y * camera.zoom + camera.y < 0 ||
      (r.y + r.height) * camera.zoom + camera.y > h
    )
      fit(selected);
  }, [view?.selection.join("|")]);
  const navigate = (spaceId: unknown) => {
    clearFilters();
    return operate({ kind: "navigate", spaceId });
  };
  if (!view)
    return (
      <section className="canvas">
        <p>正在打开视图…</p>
      </section>
    );
  const visible = filtered.filter((c) => {
    const r = displayRect(c, draft[c.id] || c.rect);
    const w = canvas.current?.clientWidth || 900,
      h = canvas.current?.clientHeight || 660;
    return (
      view.selection.includes(c.id) ||
      ((r.x + r.width) * camera.zoom + camera.x > -100 &&
        r.x * camera.zoom + camera.x < w + 100 &&
        (r.y + r.height) * camera.zoom + camera.y > -100 &&
        r.y * camera.zoom + camera.y < h + 100)
    );
  });
  const ids = new Set(visible.map((c) => c.id));
  const links = b.spaceLinks
    .filter((l) => ids.has(l.source) && ids.has(l.target))
    .map((l) => ({
      source: l.source,
      target: l.target,
      label: {
        related: "相关",
        "depends-on": "依赖",
        supports: "支持",
        compares: "比较",
        "belongs-to": "从属",
      }[l.kind],
    }));
  if (arrows)
    for (const r of b.relations) {
      const sources = visible.filter((c) => c.objectId === r.source),
        targets = visible.filter((c) => c.objectId === r.target);
      for (const from of sources)
        for (const to of targets)
          if (
            !focusedGuide ||
            (routeIds.has(r.source) && routeIds.has(r.target))
          )
            links.push({
              source: from.id,
              target: to.id,
              label: {
                contains: "包含",
                imports: "导入",
                "syntactic-call": "可能调用（语法推断）",
              }[r.kind],
            });
    }
  const select = (id: string, shift = false) =>
    operate({
      kind: "select",
      ids: shift
        ? view.selection.includes(id)
          ? view.selection.filter((i) => i !== id)
          : [...view.selection, id]
        : [id],
    });
  const parents = [];
  let space = b.spaces.find((s) => s.id === view.spaceId);
  while (space && parents.length < b.spaces.length) {
    parents.unshift(space);
    space = b.spaces.find((s) => s.id === space?.parentId);
  }
  return (
    <div className="space-shell">
      <nav className="breadcrumbs" aria-label="白板路径">
        {parents.map((s) => (
          <button key={s.id} onClick={() => void navigate(s.id)}>
            {s.title}
          </button>
        ))}
        <span>
          {filtered.length} 个组件 · 本视图选中 {view.selection.length}
        </span>
      </nav>
      <section
        ref={canvas}
        className="canvas"
        aria-label="项目白板"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("application/x-sand-component")) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
          }
        }}
        onDrop={(e) => {
          const raw = e.dataTransfer.getData("application/x-sand-component");
          if (!raw) return;
          e.preventDefault();
          try {
            const item = JSON.parse(raw);
            if (typeof item.type !== "string" || typeof item.title !== "string")
              return;
            const size = componentTypes.find((c) => c.type === item.type);
            const box = e.currentTarget.getBoundingClientRect();
            const worldTop =
              (e.currentTarget.querySelector(".world") as HTMLElement)
                ?.offsetTop || 0;
            void operate({
              kind: "create",
              type: item.type,
              title: item.title,
              data: item.data || {},
              ...(item.objectId ? { objectId: item.objectId } : {}),
              rect: {
                x: (e.clientX - box.left - camera.x) / camera.zoom,
                y: (e.clientY - box.top - worldTop - camera.y) / camera.zoom,
                width: size?.width || 280,
                height: size?.height || 180,
                pinned: false,
              },
            });
            clearFilters();
          } catch {}
        }}
        onPointerDown={(e) => {
          if (e.target !== e.currentTarget) return;
          drag.current = {
            x: e.clientX,
            y: e.clientY,
            base: camera,
            lasso: e.shiftKey,
            startX: e.nativeEvent.offsetX,
            startY: e.nativeEvent.offsetY,
          };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const dx = e.clientX - d.x,
            dy = e.clientY - d.y;
          if (d.id && d.rect)
            setDraft({
              [d.id]: d.resize
                ? {
                    ...d.rect,
                    width: Math.min(
                      2000,
                      Math.max(120, d.rect.width + dx / camera.zoom),
                    ),
                    height: Math.min(
                      1600,
                      Math.max(70, d.rect.height + dy / camera.zoom),
                    ),
                  }
                : {
                    ...d.rect,
                    x: d.rect.x + dx / camera.zoom,
                    y: d.rect.y + dy / camera.zoom,
                  },
            });
          else if (d.lasso)
            setLasso({
              x: Math.min(d.startX!, d.startX! + dx),
              y: Math.min(d.startY!, d.startY! + dy),
              width: Math.abs(dx),
              height: Math.abs(dy),
            });
          else setCamera({ ...d.base, x: d.base.x + dx, y: d.base.y + dy });
        }}
        onPointerUp={() => {
          const d = drag.current;
          drag.current = undefined;
          if (d?.id) {
            const rect = live.current.draft[d.id];
            if (rect)
              void operate({ kind: "place", items: [{ id: d.id, rect }] }).then(
                () => setDraft({}),
              );
          } else if (d?.lasso && lasso) {
            const l = lasso;
            const picked = filtered.filter((c) => {
              const r = displayRect(c);
              const x = r.x * camera.zoom + camera.x,
                y = r.y * camera.zoom + camera.y + 36;
              return (
                x < l.x + l.width &&
                x + r.width * camera.zoom > l.x &&
                y < l.y + l.height &&
                y + r.height * camera.zoom > l.y
              );
            });
            void operate({ kind: "select", ids: picked.map((c) => c.id) });
            setLasso(undefined);
          } else if (d) {
            if (
              Math.abs(live.current.camera.x - d.base.x) +
                Math.abs(live.current.camera.y - d.base.y) <
              4
            )
              void operate({ kind: "select", ids: [] });
            else void operate({ kind: "camera", camera: live.current.camera });
          }
        }}
      >
        <div className="canvas-hint">
          {focusedGuide
            ? "功能路径定位 · 其他对象淡化"
            : mode === "arrange"
              ? "拖动／右下角调整大小 · 双击选择 · Alt+方向键调整大小"
              : "点击查看 · Shift 多选或框选 · 拖动空白平移"}
        </div>
        <div
          className="world"
          style={{
            transform: `translate(${camera.x}px,${camera.y}px) scale(${camera.zoom})`,
          }}
        >
          {b.groups.map((g) => {
            const members = filtered.filter((c) =>
              g.instanceIds
                ? g.instanceIds.includes(c.id)
                : c.objectId && g.objectIds.includes(c.objectId),
            );
            if (!members.length) return null;
            const left =
                Math.min(
                  ...members.map(
                    (c) => displayRect(c, draft[c.id] || c.rect).x,
                  ),
                ) - 12,
              top =
                Math.min(
                  ...members.map(
                    (c) => displayRect(c, draft[c.id] || c.rect).y,
                  ),
                ) - 28,
              right =
                Math.max(
                  ...members.map(
                    (c) =>
                      displayRect(c, draft[c.id] || c.rect).x +
                      displayRect(c).width,
                  ),
                ) + 12,
              bottom =
                Math.max(
                  ...members.map(
                    (c) =>
                      displayRect(c, draft[c.id] || c.rect).y +
                      displayRect(c).height,
                  ),
                ) + 12;
            return (
              <div
                key={g.id}
                className="group"
                style={{ left, top, width: right - left, height: bottom - top }}
              >
                <span>{g.title} · 阅读分组</span>
              </div>
            );
          })}
          {arrows && (
            <svg className="edges">
              <defs>
                <marker
                  id="space-arrow"
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto"
                >
                  <path d="M0 0L10 5L0 10z" />
                </marker>
              </defs>
              {links.slice(0, 500).map((link, index) => {
                const a =
                    draft[link.source] ||
                    displayRect(b.instances.find((c) => c.id === link.source)!),
                  z =
                    draft[link.target] ||
                    displayRect(b.instances.find((c) => c.id === link.target)!);
                const ax = a.x + a.width / 2,
                  ay = a.y + a.height / 2,
                  bx = z.x + z.width / 2,
                  by = z.y + z.height / 2,
                  dx = bx - ax,
                  dy = by - ay;
                const sr =
                    1 /
                    Math.max(
                      Math.abs(dx) / (a.width / 2 + 6),
                      Math.abs(dy) / (a.height / 2 + 6),
                      1,
                    ),
                  tr =
                    1 /
                    Math.max(
                      Math.abs(dx) / (z.width / 2 + 6),
                      Math.abs(dy) / (z.height / 2 + 6),
                      1,
                    );
                return (
                  <g key={index}>
                    <path
                      d={`M${ax + dx * sr} ${ay + dy * sr} L${bx - dx * tr} ${by - dy * tr}`}
                      markerEnd="url(#space-arrow)"
                    />
                    <text x={(ax + bx) / 2} y={(ay + by) / 2 - 6}>
                      {link.label}
                    </text>
                  </g>
                );
              })}
            </svg>
          )}
          {visible.map((c) => {
            const r = displayRect(c, draft[c.id] || c.rect);
            return (
              <article
                key={c.id}
                tabIndex={0}
                role="button"
                aria-label={c.title}
                title={[
                  c.title,
                  componentTypes.find((t) => t.type === c.type)?.title ||
                    c.type,
                  String(c.data.text || c.data.description || "").slice(0, 200),
                  c.objectId
                    ? b.objects.find((o) => o.id === c.objectId)?.source?.path
                    : "",
                  c.rect.pinned ? "位置已固定" : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
                data-object-id={c.objectId}
                data-instance-id={c.id}
                className={`card component-card material-${material(c.type)} detail-${c.appearance?.detail || "full"} ${view.selection.includes(c.id) ? "selected" : ""} ${focusedGuide && c.objectId && !routeIds.has(c.objectId) ? "dimmed" : ""}`}
                style={{
                  left: r.x,
                  top: r.y,
                  width: r.width,
                  height: r.height,
                }}
                onClick={(e) => {
                  if (mode !== "arrange") void select(c.id, e.shiftKey);
                }}
                onDoubleClick={() => {
                  if (c.type === "board" || c.type === "space-link")
                    void navigate(c.data.spaceId);
                  else if (mode === "arrange") void select(c.id);
                }}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget) return;
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    void select(c.id, e.shiftKey);
                  }
                  if (
                    mode === "arrange" &&
                    [
                      "ArrowLeft",
                      "ArrowRight",
                      "ArrowUp",
                      "ArrowDown",
                    ].includes(e.key)
                  ) {
                    e.preventDefault();
                    const d = e.shiftKey ? 30 : 10;
                    if (e.altKey)
                      void operate({
                        kind: "place",
                        items: [
                          {
                            id: c.id,
                            rect: {
                              ...c.rect,
                              width: Math.max(
                                120,
                                c.rect.width +
                                  (e.key === "ArrowLeft"
                                    ? -d
                                    : e.key === "ArrowRight"
                                      ? d
                                      : 0),
                              ),
                              height: Math.max(
                                70,
                                c.rect.height +
                                  (e.key === "ArrowUp"
                                    ? -d
                                    : e.key === "ArrowDown"
                                      ? d
                                      : 0),
                              ),
                            },
                          },
                        ],
                      });
                    else if (!r.pinned)
                      void operate({
                        kind: "place",
                        items: [
                          {
                            id: c.id,
                            rect: {
                              ...c.rect,
                              x:
                                r.x +
                                (e.key === "ArrowLeft"
                                  ? -d
                                  : e.key === "ArrowRight"
                                    ? d
                                    : 0),
                              y:
                                r.y +
                                (e.key === "ArrowUp"
                                  ? -d
                                  : e.key === "ArrowDown"
                                    ? d
                                    : 0),
                            },
                          },
                        ],
                      });
                  }
                }}
                onPointerDown={(e) => {
                  if (
                    mode === "arrange" &&
                    !r.pinned &&
                    (e.target as HTMLElement).closest(
                      "button,input,textarea,a",
                    ) === null
                  ) {
                    e.stopPropagation();
                    drag.current = {
                      id: c.id,
                      x: e.clientX,
                      y: e.clientY,
                      rect: draft[c.id] || c.rect,
                      base: camera,
                    };
                    e.currentTarget.setPointerCapture(e.pointerId);
                  }
                }}
              >
                {b.spaceActivities
                  ?.filter((a) => a.instanceIds.includes(c.id))
                  .slice(0, 1)
                  .map((a) => (
                    <span
                      className="spatial-activity"
                      key={a.agentId}
                      title={a.task + " · " + a.action + " · Agent 自报"}
                    >
                      ●{" "}
                      {a.stale
                        ? "最后已知"
                        : a.state === "running"
                          ? "处理中"
                          : a.state === "done"
                            ? "已完成"
                            : "等待"}{" "}
                      · {a.agentId}
                    </span>
                  ))}
                {r.pinned && <span className="pin-badge">已固定</span>}
                {focusedGuide && c.objectId && routeIds.has(c.objectId) && (
                  <span className="step-badge">
                    步骤{" "}
                    {focusedGuide.steps
                      .flatMap((s, i) =>
                        s.objectIds.includes(c.objectId!) ? [i + 1] : [],
                      )
                      .join("、")}
                  </span>
                )}
                <div className="component-chrome">
                  <span
                    className="component-symbol"
                    title={componentTypes.find((t) => t.type === c.type)?.title}
                  >
                    <Icon name={c.appearance?.icon || c.type} size={20} />
                  </span>
                  {c.appearance?.detail &&
                    c.appearance.detail !== "full" &&
                    c.appearance.detail !== "icon" && (
                      <strong className="collapsed-title">{c.title}</strong>
                    )}
                  <button
                    className="detail-toggle"
                    aria-label={`切换 ${c.title} 展开层级`}
                    title="完整界面 → 图标和标题 → 仅图标"
                    onClick={(e) => {
                      e.stopPropagation();
                      void operate({
                        kind: "update",
                        instanceId: c.id,
                        appearance: {
                          detail:
                            c.appearance?.detail === "icon"
                              ? "full"
                              : c.appearance?.detail === "label"
                                ? "icon"
                                : "label",
                        },
                      });
                    }}
                  >
                    <Icon name="board" size={14} />
                  </button>
                </div>
                {(!c.appearance?.detail || c.appearance.detail === "full") && (
                  <ComponentRenderer
                    instance={c}
                    board={b}
                    call={call}
                    onNavigate={(spaceId) => void navigate(spaceId)}
                    onOpenLink={onOpenLink}
                  />
                )}
                {mode === "arrange" &&
                  (!c.appearance?.detail || c.appearance.detail === "full") && (
                    <button
                      className="resize-handle"
                      aria-label={`调整 ${c.title} 大小`}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        drag.current = {
                          id: c.id,
                          resize: true,
                          x: e.clientX,
                          y: e.clientY,
                          rect: draft[c.id] || c.rect,
                          base: camera,
                        };
                        e.currentTarget.setPointerCapture(e.pointerId);
                      }}
                    >
                      ↘
                    </button>
                  )}
              </article>
            );
          })}
        </div>
        {!filtered.length &&
          (query || b.instances.some((c) => c.spaceId === view.spaceId)) && (
            <p className="empty">
              没有匹配对象。尝试切换到文件或清除筛选，或从组件面板添加内容。
            </p>
          )}
        {lasso && (
          <div
            className="lasso"
            style={{
              left: lasso.x,
              top: lasso.y,
              width: lasso.width,
              height: lasso.height,
            }}
          />
        )}
        <div className="zoom">
          <button
            aria-label="缩小"
            onClick={() => {
              const next = {
                ...camera,
                zoom: Math.max(0.05, camera.zoom - 0.1),
              };
              setCamera(next);
              void operate({ kind: "camera", camera: next });
            }}
          >
            −
          </button>
          <span>{Math.round(camera.zoom * 100)}%</span>
          <button
            aria-label="放大"
            onClick={() => {
              const next = { ...camera, zoom: Math.min(3, camera.zoom + 0.1) };
              setCamera(next);
              void operate({ kind: "camera", camera: next });
            }}
          >
            +
          </button>
          <button onClick={() => fit(filtered)}>适应</button>
          <button
            onClick={() => {
              const next = { x: 24, y: 24, zoom: 1 };
              setCamera(next);
              void operate({ kind: "camera", camera: next });
            }}
          >
            复位
          </button>
        </div>
      </section>
    </div>
  );
}
