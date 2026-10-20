import { Icon } from "./Icon.tsx";
import { useState } from "react";
import type { Board } from "../core/model.ts";
import { componentTypes, defaultData } from "../core/spaces.ts";
const groups = [
  {
    id: "basic",
    title: "基础",
    types: ["text", "heading", "board", "resource", "code"],
  },
  {
    id: "data",
    title: "数据",
    types: ["metric", "status", "chart", "table", "events"],
  },
  { id: "thinking", title: "思考", types: ["task", "reasoning", "comparison"] },
  {
    id: "development",
    title: "开发",
    types: ["intent", "proposal", "validation"],
  },
];
const icons: Record<string, string> = {
  text: "Aa",
  heading: "H",
  board: "▣",
  resource: "◇",
  code: "</>",
  metric: "#",
  status: "●",
  chart: "▥",
  table: "▦",
  events: "≡",
  task: "☑",
  reasoning: "?",
  comparison: "⇄",
  intent: "↗",
  proposal: "±",
  validation: "✓",
  object: "{ }",
};
export function Toolbox({
  board: b,
  viewId,
  mode,
  busy,
  setMode,
  create,
  action,
  showPanel,
  navigate,
}: {
  board: Board;
  viewId: string;
  mode: string;
  busy: boolean;
  setMode: (m: string) => void;
  create: (type: string, title: string, data?: any, objectId?: string) => void;
  action: (name: string, args?: Record<string, unknown>) => Promise<any>;
  showPanel: (panel: string) => void;
  navigate?: (spaceId: string) => void;
}) {
  const [section, setSection] = useState("components"),
    [group, setGroup] = useState("basic"),
    [query, setQuery] = useState(""),
    [path, setPath] = useState(""),
    [sourceQuery, setSourceQuery] = useState("");
  const palette = componentTypes.filter(
    (c) =>
      groups.find((g) => g.id === group)!.types.includes(c.type) &&
      c.title.includes(query),
  );
  const sources = b.objects
    .filter(
      (o) =>
        o.kind !== "workspace" &&
        (o.title + " " + o.source?.path)
          .toLowerCase()
          .includes(sourceQuery.toLowerCase()),
    )
    .slice(0, 30);
  function drag(
    e: React.DragEvent,
    type: string,
    title: string,
    data?: any,
    objectId?: string,
  ) {
    e.dataTransfer.effectAllowed = "copy";
    e.dataTransfer.setData(
      "application/x-sand-component",
      JSON.stringify({
        type,
        title,
        data: data || defaultData(type),
        objectId,
      }),
    );
  }
  return (
    <aside className="canvas-toolbox" aria-label="组件工具箱">
      <div className="tool-modes" aria-label="操作工具">
        {[
          ["browse", "↖", "浏览"],
          ["arrange", "✥", "编排"],
          ["ai", "✦", "AI"],
        ].map(([id, icon, label]) => (
          <button
            key={id}
            title={label}
            aria-pressed={mode === id}
            onClick={() => {
              setMode(id);
              if (id === "ai") showPanel("ai");
            }}
          >
            <span aria-hidden="true">
              <Icon name={id} />
            </span>
            {label}
          </button>
        ))}
      </div>
      <div className="toolbox-nav" role="tablist" aria-label="素材">
        {[
          ["components", "组件"],
          ["presets", "场景"],
          ["sources", "仓库"],
        ].map(([id, label]) => (
          <button
            role="tab"
            key={id}
            aria-selected={section === id}
            onClick={() => setSection(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="toolbox-content">
        {navigate && (
          <details className="board-library" open>
            <summary>画板</summary>
            <div>
              {b.spaces.map((space) => (
                <button
                  key={space.id}
                  aria-current={
                    b.views[viewId]?.spaceId === space.id ? "page" : undefined
                  }
                  onClick={() => navigate(space.id)}
                >
                  <Icon name="board" size={14} /> {space.title}
                </button>
              ))}
            </div>
          </details>
        )}
        {section === "components" ? (
          <>
            <input
              aria-label="搜索组件"
              placeholder="搜索组件…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="component-categories">
              {groups.map((g) => (
                <button
                  key={g.id}
                  aria-pressed={group === g.id}
                  onClick={() => setGroup(g.id)}
                >
                  {g.title}
                </button>
              ))}
            </div>
            <div className="palette-list">
              {palette.map((c) => (
                <button
                  className="palette-item"
                  key={c.type}
                  disabled={busy}
                  draggable={!busy}
                  onDragStart={(e) => drag(e, c.type, c.title)}
                  onClick={() => create(c.type, c.title)}
                  title={"拖入画布，或点击添加" + c.title}
                >
                  <span className={"palette-icon " + group} aria-hidden="true">
                    {[
                      "text",
                      "heading",
                      "code",
                      "metric",
                      "reasoning",
                      "intent",
                      "proposal",
                      "validation",
                    ].includes(c.type) ? (
                      icons[c.type]
                    ) : (
                      <Icon name={c.type} />
                    )}
                  </span>
                  <span>{c.title}</span>
                  <span className="palette-grip" aria-hidden="true">
                    <Icon name="grip" size={14} />
                  </span>
                </button>
              ))}
            </div>
            <p className="toolbox-hint">
              拖进画布，或点击添加。
              <br />
              选中后修改内容；双击白板进入。
            </p>
          </>
        ) : section === "presets" ? (
          <>
            <h2>从一个场景开始</h2>
            <p className="muted">只添加你选择的内容。</p>
            <button
              className="preset-choice"
              disabled={busy}
              onClick={() =>
                create("board", "研究比较", { preset: "research" })
              }
            >
              <b>研究比较</b>
              <span>证据、图表、比较和下一步</span>
            </button>
            <button
              className="preset-choice"
              disabled={busy}
              onClick={() => create("board", "Bug 修复", { preset: "bug" })}
            >
              <b>Bug 修复</b>
              <span>目标、意图、提案与验证</span>
            </button>
            <button
              className="preset-choice"
              disabled={busy}
              onClick={() => create("board", "空白子白板", {})}
            >
              <b>空白子白板</b>
              <span>在这张板子里再放一张板子</span>
            </button>
          </>
        ) : (
          <>
            <h2>导入代码仓库</h2>
            <p className="muted">
              把本机已有的 Git 仓库作为一个子白板加入。不会安装或运行它。
            </p>
            <label>
              本机仓库路径
              <input
                aria-label="本机仓库路径"
                placeholder="/Users/你/project"
                value={path}
                onChange={(e) => setPath(e.target.value)}
              />
            </label>
            <button
              disabled={busy || !path.trim()}
              onClick={async () => {
                if (
                  await action("sand_import_repository", {
                    revision: b.revision,
                    viewId,
                    path: path.trim(),
                  })
                )
                  setPath("");
              }}
            >
              导入到白板
            </button>
            {b.workspaces.length > 0 && (
              <>
                <h3>已连接工作区</h3>
                {b.workspaces.map((w) => (
                  <button
                    className="source-choice"
                    key={w.id}
                    disabled={busy}
                    onClick={() =>
                      void action("sand_import_repository", {
                        revision: b.revision,
                        viewId,
                        workspaceId: w.id,
                      })
                    }
                  >
                    <b>{w.label}</b>
                    <small>添加仓库场景 · {w.files} 个已索引文件</small>
                  </button>
                ))}
                <h3>按需添加源码引用</h3>
                <input
                  aria-label="搜索源码素材"
                  placeholder="搜索文件或代码入口"
                  value={sourceQuery}
                  onChange={(e) => setSourceQuery(e.target.value)}
                />
                {sources.map((o) => (
                  <button
                    className="source-choice"
                    key={o.id}
                    draggable={!busy}
                    onDragStart={(e) => drag(e, "object", o.title, {}, o.id)}
                    disabled={busy}
                    onClick={() => create("object", o.title, {}, o.id)}
                  >
                    <b>{o.title}</b>
                    <small>{o.source?.path}</small>
                  </button>
                ))}
              </>
            )}
          </>
        )}
      </div>
      <div className="toolbox-bottom">
        <button onClick={() => showPanel("theme")}>外观</button>
        {b.workspaces.length > 0 && (
          <button onClick={() => showPanel("changes")}>代码改动</button>
        )}
        <small>本次会话 · 不自动保存</small>
      </div>
    </aside>
  );
}
