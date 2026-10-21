import "./domain-ui.ts";
import { CanvasShell } from "./CanvasShell.tsx";
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
import { HistoryPanel } from "./HistoryPanel.tsx";
import type { HistorySnapshot } from "../core/history.ts";
import {
  canShowTaskEntry,
  resolveBridge,
  mapHostResult,
} from "../core/host-bridge.ts";
import { installHostBridgeClient } from "./host-bridge-client.ts";
import type { HostTaskEvent, WorkspaceDescriptor } from "../core/objects.ts";
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
  const [, hostChanged] = useState(0);
  const [hostTask, setHostTask] = useState<HostTaskEvent>();
  const operations = useRef<Promise<unknown>>(Promise.resolve());
  const [board, setBoard] = useState<Board>(),
    [error, setError] = useState(""),
    [saveError, setSaveError] = useState(""),
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
  const [workspaces, setWorkspaces] = useState<WorkspaceDescriptor[]>([]);
  const [workspaceErrors, setWorkspaceErrors] = useState<
    { id: string; reason: string }[]
  >([]);
  const [workspaceActiveId, setWorkspaceActiveId] = useState<
    string | undefined
  >();
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
  /* 宿主桥：白板内对话入口显隐由**真实能力**决定（决策 D7 / 契约 X1–X2）。
     MCP App 宿主能发消息，算一种「host」；注入的 DSH 桥按它自报的能力算。 */
  /* 宿主桥接线：宿主（DSH 插件）用 postMessage 送来能力，
     提交任务走请求-应答往返。装一次就够，卸载时拆掉。 */
  useEffect(() => {
    if (typeof window === "undefined" || !window.parent) return;
    const client = installHostBridgeClient({
      scope: window,
      parent: window.parent,
      /* 跨源时不能用 "*"：那等于把能力与任务内容广播给任何嵌入者。 */
      onCapabilities: () => hostChanged((n) => n + 1),
    });
    return () => client.dispose();
  }, []);
  /* 桥每帧重读：宿主可能晚于首帧注入（DSH 插件是异步加载的），
     缓存起来会永远读不到那一次注入。 */
  const bridge = resolveBridge(
    typeof window === "undefined" ? undefined : window,
    app ? "mcp" : "local",
  );
  const resultQueue = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(
    () =>
      bridge.subscribe((event) => {
        if (event.boardId && event.boardId !== boardRef.current?.id) return;
        setHostTask(event);
        for (const result of event.results ?? []) {
          resultQueue.current = resultQueue.current
            .then(async () => {
              if (event.boardId && event.boardId !== boardRef.current?.id)
                return;
              const mapped = mapHostResult(result);
              const current = boardRef.current;
              if (!current) return;
              const r = await call("sand_edit_space", {
                revision: current.revision,
                viewId,
                author: "DSH",
                operation: {
                  kind: "create",
                  type: mapped.type,
                  title: mapped.title,
                  data: {
                    ...mapped.data,
                    hostSource: mapped.source ?? bridge.host,
                    hostTaskId: event.taskId,
                  },
                },
              });
              boardRef.current = r;
              setBoard(r);
            })
            .catch((e) => setError(`AI 结果未能写入白板：${String(e)}`));
        }
      }),
    [bridge.host, bridge.capabilities().eventStream, app],
  );
  const hostReady = canShowTaskEntry(bridge);
  async function call(name: string, args: Record<string, unknown> = {}) {
    if (!app) throw Error("尚未连接宿主");
    return unpack(
      await app.callServerTool({
        name,
        arguments: { boardId: boardRef.current?.id, ...args },
      }),
    );
  }
  /** 读一次工作空间列表。读不到就不显示条目——不假装有。 */
  async function refreshWorkspaces() {
    try {
      const data: any = await action("sand_list_workspaces");
      setWorkspaces((data?.workspaces ?? []) as WorkspaceDescriptor[]);
      setWorkspaceErrors(
        (data?.errors ?? []) as { id: string; reason: string }[],
      );
      setWorkspaceActiveId(data?.activeId);
    } catch {
      /* 没连上服务端时不显示工作空间入口。 */
    }
  }
  async function action(name: string, args: Record<string, unknown> = {}) {
    setBusy(true);
    if (name !== "sand_read_board") setError("");
    const absorb = (data: any) => {
      if (
        data?.objects &&
        data?.spaces &&
        (!boardRef.current ||
          data.id !== boardRef.current.id ||
          data.revision >= boardRef.current.revision)
      ) {
        boardRef.current = data;
        setBoard(data);
      }
      return data;
    };
    try {
      return absorb(await call(name, args));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      /* A write refused because the board moved on is not something the
         person can act on: the board changed under them, most likely because
         an agent wrote to it. Read the current board and make the same write
         once more against the fresh revision. The refused write was never
         applied, so retrying it cannot apply it twice. */
      if (/^Board changed\./.test(message) && args.revision !== undefined) {
        try {
          const fresh = absorb(await call("sand_read_board"));
          return absorb(
            await call(name, {
              ...args,
              revision: fresh?.revision ?? args.revision,
            }),
          );
        } catch (retryError) {
          setError(
            retryError instanceof Error
              ? retryError.message
              : String(retryError),
          );
          return undefined;
        }
      }
      setError(message);
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
  /* Board history: the newest record can always be flipped, and the flip is
     itself recorded, so an undo can be undone. */
  const [history, setHistory] = useState<HistorySnapshot>();
  const historyRef = useRef(history);
  historyRef.current = history;
  const flip = (kind: "undo" | "redo") =>
    action("sand_" + kind, { author: "human" });
  const jump = (recordId: string) =>
    action("sand_undo_to", { recordId, author: "human" });
  const flipRef = useRef(flip);
  flipRef.current = flip;
  useEffect(() => {
    if (!board?.id || !isConnected) return;
    let alive = true;
    void call("sand_history")
      .then((data) => {
        if (alive && data?.records) setHistory(data as HistorySnapshot);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [board?.id, board?.revision, isConnected]);
  /* 连上服务端后读一次工作空间列表。 */
  useEffect(() => {
    if (!isConnected) return;
    void refreshWorkspaces();
  }, [isConnected]);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key !== "z" && key !== "y") return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      )
        return;
      const h = historyRef.current;
      if (!h) return;
      const redo = key === "y" || e.shiftKey;
      if (redo ? !h.canRedo : !h.canUndo) return;
      e.preventDefault();
      void flipRef.current(redo ? "redo" : "undo");
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
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
      if (!busy && document.visibilityState === "visible") {
        void action("sand_read_board");
        void call("sand_workspace_status")
          .then((status) =>
            setSaveError(
              status.lastSaveError ? `保存失败：${status.lastSaveError}` : "",
            ),
          )
          .catch(() => {});
      }
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
  if (board.presentation !== "code")
    return (
      <CanvasShell
        board={board}
        viewId={viewId}
        busy={busy}
        error={error || connectionError?.message || ""}
        action={action}
        call={call}
        operate={operate}
        openLink={(url) => void app?.openLink({ url })}
        history={history}
        onUndo={() => void flip("undo")}
        onRedo={() => void flip("redo")}
        onJump={(recordId) => void jump(recordId)}
        aiMode={hostReady ? "host" : "mcp"}
        workspacePanel={{
          workspaces,
          activeId: workspaceActiveId,
          errors: workspaceErrors,
          onRefresh: () => void refreshWorkspaces(),
          onCreate: async (input) => {
            await action("sand_create_workspace", input);
            await refreshWorkspaces();
          },
          onSwitch: async (id) => {
            await action("sand_switch_workspace", { id });
            await refreshWorkspaces();
            /* 切换之后活动工作空间的内容变了：重新载入最省事，
               也避免旧白板的状态残留在界面上。 */
            location.reload();
          },
          onRename: async (id, title) => {
            await action("sand_rename_workspace", { id, title });
            await refreshWorkspaces();
          },
          onDelete: async (id) => {
            await action("sand_delete_workspace", { id });
            await refreshWorkspaces();
          },
        }}
        hostTask={hostTask}
        onCancelHostTask={
          bridge.cancelTask && hostTask
            ? () => bridge.cancelTask!(hostTask.taskId)
            : undefined
        }
        sendToHost={
          canShowTaskEntry(bridge)
            ? async (text) => {
                const current = boardRef.current;
                const selected = new Set(current?.selection ?? []);
                /* 目标用「引用 + 版本」，不带整份快照：任务开始后用户改选择，
                   也不会把已提交任务的目标悄悄换掉。 */
                const targets = (current?.instances ?? [])
                  .filter((i) => selected.has(i.id))
                  .map((i) => {
                    const objectId = i.binding?.objectId ?? i.objectId;
                    if (!objectId) return undefined;
                    const object = current?.contentObjects?.find(
                      (o) => o.id === objectId,
                    );
                    return { objectId, version: object?.version ?? 0 };
                  })
                  .filter((t): t is { objectId: string; version: number } =>
                    Boolean(t),
                  );
                const submitted = await bridge.submitTask({
                  boardId: current?.id ?? "",
                  instruction: text,
                  targets,
                  contextVersion: current?.contentRevision ?? 0,
                });
                setHostTask({
                  taskId: submitted.taskId,
                  boardId: current?.id,
                  state: "queued",
                  message: "已提交",
                  at: Date.now(),
                });
              }
            : undefined
        }
        sendMessage={async (text) => {
          if (!app) throw Error("Not connected");
          const result = await app.sendMessage({
            role: "user",
            content: [{ type: "text", text }],
          });
          if (result.isError) throw Error("Host rejected message.");
        }}
      />
    );
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
