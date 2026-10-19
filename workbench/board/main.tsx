import React, { useState, useEffect, useRef, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import { useApp } from "@modelcontextprotocol/ext-apps/react";
import type { Board, Item, GuideFocus } from "../core/model.ts";
import "./style.css";
import { SpaceCanvas } from "./SpaceCanvas.tsx";
import { ChangePanel } from "./ChangePanel.tsx";
import { ComponentPanel, ThemePanel } from "./ComponentPanel.tsx";
import { safeUrl } from "../core/spaces.ts";
import { resultData } from "../core/results.ts";
import { GuidePanel } from "./GuidePanel.tsx";
const relationLabels = {
  contains: "包含",
  imports: "导入",
  "syntactic-call": "可能调用（语法推断）",
};
function unpack(r: any) {
  if (r.isError) throw Error(r.content?.[0]?.text || "Request failed");
  return resultData(r) ?? JSON.parse(r.content[0].text);
}
function Workbench() {
  const [viewId] = useState(() => crypto.randomUUID());
  const [tab, setTab] = useState("inspect");
  const opening = useRef(false);
  const operations = useRef<Promise<unknown>>(Promise.resolve());
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
    [groupTitle, setGroupTitle] = useState("");
  const boardRef = useRef(board);
  boardRef.current = board;
  const {
    app,
    error: connectionError,
    isConnected,
  } = useApp({
    appInfo: { name: "Sand Table", version: "0.3.0" },
    capabilities: {},
    onAppCreated: (a) => {
      a.ontoolresult = (r) => {
        try {
          const data = unpack(r);
          if (
            data.objects &&
            data.spaces &&
            (!boardRef.current ||
              data.id !== boardRef.current.id ||
              data.revision >= boardRef.current.revision)
          ) {
            boardRef.current = data;
            setBoard(data);
          }
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
      if (
        data.objects &&
        data.spaces &&
        (!boardRef.current ||
          data.id !== boardRef.current.id ||
          data.revision >= boardRef.current.revision)
      ) {
        boardRef.current = data;
        setBoard(data);
      }
      return data;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      if (name !== "sand_read_board")
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
      viewId,
      ...data,
    });
  }
  const operate = (operation: any) => {
    const next = operations.current.then(() =>
      action("sand_edit_space", {
        revision: boardRef.current?.revision,
        viewId,
        author: "human",
        operation,
      }),
    );
    operations.current = next.catch(() => undefined);
    return next;
  };
  const clearFilters = () => {
    setQuery("");
    setKind("all");
    setScope("all");
  };
  useEffect(() => {
    if (!board?.id || !isConnected || board.views[viewId] || opening.current)
      return;
    opening.current = true;
    void action("sand_open_view", { viewId }).finally(
      () => (opening.current = false),
    );
  }, [board?.id, isConnected, Boolean(board?.views[viewId])]);
  useEffect(() => {
    if (board?.theme) setTheme("custom");
  }, [JSON.stringify(board?.theme)]);
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
  }
  async function openDocument(object: Item) {
    const updated = await edit({ selection: [object.id] });
    if (!updated) return;
    setMode("browse");
    setKind("file");
    setScope(object.workspaceId);
    setQuery(object.title);
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
  const view = board?.views[viewId];
  const selectedInstance = board?.instances.find(
    (c) => c.id === view?.selection.at(-1),
  );
  const selected = board?.objects.find(
    (o) => o.id === selectedInstance?.objectId,
  );
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
  const custom = theme === "custom" ? board.theme : undefined;
  const customStyle = custom
    ? ({
        "--bg": custom.background,
        "--surface": custom.surface,
        "--ink": custom.ink,
        "--muted": custom.muted,
        "--line": custom.line,
        "--accent": custom.accent,
        "--soft": custom.background,
        "--radius": `${custom.radius}px`,
        fontFamily:
          custom.font === "serif"
            ? "Georgia,serif"
            : custom.font === "mono"
              ? "ui-monospace,monospace"
              : "system-ui,sans-serif",
      } as CSSProperties)
    : undefined;
  return (
    <main
      className={`${theme === "custom" ? board.theme?.base || "paper" : theme} ${custom?.density === "compact" ? "compact" : ""} ${custom?.reduceMotion ? "reduce-motion" : ""}`}
      style={customStyle}
    >
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
          {board.theme && theme !== "custom" && (
            <button onClick={() => setTheme("custom")}>使用自定义外观</button>
          )}
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
          <strong>{view?.selection.length || 0}</strong> 已选组件
        </div>
        <span>白板确认改动 · Agent 使用宿主工具写入</span>
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
              onClick={() => {
                setMode(id);
                setTab(id === "arrange" ? "components" : "inspect");
              }}
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
        <SpaceCanvas
          board={board}
          viewId={viewId}
          mode={mode}
          query={query}
          kind={kind}
          scope={scope}
          arrows={arrows}
          busy={busy}
          operate={operate}
          call={call}
          clearFilters={clearFilters}
          onOpenLink={(url) => {
            const safe = safeUrl(url);
            if (safe)
              void app
                ?.openLink({ url: safe })
                .catch(() => setError(`宿主无法打开链接，请复制：${safe}`));
          }}
        />
        <aside>
          <div className="side-tabs" role="tablist" aria-label="工作面板">
            {[
              ["inspect", "理解"],
              ["changes", "改动"],
              ["components", "组件"],
              ["theme", "外观"],
            ].map(([id, title]) => (
              <button
                key={id}
                role="tab"
                aria-selected={tab === id}
                onClick={() => setTab(id)}
              >
                {title}
              </button>
            ))}
          </div>
          {tab === "changes" ? (
            <ChangePanel
              board={board}
              viewId={viewId}
              busy={busy}
              action={action}
            />
          ) : tab === "components" ? (
            <ComponentPanel
              board={board}
              viewId={viewId}
              busy={busy}
              operate={operate}
              action={action}
              selectNew={clearFilters}
            />
          ) : tab === "theme" ? (
            <ThemePanel
              board={board}
              operate={operate}
              onUseCustom={() => setTheme("custom")}
            />
          ) : (
            <>
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
                    已选 {board.selection.length}{" "}
                    个对象。请在宿主对话中提问，Agent 调用 sand_read_context
                    后读取此处的选区、分组和备注。
                  </p>
                  <p className="muted">
                    选区表示关注范围，不代表写入授权。这里不展示宿主全部上下文。
                  </p>
                  <p>
                    最近读取：
                    {board.lastContextRead
                      ? new Date(
                          board.lastContextRead.at,
                        ).toLocaleTimeString() +
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
                      if (selectedInstance)
                        void operate({
                          kind: "place",
                          items: [
                            {
                              id: selectedInstance.id,
                              rect: {
                                ...selectedInstance.rect,
                                pinned: !selectedInstance.rect.pinned,
                              },
                            },
                          ],
                        });
                    }}
                  >
                    {selectedInstance?.rect.pinned ? "取消固定" : "固定位置"}
                  </button>
                  <h3>关联对象</h3>
                  {board.relations
                    .filter(
                      (r) =>
                        r.source === selected.id || r.target === selected.id,
                    )
                    .map((r, i) => {
                      const target =
                          r.source === selected.id ? r.target : r.source,
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
                          group: {
                            title: groupTitle,
                            objectIds: board.selection,
                          },
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
                        {a.action} ·{" "}
                        {new Date(a.reportedAt).toLocaleTimeString()}
                        <br />
                        来源：Agent 自报
                      </small>
                    </div>
                  ))
                ) : (
                  <p className="muted">
                    尚无活动报告。没有报告不代表 Agent 空闲。
                  </p>
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
            </>
          )}
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
              当前支持已跟踪的 JS / TS / Python /
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
