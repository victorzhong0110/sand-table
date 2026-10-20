import { Icon } from "./Icon.tsx";
import { useState, useEffect, useRef, type CSSProperties } from "react";
import type { Board, Item } from "../core/model.ts";
import { safeUrl, defaultData } from "../core/spaces.ts";
import { SpaceCanvas } from "./SpaceCanvas.tsx";
import { Toolbox } from "./Toolbox.tsx";
import { ComponentPanel, ThemePanel } from "./ComponentPanel.tsx";
import { ChangePanel } from "./ChangePanel.tsx";
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
}) {
  const [mode, setMode] = useState("browse"),
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
    if (selected)
      setPanel(selected.type === "object" ? "source" : "properties");
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
  ) => {
    setQuery("");
    setMode("arrange");
    void operate({
      kind: "create",
      type,
      title,
      data: data ?? defaultData(type),
      ...(objectId ? { objectId } : {}),
    });
  };
  async function read(o: Item) {
    setSource(await action("sand_read_source", { objectId: o.id }));
  }
  async function handToAI() {
    const message =
      '使用 Sand Table 已有白板 boardId="' +
      b.id +
      '"，不要另建板子。先 sand_read_context 和 sand_read_spaces，读清当前空间、选区和我的编排，再按这个请求配置组件：' +
      prompt +
      "。使用 sand_edit_space 维护白板；不得把编排请求当作修改源码授权。需要源码修改时先读取明确意图并提交具体提案，等待我确认。";
    try {
      await sendMessage(message);
      setHandoff(
        "已交给宿主；本地模式请在接入面板复制后，到自己的 AI 客户端发送。",
      );
    } catch {
      setPrompt(message);
      setHandoff(
        "宿主未提供消息接入。请复制下面已准备的文字到你的 AI 客户端。",
      );
      field.current?.focus();
      field.current?.select();
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
          <button aria-pressed={arrows} onClick={() => setArrows(!arrows)}>
            关系 {arrows ? "开" : "关"}
          </button>
          <button
            onClick={() => setTheme(theme === "paper" ? "mono" : "paper")}
          >
            {theme === "paper" ? "黑白" : "纸张"}
          </button>
          {b.theme && theme !== "custom" && (
            <button onClick={() => setTheme("custom")}>自定义</button>
          )}
          <button
            onClick={() => {
              setMode("ai");
              setPanel("ai");
            }}
          >
            <Icon name="ai" size={14} /> 和 AI 一起搭
          </button>
        </div>
      </header>
      {error && (
        <div className="canvas-error" role="alert">
          {error}
        </div>
      )}
      <div className={"studio-layout " + (panel ? "has-inspector" : "")}>
        <Toolbox
          board={b}
          viewId={viewId}
          mode={mode}
          busy={busy}
          setMode={setMode}
          create={create}
          action={action}
          showPanel={setPanel}
        />
        <section className="studio-stage" aria-label="白板工作区">
          <div className="stage-search">
            <input
              aria-label="搜索对象"
              placeholder="在这张白板中查找…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {b.activities.some((a) => a.state === "running") && (
              <span className="agent-beacon">● Agent 有活动报告</span>
            )}
          </div>
          <SpaceCanvas
            board={b}
            viewId={viewId}
            mode={mode}
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
                <p>从左侧拖入组件，或让你的 AI 和你一起搭。</p>
                <button onClick={() => create("text", "我的第一张便签")}>
                  添加第一张便签
                </button>
              </div>
            )}
        </section>
        {panel && (
          <aside className="studio-inspector" aria-label="组件详情">
            <div className="inspector-heading">
              <span>
                {
                  (
                    {
                      properties: "组件属性",
                      source: "源码与理解",
                      ai: "和 AI 一起搭",
                      theme: "外观",
                      changes: "代码改动",
                    } as any
                  )[panel]
                }
              </span>
              <button aria-label="关闭详情" onClick={() => setPanel("")}>
                ×
              </button>
            </div>
            {panel === "properties" ? (
              <ComponentPanel
                board={b}
                viewId={viewId}
                busy={busy}
                operate={operate}
                action={action}
                selectNew={() => setQuery("")}
                detailsOnly
              />
            ) : panel === "theme" ? (
              <ThemePanel
                board={b}
                operate={operate}
                onUseCustom={() => setTheme("custom")}
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
                <span className="eyebrow">BUILD TOGETHER</span>
                <h2>你想怎么搭？</h2>
                <p>
                  让自己的 Agent
                  添加组件、组织关系或调整布局。它会读取这张板子的最新状态。
                </p>
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
                {handoff && <p role="status">{handoff}</p>}
                <p className="muted">
                  不内置模型。连接入口在页面顶部；本地浏览器会准备好消息供你复制到客户端。
                </p>
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
                        <pre className="source">{source.text}</pre>
                        {source.nextLine && (
                          <button
                            onClick={async () =>
                              setSource(
                                await action("sand_read_source", {
                                  objectId: object.id,
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
    </main>
  );
}
