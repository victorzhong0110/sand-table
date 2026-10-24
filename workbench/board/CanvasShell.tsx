import { initialData } from "./domain-ui.ts";
import { Icon } from "./Icon.tsx";
import { useState, useEffect, useRef, type CSSProperties } from "react";
import type { HostTaskEvent } from "./data-client/objects.ts";
import type { Board, Item } from "./data-client/model.ts";
import type { HistorySnapshot } from "./data-client/history.ts";
import {
  safeUrl,
  defaultData,
  componentTypes,
  findComponentSpec,
} from "./data-client/spaces.ts";
import { SpaceCanvas } from "./SpaceCanvas.tsx";
import { Toolbox } from "./Toolbox.tsx";
import { ComponentPanel, ThemePanel } from "./ComponentPanel.tsx";
import { ChangePanel } from "./ChangePanel.tsx";
import { WorkspacePanel, type WorkspacePanelProps } from "./WorkspacePanel.tsx";
import { GuidePanel } from "./GuidePanel.tsx";
type Action = (name: string, args?: Record<string, unknown>) => Promise<any>;
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
  /** The board's reversible history and the moves that change it. */
  history?: HistorySnapshot;
  onUndo?: () => void;
  onRedo?: () => void;
  onJump?: (recordId: string) => void;
  /**
   * AI 接入方式：
   * "host" = 宿主提供了消息桥接，能真的把任务发出去并收到响应；
   * "mcp"  = 只有 MCP，AI 在你自己的客户端里。
   * 只有真能发能收时才显示直接对话入口（决策 D7）。
   */
  aiMode?: "host" | "mcp";
  /**
   * 宿主提供的**结构化**任务通道（如 DSH 宿主桥）。
   * 有它时走它：发对象引用与版本，不塞提示词。
   * 没有时退回 sendMessage（MCP App 的消息桥）。
   */
  sendToHost?: (text: string) => Promise<void>;
  /** 工作空间管理面板的接线。传了就显示「工作空间」入口。 */
  workspacePanel?: WorkspacePanelProps;
  hostTask?: HostTaskEvent;
  onCancelHostTask?: () => Promise<void>;
}) {
  const [mode, setMode] = useState("browse"),
    [focusRevision, setFocusRevision] = useState(0),
    [navSection, setNavSection] = useState("tools"),
    [edgePan, setEdgePan] = useState(false),
    [edgeSpeed, setEdgeSpeed] = useState(600),
    [settingsOpen, setSettingsOpen] = useState(false),
    [toolsOpen, setToolsOpen] = useState(true),
    [panel, setPanel] = useState(""),
    [query, setQuery] = useState(""),
    [arrows, setArrows] = useState(false),
    [theme, setTheme] = useState<"paper" | "mono" | "custom">("paper"),
    [name, setName] = useState(b.title),
    [prompt, setPrompt] = useState(""),
    [handoff, setHandoff] = useState(""),
    [source, setSource] = useState<any>();
  const field = useRef<HTMLTextAreaElement>(null);
  const view = b.views[viewId],
    selected = b.instances.find((c) => c.id === view?.selection.at(-1)),
    object = b.objects.find((o) => o.id === selected?.objectId);
  useEffect(() => setName(b.title), [b.title]);
  useEffect(() => {
    if (b.theme) setTheme("custom");
    else if (theme === "custom") setTheme("paper");
  }, [JSON.stringify(b.theme)]);
  useEffect(() => {
    setSource(undefined);
    // Selecting context or receiving an AI result must not close the conversation.
    if (panel === "ai") return;
    if (selected)
      setPanel(selected.type === "object" ? "source" : "properties");
    else if (panel === "source" || panel === "properties") setPanel("");
  }, [selected?.id]);
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
    if (narrow) setToolsOpen(false);
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
        /* A component pack can say how big its preset should be; without one
           the type's own size is used. */
        width: size?.width || size_?.width || 280,
        height: size?.height || size_?.height || 180,
        pinned: false,
      },
      ...(objectId ? { objectId } : {}),
    });
  };
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
    /* 宿主提供结构化任务通道时走它：把「选中什么、什么版本」一起发过去，
       不把上下文拼成提示词塞回去。 */
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
      // 发送失败就说发送失败。不要退回到「复制这段提示词」——
      // 那是把「交给 AI」伪装成复制粘贴，日常用起来只会让人以为 AI 在干活。
      setHandoff(
        "宿主没有接受这条消息（" +
          ((e as Error)?.message || "未知原因") +
          "）。你的 AI 仍然可以用 MCP 工具直接操作这张白板。",
      );
    }
  }
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
      <nav className="app-rail" aria-label="主导航">
        <span className="rail-brand" title="Sand Table">
          S
        </span>
        <button
          aria-label="画板"
          title="画板"
          aria-pressed={toolsOpen && navSection === "boards"}
          onClick={() => {
            setNavSection("boards");
            setToolsOpen(true);
            if (panel === "ai") setPanel("");
          }}
        >
          <Icon name="board" />
        </button>
        <button
          aria-label="浏览"
          title="浏览"
          aria-pressed={mode === "browse" && navSection === "browse"}
          onClick={() => {
            setMode("browse");
            setNavSection("browse");
            setToolsOpen(false);
            setPanel(
              selected
                ? selected.type === "object"
                  ? "source"
                  : "properties"
                : "browse",
            );
          }}
        >
          <Icon name="browse" />
        </button>
        <button
          aria-label="编排"
          title="编排"
          aria-expanded={toolsOpen && navSection === "tools"}
          aria-pressed={toolsOpen && navSection === "tools"}
          onClick={() => {
            setToolsOpen(navSection !== "tools" || !toolsOpen);
            setMode("arrange");
            setNavSection("tools");
            if (panel === "ai") setPanel("");
          }}
        >
          <Icon name="arrange" />
        </button>
        <button
          aria-label="AI 编排"
          aria-pressed={panel === "ai"}
          onClick={() => {
            setMode("ai");
            setNavSection("ai");
            setToolsOpen(false);
            setPanel("ai");
          }}
        >
          <Icon name="ai" />
        </button>
        <button
          className="rail-settings"
          aria-label="设置"
          onClick={() => setSettingsOpen(true)}
        >
          <Icon name="comparison" />
        </button>
      </nav>
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
      </header>
      {error && (
        <div className="canvas-error" role="alert">
          {error}
          {workspacePanel?.onExport && (
            <button onClick={workspacePanel.onExport}>导出工作空间</button>
          )}
          {workspacePanel?.onReload && (
            <button onClick={workspacePanel.onReload}>
              保留副本并重新加载
            </button>
          )}
        </div>
      )}
      <div className={"studio-layout " + (panel ? "has-inspector" : "")}>
        <div className={"floating-tool-wrap " + (toolsOpen ? "" : "is-hidden")}>
          <Toolbox
            focusInstance={async (id) => {
              await operate({ kind: "select", ids: [id] });
              setFocusRevision((n) => n + 1);
            }}
            activeSection={navSection}
            close={() => setToolsOpen(false)}
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
            history={history}
            onUndo={onUndo}
            onRedo={onRedo}
            onJump={onJump}
            showPanel={setPanel}
          />
        </div>
        <section className="studio-stage" aria-label="白板工作区">
          <div className="stage-search">
            <input
              aria-label="搜索对象"
              placeholder="在这张白板中查找…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {(b.activities.some((a) => a.state === "running" && !a.stale) ||
              b.spaceActivities?.some(
                (a) => a.state === "running" && !a.stale,
              )) && <span className="agent-beacon">● Agent 有活动报告</span>}
          </div>
          <SpaceCanvas
            board={b}
            viewId={viewId}
            mode={mode}
            focusRevision={focusRevision}
            edgePan={edgePan}
            edgeSpeed={edgeSpeed}
            motionPaused={settingsOpen}
            insets={{
              left: toolsOpen
                ? 256
                : (panel === "ai" || navSection === "browse") && panel
                  ? 332
                  : 16,
              right:
                panel && panel !== "ai" && navSection !== "browse" ? 332 : 16,
              top: 120,
              bottom: 60,
            }}
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

                <button onClick={() => create("text", "我的第一张便签")}>
                  添加第一张便签
                </button>
              </div>
            )}
        </section>
        {panel && panel !== "theme" && (
          <aside
            className={
              "studio-inspector " +
              (panel === "ai" || navSection === "browse" ? "is-context" : "")
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
                    } as any
                  )[panel]
                }
              </span>
              {object && (panel === "source" || panel === "properties") && (
                <button
                  className="inspector-switch"
                  onClick={() =>
                    setPanel(panel === "source" ? "properties" : "source")
                  }
                >
                  {panel === "source" ? "组件属性" : "源码与理解"}
                </button>
              )}
              <button aria-label="关闭详情" onClick={() => setPanel("")}>
                ×
              </button>
            </div>
            {panel === "browse" ? (
              <p>选择组件</p>
            ) : panel === "properties" ? (
              <ComponentPanel
                board={b}
                viewId={viewId}
                busy={busy}
                operate={operate}
                action={action}
                selectNew={() => setQuery("")}
                detailsOnly
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
                      disabled={!prompt.trim()}
                      onClick={() => void handToAI()}
                    >
                      交给我的 AI
                    </button>
                  </>
                ) : (
                  <>
                    <h2>你的 AI 怎么接入</h2>
                    <p>
                      这张白板通过 <b>MCP</b> 接入：你的 AI
                      用沙盘工具直接读写这里， 你在它那边说话，它在这里动手。
                    </p>
                    <p>
                      这里不放对话框——只有真能把任务发出去并收到回应时，
                      才值得在这里直接说话。接入方式见「接入设置」。
                    </p>
                  </>
                )}
                {handoff && <p role="status">{handoff}</p>}
                {hostTask && (
                  <div role="status" aria-label="AI 任务状态">
                    <p>{hostTask.message || hostTask.state}</p>
                    {hostTask.state === "running" && onCancelHostTask && (
                      <button
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
                {(b.spaceActivities?.length || 0) > 0 && (
                  <>
                    <h3>Agent 在哪里</h3>
                    {b.spaceActivities!.map((a) => (
                      <div className="report" key={a.agentId}>
                        <b>{a.agentId}</b>
                        <p>{a.task}</p>
                        <small>
                          {a.stale ? "最后已知" : a.state} · {a.action}
                          <br />
                          来源：Agent 自报
                        </small>
                        <button
                          onClick={async () => {
                            await operate({
                              kind: "navigate",
                              spaceId: a.spaceId,
                            });
                            if (a.instanceIds.length)
                              await operate({
                                kind: "select",
                                ids: a.instanceIds,
                              });
                          }}
                        >
                          查看：
                          {b.spaces.find((s) => s.id === a.spaceId)?.title ||
                            "空间已缺失"}
                        </button>
                      </div>
                    ))}
                  </>
                )}
                <h3>它当前能读取什么</h3>
                <p>
                  {b.spaces.find((s) => s.id === view?.spaceId)?.title} ·{" "}
                  {view?.selection.length || 0} 个选中组件
                </p>
                <small>
                  最近读取：
                  {b.lastContextRead
                    ? new Date(b.lastContextRead.at).toLocaleTimeString()
                    : "尚未读取"}
                </small>
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
                    <button disabled={busy} onClick={() => void read(object)}>
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
                    <label>
                      给 AI 的备注
                      <textarea
                        key={object.id}
                        defaultValue={b.notes[object.id] || ""}
                        onBlur={(e) =>
                          void action("sand_edit_view", {
                            revision: b.revision,
                            viewId,
                            note: { objectId: object.id, text: e.target.value },
                          })
                        }
                      />
                    </label>
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
                          key={o.id}
                          onClick={() => create("object", o.title, {}, o.id)}
                        >
                          {o.title}
                        </button>
                      ))}
                    <button onClick={() => setPanel("changes")}>
                      表达代码改动
                    </button>
                  </>
                )}
                <button onClick={() => void action("sand_refresh_board")}>
                  刷新源码与核对结果
                </button>
              </section>
            )}
          </aside>
        )}
      </div>
      {settingsOpen && (
        <div
          className="settings-backdrop"
          onClick={() => setSettingsOpen(false)}
        >
          <section
            className="settings-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="设置"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Escape" && !e.defaultPrevented) {
                e.preventDefault();
                e.stopPropagation();
                setSettingsOpen(false);
              }
              if (e.key === "Tab") {
                const items = [
                  ...e.currentTarget.querySelectorAll<HTMLElement>(
                    'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex="0"]',
                  ),
                ];
                const first = items[0],
                  last = items.at(-1);
                if (e.shiftKey && document.activeElement === first) {
                  e.preventDefault();
                  last?.focus();
                } else if (!e.shiftKey && document.activeElement === last) {
                  e.preventDefault();
                  first?.focus();
                }
              }
            }}
          >
            <header>
              <h2>设置</h2>
              <button
                aria-label="关闭设置"
                autoFocus
                onClick={() => setSettingsOpen(false)}
              >
                ×
              </button>
            </header>
            <div className="settings-body">
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
              {workspacePanel && (
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
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
