import React, { useState, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { useApp } from "@modelcontextprotocol/ext-apps/react";
import type { Board, Placement, Item, GuideFocus } from "../core/model.ts";
import "./style.css";
import { GuidePanel } from "./GuidePanel.tsx";
const relationLabels = {
  contains: "包含",
  imports: "导入",
  "syntactic-call": "可能调用（语法推断）",
};
function unpack(r: any) {
  if (r.isError) throw Error(r.content?.[0]?.text || "Request failed");
  return r.structuredContent?.data ?? JSON.parse(r.content[0].text);
}
function Workbench() {
  const [board, setBoard] = useState<Board>(),
    [error, setError] = useState(""),
    [ended, setEnded] = useState(false),
    [busy, setBusy] = useState(false);
  const [theme, setTheme] = useState("paper"),
    [mode, setMode] = useState("browse"),
    [query, setQuery] = useState(""),
    [scope, setScope] = useState("all"),
    [kind, setKind] = useState("symbol"),
    [arrows, setArrows] = useState(false),
    [source, setSource] = useState<{
      objectId: string;
      hash: string;
      text: string;
      startLine: number;
      endLine: number;
      nextLine: number | null;
    }>(),
    [note, setNote] = useState(""),
    [groupTitle, setGroupTitle] = useState(""),
    [zoom, setZoom] = useState(1),
    [pan, setPan] = useState({ x: 24, y: 24 }),
    [draft, setDraft] = useState<Record<string, Placement>>({});
  const canvasRef = useRef<HTMLElement>(null);
  const boardRef = useRef(board);
  boardRef.current = board;
  const drag = useRef<
    | { id?: string; x: number; y: number; base: Placement; moving: boolean }
    | undefined
  >(undefined);
  const { app, error: connectionError } = useApp({
    appInfo: { name: "Sand Table", version: "0.1.0" },
    capabilities: {},
    onAppCreated: (a) => {
      a.ontoolresult = (r) => {
        try {
          const data = unpack(r);
          if (data.objects) setBoard(data);
        } catch (e) {
          setError(String(e));
        }
      };
    },
  });
  async function call(name: string, args: Record<string, unknown> = {}) {
    if (!app) throw Error("尚未连接宿主");
    return unpack(
      await app.callServerTool({
        name,
        arguments: { boardId: boardRef.current?.id, ...args },
      }),
    );
  }
  async function action(name: string, args: Record<string, unknown> = {}) {
    setBusy(true);
    setError("");
    try {
      const data = await call(name, args);
      if (data.objects) setBoard(data);
      return data;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      if (name === "sand_edit_view")
        try {
          setBoard(await call("sand_read_board"));
        } catch {}
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  function edit(data: Record<string, unknown>) {
    return action("sand_edit_view", {
      revision: boardRef.current?.revision,
      ...data,
    });
  }
  async function readSource(object: Item, startLine?: number) {
    const result = await action("sand_read_source", {
      objectId: object.id,
      startLine,
    });
    if (result)
      setSource({
        objectId: object.id,
        hash: result.reference.hash,
        text:
          result.text +
          (result.characterTruncated
            ? "\n… 本段超出 12,000 字符，请缩小读取行数"
            : ""),
        startLine: result.reference.startLine,
        endLine: result.reference.endLine,
        nextLine: result.nextLine,
      });
  }
  async function focusGuide(focus: GuideFocus | null) {
    const updated: Board | undefined = await edit({ guideFocus: focus });
    if (!updated || !focus) return;
    setMode("browse");
    setKind("all");
    setScope("all");
    setQuery("");
    setArrows(true);
    const objects = updated.objects.filter((o) => o.kind !== "workspace");
    const routeIds = new Set(
      updated.guides
        .find((g) => g.id === focus.guideId)!
        .steps.flatMap((s) => s.objectIds),
    );
    const points = objects.flatMap((o, i) =>
      routeIds.has(o.id)
        ? [
            updated.placements[o.id] || {
              x: (i % 3) * 280,
              y: Math.floor(i / 3) * 150,
              pinned: false,
            },
          ]
        : [],
    );
    const left = Math.min(...points.map((p) => p.x)),
      top = Math.min(...points.map((p) => p.y));
    const right = Math.max(...points.map((p) => p.x)) + 252,
      bottom = Math.max(...points.map((p) => p.y)) + 125;
    const width = canvasRef.current?.clientWidth || 700,
      height = canvasRef.current?.clientHeight || 660;
    const scale = Math.min(
      1,
      Math.max(
        0.1,
        Math.min(
          (width - 60) / (right - left),
          (height - 100) / (bottom - top),
        ),
      ),
    );
    setZoom(scale);
    setPan({
      x: width / 2 - ((left + right) * scale) / 2,
      y: (height - 36) / 2 - ((top + bottom) * scale) / 2,
    });
  }
  async function openDocument(object: Item) {
    const updated = await edit({ selection: [object.id] });
    if (!updated) return;
    setMode("browse");
    setKind("file");
    setScope(object.workspaceId);
    setQuery(object.title);
    setZoom(1);
    const p = updated.placements[object.id] || { x: 0, y: 0 };
    setPan({ x: 24 - p.x, y: 24 - p.y });
    await readSource(object);
  }
  useEffect(() => {
    if (!board?.id || ended) return;
    const timer = setInterval(() => {
      if (!busy && document.visibilityState === "visible")
        void action("sand_read_board");
    }, 5000);
    return () => clearInterval(timer);
  }, [board?.id, busy, ended]);
  const selected = board?.objects.find((o) => o.id === board.selection.at(-1));
  useEffect(() => {
    setSource(undefined);
    setNote(selected ? board?.notes[selected.id] || "" : "");
  }, [selected?.id, board?.notes[selected?.id || ""]]);
  if (ended)
    return (
      <main className={theme}>
        <h1>白板已结束</h1>
        <p>本次整理已从内存清除。请让 Agent 重新打开白板。</p>
      </main>
    );
  if (!board)
    return (
      <main className={theme}>
        <h1>Sand Table</h1>
        <p>{connectionError?.message || error || "等待宿主打开项目总览…"}</p>
      </main>
    );
  const focusedGuide = board.guides.find(
    (g) => g.id === board.guideFocus?.guideId,
  );
  const routeIds = new Set(
    focusedGuide?.steps.flatMap((s) => s.objectIds) || [],
  );
  const visible = board.objects.filter(
    (o) =>
      o.kind !== "workspace" &&
      (kind === "all" || o.kind === kind) &&
      (scope === "all" || o.workspaceId === scope) &&
      `${o.title} ${o.source?.path || ""}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const positions = Object.fromEntries(
    visible.map((o, i) => [
      o.id,
      draft[o.id] ||
        board.placements[o.id] || {
          x: (i % 3) * 280,
          y: Math.floor(i / 3) * 150,
          pinned: false,
        },
    ]),
  );
  function choose(id: string, shift = false) {
    const old = boardRef.current!.selection;
    void edit({
      selection: shift
        ? old.includes(id)
          ? old.filter((x) => x !== id)
          : [...old, id]
        : [id],
    });
  }
  const workLabel = (id: string) =>
    board.workspaces.find((w) => w.id === id)?.label || "未知";
  return (
    <main className={theme}>
      <header>
        <div>
          <span className="eyebrow">SAND TABLE / SHARED UNDERSTANDING</span>
          <h1>{board.title}</h1>
          <p>看见整体，指向局部，和你的 AI 一起理解。</p>
        </div>
        <div className="header-actions">
          <button
            onClick={() => setTheme(theme === "paper" ? "mono" : "paper")}
          >
            {theme === "paper" ? "切换黑白" : "切换纸张"}
          </button>
          <button
            disabled={busy}
            onClick={() => void action("sand_refresh_board")}
          >
            刷新源码
          </button>
          <button
            onClick={async () => {
              if (await action("sand_end_board")) setEnded(true);
            }}
          >
            结束白板
          </button>
        </div>
      </header>
      <section className="overview">
        <div>
          <strong>{board.workspaces.length}</strong> 工作区
        </div>
        <div>
          <strong>
            {board.objects.filter((o) => o.kind === "symbol").length}
          </strong>{" "}
          代码入口
        </div>
        <div>
          <strong>{board.activities.length}</strong> 活动报告
        </div>
        <div>
          <strong>{board.selection.length}</strong> 已选对象
        </div>
        <span>只读源码 · 本次整理不写入文件</span>
      </section>
      <section className="workspaces">
        <button
          className={scope === "all" ? "active" : ""}
          onClick={() => setScope("all")}
        >
          全部工作区
        </button>
        {board.workspaces.map((w) => (
          <button
            key={w.id}
            className={scope === w.id ? "active" : ""}
            onClick={() => setScope(w.id)}
          >
            <b>{w.label}</b>{" "}
            <small>
              {w.branch} · {w.head.slice(0, 7)}
            </small>
          </button>
        ))}
      </section>
      <div className="tools">
        <div className="modes">
          {[
            ["browse", "浏览"],
            ["arrange", "编排"],
            ["ai", "AI 上下文"],
          ].map(([id, title]) => (
            <button
              className={mode === id ? "active" : ""}
              onClick={() => setMode(id)}
              key={id}
            >
              {title}
            </button>
          ))}
        </div>
        <input
          aria-label="搜索对象"
          placeholder="搜索名称或文件…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          aria-label="对象类型"
          value={kind}
          onChange={(e) => setKind(e.target.value)}
        >
          <option value="symbol">代码入口</option>
          <option value="file">文件</option>
          <option value="all">全部对象</option>
        </select>
        <button aria-pressed={arrows} onClick={() => setArrows(!arrows)}>
          关系 {arrows ? "开" : "关"}
        </button>
      </div>
      {(error || connectionError) && (
        <div role="alert" className="error">
          {error || connectionError?.message}
        </div>
      )}
      <div className="layout">
        <section
          ref={canvasRef}
          className="canvas"
          aria-label="项目白板"
          onPointerDown={(e) => {
            if (e.target === e.currentTarget) {
              drag.current = {
                x: e.clientX,
                y: e.clientY,
                base: { ...pan, pinned: false },
                moving: false,
              };
              e.currentTarget.setPointerCapture(e.pointerId);
            }
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d) return;
            const dx = e.clientX - d.x,
              dy = e.clientY - d.y;
            if (Math.abs(dx) + Math.abs(dy) > 3) d.moving = true;
            if (d.id)
              setDraft({
                [d.id]: {
                  ...d.base,
                  x: d.base.x + dx / zoom,
                  y: d.base.y + dy / zoom,
                },
              });
            else setPan({ x: d.base.x + dx, y: d.base.y + dy });
          }}
          onPointerUp={() => {
            const d = drag.current;
            drag.current = undefined;
            if (d?.id && d.moving && draft[d.id])
              void edit({ placements: { [d.id]: draft[d.id] } }).then(() =>
                setDraft({}),
              );
            else setDraft({});
          }}
        >
          <div className="canvas-hint">
            {focusedGuide
              ? "功能路径定位 · 其他对象淡化"
              : mode === "arrange"
                ? "拖动卡片 · 双击选择 · 固定位置"
                : "点击查看 · Shift 多选 · 拖动空白平移"}
          </div>
          <div
            className="world"
            style={{
              transform: `translate(${pan.x}px,${pan.y}px) scale(${zoom})`,
            }}
          >
            {board.groups.map((g) => {
              const pts = g.objectIds
                .map((id) => positions[id])
                .filter(Boolean);
              if (!pts.length) return null;
              const x = Math.min(...pts.map((p) => p.x)) - 12,
                y = Math.min(...pts.map((p) => p.y)) - 30;
              return (
                <div
                  key={g.id}
                  className="group"
                  style={{
                    left: x,
                    top: y,
                    width: Math.max(...pts.map((p) => p.x)) + 264 - x,
                    height: Math.max(...pts.map((p) => p.y)) + 126 - y,
                  }}
                >
                  <span>{g.title} · 阅读分组</span>
                </div>
              );
            })}
            {arrows && (
              <svg className="edges">
                <defs>
                  <marker
                    id="arrow"
                    viewBox="0 0 10 10"
                    refX="9"
                    refY="5"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto-start-reverse"
                  >
                    <path d="M0 0L10 5L0 10z" />
                  </marker>
                </defs>
                {board.relations
                  .filter(
                    (r) =>
                      positions[r.source] &&
                      positions[r.target] &&
                      (!focusedGuide ||
                        (routeIds.has(r.source) && routeIds.has(r.target))),
                  )
                  .map((r, i) => {
                    const a = positions[r.source],
                      b = positions[r.target];
                    const dx = b.x - a.x,
                      dy = b.y - a.y;
                    const ratio =
                      1 / Math.max(Math.abs(dx) / 132, Math.abs(dy) / 68, 1);
                    const sx = a.x + 126 + dx * ratio,
                      sy = a.y + 55 + dy * ratio;
                    const tx = b.x + 126 - dx * ratio,
                      ty = b.y + 55 - dy * ratio;
                    return (
                      <g key={i}>
                        <path
                          d={`M${sx} ${sy} L${tx} ${ty}`}
                          markerEnd="url(#arrow)"
                        />
                        <text
                          x={(a.x + b.x) / 2 + 126}
                          y={(a.y + b.y) / 2 + 45}
                        >
                          {relationLabels[r.kind]}
                        </text>
                      </g>
                    );
                  })}
              </svg>
            )}
            {visible.map((o) => {
              const p = positions[o.id],
                activity = board.activities.find((a) =>
                  a.objectIds.includes(o.id),
                );
              return (
                <button
                  key={o.id}
                  data-object-id={o.id}
                  className={`card ${board.selection.includes(o.id) ? "selected" : ""} ${focusedGuide && !routeIds.has(o.id) ? "dimmed" : ""}`}
                  style={{ left: p.x, top: p.y }}
                  title={`${o.title}\n${o.source?.path}\n${workLabel(o.workspaceId)}`}
                  onClick={(e) => {
                    if (mode !== "arrange") choose(o.id, e.shiftKey);
                  }}
                  onDoubleClick={() => {
                    if (mode === "arrange") choose(o.id);
                  }}
                  onPointerDown={(e) => {
                    if (mode === "arrange" && !p.pinned) {
                      e.stopPropagation();
                      drag.current = {
                        id: o.id,
                        x: e.clientX,
                        y: e.clientY,
                        base: p,
                        moving: false,
                      };
                      e.currentTarget.setPointerCapture(e.pointerId);
                    }
                  }}
                >
                  <span className="card-type">
                    {o.kind === "symbol" ? "代码入口" : "源码文件"} ·{" "}
                    {workLabel(o.workspaceId)} {p.pinned ? "· 已固定" : ""}
                  </span>
                  {focusedGuide && routeIds.has(o.id) && (
                    <span className="step-badge">
                      步骤{" "}
                      {focusedGuide.steps
                        .flatMap((s, i) =>
                          s.objectIds.includes(o.id) ? [i + 1] : [],
                        )
                        .join("、")}
                    </span>
                  )}
                  <strong>{o.title}</strong>
                  <span className="path">
                    {o.source?.path}:{o.source?.startLine}
                  </span>
                  {activity && (
                    <span
                      className={`activity ${activity.stale ? "stale" : activity.state}`}
                    >
                      ● {activity.stale ? "最后已知" : activity.state} ·{" "}
                      {activity.action}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          {!visible.length && (
            <p className="empty">没有匹配对象。尝试切换到文件或清除筛选。</p>
          )}
          <div className="zoom">
            <button
              aria-label="缩小"
              onClick={() => setZoom(Math.max(0.3, zoom - 0.1))}
            >
              −
            </button>
            <span>{Math.round(zoom * 100)}%</span>
            <button
              aria-label="放大"
              onClick={() => setZoom(Math.min(2, zoom + 0.1))}
            >
              +
            </button>
            <button
              onClick={() => {
                setZoom(1);
                setPan({ x: 24, y: 24 });
              }}
            >
              复位
            </button>
          </div>
        </section>
        <aside>
          <GuidePanel
            board={board}
            busy={busy}
            onFocus={(focus) => void focusGuide(focus)}
            onDocument={(object) => void openDocument(object)}
          />
          <span className="eyebrow">
            {mode === "ai" ? "SHARED CONTEXT" : "INSPECT"}
          </span>
          <h2>
            {mode === "ai"
              ? "AI 看到了什么"
              : selected?.title || "从一个入口开始"}
          </h2>
          {mode === "ai" ? (
            <>
              <p>
                已选 {board.selection.length} 个对象。请在宿主对话中提问，Agent
                调用 sand_read_context 后读取此处的选区、分组和备注。
              </p>
              <p className="muted">
                选区表示关注范围，不代表写入授权。这里不展示宿主全部上下文。
              </p>
              <p>
                最近读取：
                {board.lastContextRead
                  ? new Date(board.lastContextRead.at).toLocaleTimeString() +
                    " · 修订 " +
                    board.lastContextRead.revision
                  : "尚未读取"}
              </p>
              <ul>
                {board.selection.map((id) => (
                  <li key={id}>
                    {board.objects.find((o) => o.id === id)?.title}
                  </li>
                ))}
              </ul>
            </>
          ) : selected ? (
            <>
              <p>
                {workLabel(selected.workspaceId)} / {selected.source?.path}
              </p>
              <button
                disabled={!selected.source || busy}
                onClick={() => void readSource(selected)}
              >
                查看源码依据
              </button>
              {source?.objectId === selected.id &&
                source.hash === selected.source?.hash && (
                  <section className="source-reader">
                    <small>
                      源码 {source.startLine}–{source.endLine} 行
                    </small>
                    <pre className="source">{source.text}</pre>
                    {source.nextLine && (
                      <button
                        disabled={busy}
                        onClick={() =>
                          void readSource(selected, source.nextLine!)
                        }
                      >
                        继续读取下一段
                      </button>
                    )}
                    {source.startLine !== selected.source?.startLine && (
                      <button
                        disabled={busy}
                        onClick={() => void readSource(selected)}
                      >
                        回到开头
                      </button>
                    )}
                  </section>
                )}
              <label>
                给 AI 的备注
                <textarea
                  value={note}
                  maxLength={2000}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="我想了解这一部分如何配合…"
                />
              </label>
              <button
                disabled={busy}
                onClick={() =>
                  void edit({ note: { objectId: selected.id, text: note } })
                }
              >
                保存备注
              </button>
              <button
                onClick={() => {
                  const p = positions[selected.id] ||
                    board.placements[selected.id] || {
                      x: 0,
                      y: 0,
                      pinned: false,
                    };
                  void edit({
                    placements: { [selected.id]: { ...p, pinned: !p.pinned } },
                  });
                }}
              >
                {board.placements[selected.id]?.pinned
                  ? "取消固定"
                  : "固定位置"}
              </button>
              <h3>关联对象</h3>
              {board.relations
                .filter(
                  (r) => r.source === selected.id || r.target === selected.id,
                )
                .map((r, i) => {
                  const target = r.source === selected.id ? r.target : r.source,
                    o = board.objects.find((o) => o.id === target);
                  return (
                    <button
                      className="relation"
                      key={i}
                      onClick={() => choose(target)}
                    >
                      {relationLabels[r.kind]} → {o?.title}
                    </button>
                  );
                })}
              <small>“可能调用”来自语法匹配，不保证运行时实际发生。</small>
            </>
          ) : (
            <p>
              点击卡片查看真实源码，按需打开关系箭头。按住 Shift
              选择多个对象，再向你的 AI 提问。
            </p>
          )}
          {mode === "arrange" && (
            <section>
              <h3>阅读分组</h3>
              <input
                aria-label="分组名称"
                placeholder="这组对象表达什么？"
                value={groupTitle}
                onChange={(e) => setGroupTitle(e.target.value)}
              />
              <button
                disabled={board.selection.length < 2 || !groupTitle.trim()}
                onClick={async () => {
                  if (
                    await edit({
                      group: { title: groupTitle, objectIds: board.selection },
                    })
                  )
                    setGroupTitle("");
                }}
              >
                将选区分组
              </button>
              {board.groups.map((g) => (
                <p key={g.id}>
                  {g.title}{" "}
                  <button onClick={() => void edit({ removeGroup: g.id })}>
                    解散
                  </button>
                </p>
              ))}
            </section>
          )}
          <section>
            <h3>Agent 在哪里</h3>
            {board.activities.length ? (
              board.activities.map((a) => (
                <div className="report" key={a.agentId}>
                  <b>{a.agentId}</b>
                  <p>{a.task}</p>
                  <p>
                    {workLabel(a.workspaceId)} ·{" "}
                    {a.stale ? "最后已知 / 已过期" : a.state}
                  </p>
                  <small>
                    {a.action} · {new Date(a.reportedAt).toLocaleTimeString()}
                    <br />
                    来源：Agent 自报
                  </small>
                </div>
              ))
            ) : (
              <p className="muted">尚无活动报告。没有报告不代表 Agent 空闲。</p>
            )}
          </section>
          <section>
            <h3>AI 解读</h3>
            {board.explanations
              .filter(
                (e) =>
                  !selected ||
                  e.evidence.some(
                    (ref) =>
                      ref.path === selected.source?.path &&
                      ref.workspaceId === selected.workspaceId,
                  ),
              )
              .map((e) => (
                <div className="report" key={e.id}>
                  <small>
                    {e.stale ? "依据已过期" : "Agent 推断 · 非已证实结论"}
                  </small>
                  <p>{e.text}</p>
                  <small>
                    {e.evidence
                      .map((r) => `${r.path}:${r.startLine}`)
                      .join(" · ")}
                  </small>
                </div>
              ))}
          </section>
        </aside>
      </div>
      <footer>
        {board.workspaces.map((w) => (
          <details key={w.id}>
            <summary>
              {w.label}：索引 {w.files} 个文件 · 未索引 {w.omitted.length} 项 ·
              快照 {w.snapshot.slice(0, 10)}
            </summary>
            <p>
              当前支持已跟踪的 JS / TS /
              Markdown；不执行仓库代码。索引快照不代表整个工作区。
            </p>
            <pre>{w.omitted.join("\n")}</pre>
          </details>
        ))}
        <p>
          会话仅在内存中 · 30 分钟无访问后过期 · 活动报告超过 60 秒显示最后已知
        </p>
      </footer>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Workbench />);
