import { initialData } from "./domain-ui.ts";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { HostTaskEvent } from "./data-client/objects.ts";
import type {
  Activity,
  Board,
  Item,
  SpaceActivity,
} from "./data-client/model.ts";
import type { HistorySnapshot } from "./data-client/history.ts";
import { safeUrl, findComponentSpec } from "./data-client/spaces.ts";
import { FlowCanvas } from "./canvas/FlowCanvas.tsx";
import { Toolbox } from "./Toolbox.tsx";
import { ThemePanel } from "./ThemePanel.tsx";
import { Inspector } from "./views/Inspector.tsx";
import { ChangePanel } from "./ChangePanel.tsx";
import { WorkspacePanel, type WorkspacePanelProps } from "./WorkspacePanel.tsx";
import { GuidePanel } from "./GuidePanel.tsx";
import { HistoryPanel } from "./HistoryPanel.tsx";
import { Rail } from "./shell/Rail.tsx";
import { Panel, PanelResize } from "./shell/Panel.tsx";
import { BoardsPanel } from "./shell/BoardsPanel.tsx";
import { ActivityLayer } from "./shell/ActivityLayer.tsx";
import {
  EMPTY_SHELL,
  HelpPanel,
  readShellMessage,
  type HostShellMessage,
} from "./shell/HelpPanel.tsx";
import {
  clampShellWidth,
  readShellPanel,
  readShellWidth,
  shellOcclusion,
  writeShellPanel,
  writeShellWidth,
  type NavId,
} from "./shell/nav.ts";

type Action = (name: string, args?: Record<string, unknown>) => Promise<any>;

function typingTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    Boolean(target.closest("input, textarea, select, [contenteditable='true']"))
  );
}

export function CanvasShell({
  board: b,
  viewId,
  busy,
  error,
  action,
  call,
  operate,
  openLink,
  sendMessage,
  history,
  onUndo,
  onRedo,
  onJump,
  aiMode = "mcp",
  sendToHost,
  workspacePanel,
  hostTask,
  onCancelHostTask,
}: {
  board: Board;
  viewId: string;
  busy: boolean;
  error: string;
  action: Action;
  call: Action;
  operate: (op: any) => Promise<any>;
  openLink: (url: string) => void;
  sendMessage: (text: string) => Promise<void>;
  history?: HistorySnapshot;
  onUndo?: () => void;
  onRedo?: () => void;
  onJump?: (recordId: string) => void;
  aiMode?: "host" | "mcp";
  sendToHost?: (text: string) => Promise<void>;
  workspacePanel?: WorkspacePanelProps;
  hostTask?: HostTaskEvent;
  onCancelHostTask?: () => Promise<void>;
}) {
  const [mode, setMode] = useState("browse"),
    [focusRevision, setFocusRevision] = useState(0),
    [nav, setNav] = useState<NavId | null>(readShellPanel),
    [width, setWidth] = useState(readShellWidth),
    [edgePan, setEdgePan] = useState(false),
    [edgeSpeed, setEdgeSpeed] = useState(600),
    [panel, setPanel] = useState(""),
    [query, setQuery] = useState(""),
    [arrows, setArrows] = useState(false),
    [theme, setTheme] = useState<"paper" | "mono" | "custom">("paper"),
    [name, setName] = useState(b.title),
    [prompt, setPrompt] = useState(""),
    [handoff, setHandoff] = useState(""),
    [source, setSource] = useState<any>(),
    [shell, setShell] = useState<HostShellMessage>(EMPTY_SHELL);
  const field = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const railRefs = useRef<Partial<Record<NavId, HTMLButtonElement | null>>>({});
  const navRef = useRef(nav);
  const revealSeen = useRef(0);
  navRef.current = nav;
  const view = b.views[viewId],
    selected = b.instances.find((c) => c.id === view?.selection.at(-1)),
    object = b.objects.find((o) => o.id === selected?.objectId);
  const shownWidth = nav === "settings" ? Math.max(width, 420) : width;

  const applyNav = (id: NavId | null) => {
    setNav(id);
    writeShellPanel(id);
  };
  const applyNavRef = useRef(applyNav);
  applyNavRef.current = applyNav;
  const collapse = () => {
    applyNav(null);
    setPanel("");
  };
  const collapseRef = useRef(collapse);
  collapseRef.current = collapse;

  useEffect(() => setName(b.title), [b.title]);
  useEffect(() => {
    if (b.theme) setTheme("custom");
    else if (theme === "custom") setTheme("paper");
  }, [JSON.stringify(b.theme)]);
  useEffect(() => {
    setSource(undefined);
    if (panel === "ai") return;
    if (selected)
      setPanel(selected.type === "object" ? "source" : "properties");
    else if (panel === "source" || panel === "properties") setPanel("");
  }, [selected?.id]);
  useEffect(() => {
    if (!nav || nav === "settings" || nav === "history") return;
    panelRef.current?.focus({ preventScroll: true });
  }, [nav]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        (event.key === "f" || event.key === "F") &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey
      ) {
        if (typingTarget(event.target)) return;
        event.preventDefault();
        collapseRef.current();
        return;
      }
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (typingTarget(event.target)) return;
      const host =
        event.target instanceof Element
          ? event.target.closest(".shell-panel")
          : null;
      if (!host || host.classList.contains("is-hidden")) return;
      if (
        event.target instanceof Element &&
        event.target.closest('[role="dialog"]')
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      const id = navRef.current;
      applyNavRef.current(null);
      if (id) railRefs.current[id]?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window.parent) return;
      const next = readShellMessage(event.data);
      if (next) setShell(next);
    };
    window.addEventListener("message", onMessage);
    if (window.parent !== window)
      window.parent.postMessage({ type: "sand-table:shell-ready" }, "*");
    return () => window.removeEventListener("message", onMessage);
  }, []);
  useEffect(() => {
    if (shell.revealSeq > revealSeen.current) {
      revealSeen.current = shell.revealSeq;
      setNav("help");
      writeShellPanel("help");
    }
  }, [shell.revealSeq]);

  const custom = theme === "custom" ? b.theme : undefined;
  const style = custom
    ? ({
        "--bg": custom.background,
        "--surface": custom.surface,
        "--ink": custom.ink,
        "--muted": custom.muted,
        "--line": custom.line,
        "--accent": custom.accent,
        "--soft": custom.background,
        "--radius": custom.radius + "px",
        fontFamily:
          custom.font === "mono"
            ? "ui-monospace,monospace"
            : custom.font === "serif"
              ? "Georgia,serif"
              : "system-ui,sans-serif",
      } as CSSProperties)
    : undefined;
  const closeNav = (id: NavId) => {
    applyNav(null);
    railRefs.current[id]?.focus();
  };
  const toggleNav = (id: NavId) => {
    setPanel((current) => (current === "ai" ? "" : current));
    applyNav(nav === id ? null : id);
  };
  const resizeFrom = (event: ReactPointerEvent<HTMLElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startW = width;
    const move = (pointer: PointerEvent) => {
      const next = clampShellWidth(startW + pointer.clientX - startX);
      setWidth(next);
      writeShellWidth(next);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const create = (
    type: string,
    title: string,
    data?: any,
    objectId?: string,
    size?: { width: number; height: number },
  ) => {
    setQuery("");
    setMode("arrange");
    const size_ = findComponentSpec(type);
    const narrow = window.innerWidth < 700;
    if (narrow) applyNav(null);
    const camera = view?.camera || { x: 24, y: 24, zoom: 1 };
    const offset =
      (b.instances.filter((c) => c.spaceId === view?.spaceId).length % 6) * 24;
    void operate({
      kind: "create",
      type,
      title,
      data: data ?? initialData(type, title),
      rect: {
        x: ((narrow ? 24 : 280) + offset - camera.x) / camera.zoom,
        y: (160 + offset - 36 - camera.y) / camera.zoom,
        width: size?.width || size_?.width || 280,
        height: size?.height || size_?.height || 180,
        pinned: false,
      },
      ...(objectId ? { objectId } : {}),
    });
  };
  const focusInstance = async (id: string) => {
    await operate({ kind: "select", ids: [id] });
    setFocusRevision((n) => n + 1);
  };
  async function focusObject(objectId: string) {
    const data = await call("sand_read", {
      ids: [objectId],
      include: ["presentations"],
    });
    const objectRow = data?.objects?.[0] as
      | {
          type?: string;
          presentations?: { id?: string; boardId?: string }[];
        }
      | undefined;
    const presentations = Array.isArray(objectRow?.presentations)
      ? objectRow.presentations
      : [];
    const current = view?.spaceId || b.id;
    const here =
      presentations.find((item) => item.boardId === current) ??
      presentations[0];
    if (here?.id && here.boardId) {
      if (here.boardId !== current)
        await operate({ kind: "navigate", spaceId: here.boardId });
      await operate({ kind: "select", ids: [here.id] });
      setFocusRevision((n) => n + 1);
      return;
    }
    if (objectRow?.type === "base.board")
      await operate({ kind: "navigate", spaceId: objectId });
  }
  async function openActivity(
    activity: Activity,
    space: SpaceActivity | undefined,
  ) {
    const here = b.instances.find(
      (item) =>
        (item.objectId && activity.objectIds.includes(item.objectId)) ||
        activity.objectIds.includes(item.id),
    );
    if (here) {
      await focusInstance(here.id);
      return;
    }
    if (!space?.spaceId) return;
    await operate({ kind: "navigate", spaceId: space.spaceId });
    if (space.instanceIds.length) {
      await operate({ kind: "select", ids: space.instanceIds });
      setFocusRevision((n) => n + 1);
    }
  }
  async function read(o: Item) {
    const result = await action("sand_read_source", { objectId: o.id });
    if (result) setSource({ ...result, objectId: o.id });
  }
  async function handToAI() {
    if (view)
      await operate({
        kind: "select",
        ids: [...view.selection],
        keepGuide: true,
      });
    if (sendToHost) {
      try {
        await sendToHost(prompt);
        setHandoff("已把请求连同选中对象与版本发给宿主 AI。");
        setPrompt("");
      } catch (e) {
        setHandoff(e instanceof Error ? e.message : String(e));
      }
      return;
    }
    const message =
      '使用 Sand Table 已有白板 boardId="' +
      b.id +
      '"，viewId="' +
      viewId +
      '"，当前 spaceId="' +
      (view?.spaceId || "overview") +
      '"。不要另建板子。先 sand_read_context 和 sand_read_spaces，读清当前空间、选区和我的编排，再按这个请求配置组件：' +
      prompt +
      "。使用 sand_edit_space 维护白板，用 sand_report_space_activity 如实报告你在这个空间做什么；不得把编排请求当作修改源码授权。需要源码修改时先读取明确意图并提交具体提案，等待我确认。";
    try {
      await sendMessage(message);
      setHandoff("已交给宿主，等它的回应。");
    } catch (e) {
      setHandoff(
        "宿主没有接受这条消息（" +
          ((e as Error)?.message || "未知原因") +
          "）。你的 AI 仍然可以用 MCP 工具直接操作这张白板。",
      );
    }
  }
  const askSelection = () => {
    if (window.parent === window) return;
    window.parent.postMessage({ type: "sand-table:shell-ask" }, "*");
  };

  return (
    <main
      className={
        "canvas-app " +
        (theme === "custom" ? b.theme?.base || "paper" : theme) +
        (custom?.density === "compact" ? " compact" : "") +
        (custom?.reduceMotion ? " reduce-motion" : "")
      }
      style={style}
    >
      <Rail
        open={nav}
        connected={shell.connected}
        onToggle={toggleNav}
        onCollapse={collapse}
        buttonRef={(id, node) => {
          railRefs.current[id] = node;
        }}
      />
      <header className="canvas-topbar">
        <span className="canvas-brand">
          S<span>Sand Table</span>
        </span>
        <input
          className="board-title"
          aria-label="白板名称"
          value={name}
          maxLength={120}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            if (name.trim() && name !== b.title)
              void action("sand_rename_board", {
                revision: b.revision,
                title: name.trim(),
              });
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
        />
        <div className="canvas-top-actions">
          <button
            type="button"
            onClick={() => {
              setMode("browse");
              applyNav(null);
            }}
          >
            浏览
          </button>
          {aiMode === "host" && (
            <button
              type="button"
              aria-pressed={panel === "ai"}
              onClick={() => {
                setMode("ai");
                applyNav(null);
                setPanel("ai");
              }}
            >
              AI 编排
            </button>
          )}
        </div>
      </header>
      {error && (
        <div className="canvas-error" role="alert">
          {error}
          {workspacePanel?.onExport && (
            <button type="button" onClick={workspacePanel.onExport}>
              导出工作空间
            </button>
          )}
          {workspacePanel?.onReload && (
            <button type="button" onClick={workspacePanel.onReload}>
              保留副本并重新加载
            </button>
          )}
        </div>
      )}
      <div className={"studio-layout " + (panel ? "has-inspector" : "")}>
        <div
          ref={(node) => {
            if (nav === "components") panelRef.current = node;
          }}
          className={
            "floating-tool-wrap shell-panel" +
            (nav === "components" ? "" : " is-hidden")
          }
          style={{ width }}
          tabIndex={-1}
        >
          <Toolbox
            focusInstance={(id) => void focusInstance(id)}
            activeSection="tools"
            close={() => closeNav("components")}
            navigate={(spaceId) => {
              setQuery("");
              void operate({ kind: "navigate", spaceId });
            }}
            board={b}
            viewId={viewId}
            mode={mode}
            busy={busy}
            setMode={setMode}
            create={create}
            action={action}
            call={call}
            showPanel={setPanel}
          />
          <PanelResize onResizeStart={resizeFrom} />
        </div>
        {nav && nav !== "components" && (
          <Panel
            title={
              nav === "boards"
                ? "白板"
                : nav === "history"
                  ? "历史"
                  : nav === "settings"
                    ? "设置"
                    : "帮助"
            }
            dialog={nav === "settings"}
            width={shownWidth}
            panelRef={(node) => {
              panelRef.current = node;
            }}
            onClose={() => closeNav(nav)}
            onResizeStart={resizeFrom}
          >
            {nav === "boards" ? (
              <BoardsPanel
                board={b}
                viewId={viewId}
                call={call}
                createBoard={() => create("board", "新白板")}
                onOpenBoard={(id) => {
                  setQuery("");
                  void operate({ kind: "navigate", spaceId: id });
                }}
                onFocusInstance={(id) => void focusInstance(id)}
                onFocusObject={focusObject}
              />
            ) : nav === "history" ? (
              <HistoryPanel
                history={history}
                busy={busy}
                call={call}
                refreshBoard={() => action("sand_read_board")}
                onUndo={onUndo}
                onRedo={onRedo}
                onJump={onJump}
              />
            ) : nav === "settings" ? (
              <>
                <section>
                  <h3>外观</h3>
                  <div className="settings-presets">
                    {[
                      ["paper", "纸张"],
                      ["mono", "黑白"],
                      ...(b.theme ? [["custom", "自定义"]] : []),
                    ].map(([id, label]) => (
                      <button
                        key={id}
                        type="button"
                        aria-pressed={theme === id}
                        onClick={() =>
                          setTheme(id as "paper" | "mono" | "custom")
                        }
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <label>
                    <input
                      type="checkbox"
                      checked={arrows}
                      onChange={(e) => setArrows(e.target.checked)}
                    />{" "}
                    显示关系
                  </label>
                  <h3>画布</h3>
                  <label>
                    <input
                      type="checkbox"
                      checked={edgePan}
                      onChange={(e) => setEdgePan(e.target.checked)}
                    />{" "}
                    边缘移动
                  </label>
                  <label>
                    移动速度
                    <input
                      aria-label="边缘移动速度"
                      type="range"
                      min="200"
                      max="1200"
                      step="100"
                      value={edgeSpeed}
                      onChange={(e) => setEdgeSpeed(Number(e.target.value))}
                    />
                  </label>
                  {view && view.selection.length > 0 && (
                    <>
                      <h3>选中组件</h3>
                      <div className="detail-options">
                        {[
                          ["full", "完整界面"],
                          ["label", "图标＋标题"],
                          ["icon", "仅图标"],
                        ].map(([detail, label]) => (
                          <button
                            key={detail}
                            type="button"
                            onClick={async () => {
                              for (const id of view.selection)
                                await operate({
                                  kind: "update",
                                  instanceId: id,
                                  appearance: { detail },
                                });
                            }}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </section>
                {workspacePanel && !shell.embedded && (
                  <section>
                    <h3>工作空间</h3>
                    <p className="settings-hint">
                      一台机器上可以并存多个工作空间；切换前会先把当前内容落盘。
                    </p>
                    <WorkspacePanel {...workspacePanel} />
                  </section>
                )}
                <ThemePanel
                  board={b}
                  operate={operate}
                  onUseCustom={() => setTheme("custom")}
                />
              </>
            ) : (
              <HelpPanel
                shell={shell}
                onAsk={askSelection}
                onClose={() => closeNav("help")}
              />
            )}
          </Panel>
        )}
        <section className="studio-stage" aria-label="白板工作区">
          <div className="stage-search">
            <input
              aria-label="在这张白板中查找"
              placeholder="在这张白板中查找…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <FlowCanvas
            board={b}
            viewId={viewId}
            mode={mode}
            focusRevision={focusRevision}
            edgePan={edgePan}
            edgeSpeed={edgeSpeed}
            motionPaused={nav === "settings"}
            insets={shellOcclusion({
              panelWidth: nav ? shownWidth : null,
              inspectorRight: Boolean(panel) && panel !== "ai",
              contextLeft: panel === "ai",
            })}
            query={query}
            kind="all"
            scope="all"
            arrows={arrows}
            busy={busy}
            operate={operate}
            call={call}
            clearFilters={() => setQuery("")}
            onOpenLink={(url) => {
              const safe = safeUrl(url);
              if (safe) openLink(safe);
            }}
          />
          {view &&
            !b.instances.some((c) => c.spaceId === view.spaceId) &&
            !query && (
              <div className="blank-invitation">
                <span aria-hidden="true">＋</span>
                <h1>从一块空白开始</h1>
                <button
                  type="button"
                  onClick={() => create("text", "我的第一张便签")}
                >
                  添加第一张便签
                </button>
              </div>
            )}
          <ActivityLayer
            board={b}
            onOpen={(activity, space) => void openActivity(activity, space)}
          />
        </section>
        {panel && panel !== "theme" && (
          <aside
            className={
              "studio-inspector " + (panel === "ai" ? "is-context" : "")
            }
            aria-label="组件详情"
          >
            <div className="inspector-heading">
              <span>
                {
                  (
                    {
                      browse: "浏览",
                      properties: "组件属性",
                      source: "源码与理解",
                      ai: "和 AI 一起搭",
                      theme: "外观",
                      changes: "代码改动",
                    } as Record<string, string>
                  )[panel]
                }
              </span>
              {object && (panel === "source" || panel === "properties") && (
                <button
                  type="button"
                  className="inspector-switch"
                  onClick={() =>
                    setPanel(panel === "source" ? "properties" : "source")
                  }
                >
                  {panel === "source" ? "组件属性" : "源码与理解"}
                </button>
              )}
              <button
                type="button"
                aria-label="关闭详情"
                onClick={() => setPanel("")}
              >
                ×
              </button>
            </div>
            {panel === "browse" ? (
              <p>选择组件</p>
            ) : panel === "properties" ? (
              <Inspector
                board={b}
                viewId={viewId}
                call={call}
                operate={operate}
                onOpenSettings={() => applyNav("settings")}
                onOpenLink={(url) => {
                  const safe = safeUrl(url);
                  if (safe) openLink(safe);
                }}
              />
            ) : panel === "changes" ? (
              <ChangePanel
                board={b}
                viewId={viewId}
                busy={busy}
                action={action}
              />
            ) : panel === "ai" ? (
              <section className="ai-composer">
                {aiMode === "host" ? (
                  <>
                    <h2>你想怎么搭？</h2>
                    <textarea
                      ref={field}
                      aria-label="给 AI 的编排请求"
                      placeholder="例如：给我搭一个比较两个方案的白板，留出证据、图表和结论…"
                      value={prompt}
                      onChange={(e) => setPrompt(e.target.value)}
                      maxLength={8000}
                    />
                    <button
                      type="button"
                      disabled={!prompt.trim()}
                      onClick={() => void handToAI()}
                    >
                      交给我的 AI
                    </button>
                  </>
                ) : (
                  <p>接入方式在「帮助」里。这里不放对话框。</p>
                )}
                {handoff && <p role="status">{handoff}</p>}
                {hostTask && (
                  <div role="status" aria-label="AI 任务状态">
                    <p>{hostTask.message || hostTask.state}</p>
                    {hostTask.state === "running" && onCancelHostTask && (
                      <button
                        type="button"
                        onClick={() =>
                          void onCancelHostTask().catch((e) =>
                            setHandoff(String(e)),
                          )
                        }
                      >
                        停止 AI
                      </button>
                    )}
                  </div>
                )}
              </section>
            ) : (
              <section className="source-inspector">
                <GuidePanel
                  board={b}
                  busy={busy}
                  onFocus={(focus) =>
                    void action("sand_edit_view", {
                      revision: b.revision,
                      viewId,
                      guideFocus: focus,
                    })
                  }
                  onDocument={(o) => void read(o)}
                />
                {object && (
                  <>
                    <h2>{object.title}</h2>
                    <small>{object.source?.path}</small>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void read(object)}
                    >
                      查看源码依据
                    </button>
                    {source && (
                      <>
                        <small>
                          {source.reference?.path}:{source.reference?.startLine}
                        </small>
                        <pre className="source">{source.text}</pre>
                        {source.nextLine && (
                          <button
                            type="button"
                            onClick={async () =>
                              setSource(
                                await action("sand_read_source", {
                                  objectId: source.objectId || object.id,
                                  startLine: source.nextLine,
                                }),
                              )
                            }
                          >
                            继续读取下一段
                          </button>
                        )}
                      </>
                    )}
                    <h3>同文件代码入口</h3>
                    {b.objects
                      .filter(
                        (o) =>
                          o.kind === "symbol" &&
                          o.source?.path === object.source?.path &&
                          o.workspaceId === object.workspaceId,
                      )
                      .slice(0, 40)
                      .map((o) => (
                        <button
                          className="source-choice"
                          type="button"
                          key={o.id}
                          onClick={() => create("object", o.title, {}, o.id)}
                        >
                          {o.title}
                        </button>
                      ))}
                    <button type="button" onClick={() => setPanel("changes")}>
                      表达代码改动
                    </button>
                  </>
                )}
                <button
                  type="button"
                  onClick={() => void action("sand_refresh_board")}
                >
                  刷新源码与核对结果
                </button>
              </section>
            )}
          </aside>
        )}
      </div>
    </main>
  );
}
