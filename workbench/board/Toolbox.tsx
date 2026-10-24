import { paletteTypes, initialData } from "./domain-ui.ts";
import { Icon } from "./Icon.tsx";
import { useState } from "react";
import type { Board, ComponentPack } from "./data-client/model.ts";
import type { HistorySnapshot } from "./data-client/history.ts";
import { componentTypes, defaultData } from "./data-client/spaces.ts";
import { HistoryPanel } from "./HistoryPanel.tsx";
import "./packs.css";
const groups = [
  { id: "novel", title: "小说", types: ["character", "event", "chapter"] },
  {
    id: "research",
    title: "科研",
    types: ["hypothesis", "evidence", "conclusion"],
  },
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
export function Toolbox({
  board: b,
  viewId,
  mode,
  busy,
  setMode,
  create,
  action,
  call,
  showPanel,
  navigate,
  activeSection = "tools",
  focusInstance,
  close,
  history,
  onUndo,
  onRedo,
  onJump,
}: {
  focusInstance?: (id: string) => void;
  activeSection?: string;
  close?: () => void;
  /** The board's reversible history, shown in the "历史" tab. */
  history?: HistorySnapshot;
  onUndo?: () => void;
  onRedo?: () => void;
  onJump?: (recordId: string) => void;
  board: Board;
  viewId: string;
  mode: string;
  busy: boolean;
  setMode: (m: string) => void;
  create: (
    type: string,
    title: string,
    data?: any,
    objectId?: string,
    size?: { width: number; height: number },
  ) => void;
  action: (name: string, args?: Record<string, unknown>) => Promise<any>;
  /** Calls one tool and throws when the server refuses it, so a failed pack
   * import can show the server's own message. Optional: without it the
   * message still reaches the user through the app-level error bar. */
  call?: (name: string, args?: Record<string, unknown>) => Promise<any>;
  showPanel: (panel: string) => void;
  navigate?: (spaceId: string) => void;
}) {
  const [section, setSection] = useState("components"),
    [group, setGroup] = useState("basic"),
    [query, setQuery] = useState(""),
    [path, setPath] = useState(""),
    [sourceQuery, setSourceQuery] = useState(""),
    [packJson, setPackJson] = useState(""),
    [packUrl, setPackUrl] = useState(""),
    [packError, setPackError] = useState(""),
    [packNotice, setPackNotice] = useState(""),
    [packBusy, setPackBusy] = useState(false),
    [exported, setExported] = useState<{ id: string; json: string }>();
  const palette = paletteTypes().filter(
    (c) =>
      groups.find((g) => g.id === group)!.types.includes(c.type) &&
      c.title.includes(query),
  );
  /* One group per imported pack, after the built-in groups. A pack preset is
     only a preset: it fills in a component that already exists. */
  const packGroups = (b.componentPacks ?? [])
    .map((pack) => ({
      pack,
      items: pack.components.filter((c) => c.title.includes(query)),
    }))
    .filter((g) => !query || g.items.length > 0);
  const packSource = (pack: ComponentPack) =>
    pack.source === "json" ? "粘贴的 JSON" : pack.source.replace(/^url:/, "");
  async function packTool(name: string, args: Record<string, unknown>) {
    if (call) return await call(name, args);
    const result = await action(name, args);
    if (result === undefined)
      throw Error("操作没有成功，服务端的错误说明见页面上方的提示。");
    return result;
  }
  async function importPack(source: { json: string } | { url: string }) {
    setPackError("");
    setPackNotice("");
    setPackBusy(true);
    try {
      const fresh = await action("sand_read_board");
      const revision = (fresh as Board | undefined)?.revision ?? b.revision;
      const result = await packTool("sand_import_component_pack", {
        revision,
        viewId,
        author: "human",
        source,
      });
      /* The server's warnings are part of the answer: a pack written for a
         newer version can be imported, but the person has to be told what
         was kept, dropped or shown as a placeholder. */
      const warnings = (result?.warnings ?? []) as string[];
      const pack = result?.pack;
      setPackNotice(
        warnings.length
          ? `已导入「${pack?.name ?? "组件包"}」，有 ${warnings.length} 条提示：${warnings.join(" ")}`
          : `已导入「${pack?.name ?? "组件包"}」，共 ${pack?.componentCount ?? 0} 个预设。`,
      );
      setPackJson("");
      setPackUrl("");
      /* Read the board again so the new group shows up right away. */
      await action("sand_read_board");
    } catch (e) {
      setPackError(e instanceof Error ? e.message : String(e));
    } finally {
      setPackBusy(false);
    }
  }
  async function removePack(pack: ComponentPack) {
    setPackError("");
    setPackBusy(true);
    try {
      const fresh = await action("sand_read_board");
      const revision = (fresh as Board | undefined)?.revision ?? b.revision;
      await packTool("sand_remove_component_pack", {
        revision,
        packId: pack.id,
        author: "human",
      });
      if (exported?.id === pack.id) setExported(undefined);
      await action("sand_read_board");
    } catch (e) {
      setPackError(e instanceof Error ? e.message : String(e));
    } finally {
      setPackBusy(false);
    }
  }
  async function exportPack(pack: ComponentPack) {
    setPackError("");
    setPackBusy(true);
    try {
      const result = await packTool("sand_export_component_pack", {
        packId: pack.id,
      });
      setExported({
        id: pack.id,
        json: JSON.stringify(result.manifest, null, 2),
      });
    } catch (e) {
      setPackError(e instanceof Error ? e.message : String(e));
    } finally {
      setPackBusy(false);
    }
  }
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
        data: data || initialData(type, title),
        objectId,
      }),
    );
  }
  return (
    <aside className="canvas-toolbox" aria-label="组件工具箱">
      <div className="palette-heading">
        <strong>{activeSection === "boards" ? "画板" : "工具"}</strong>
        <button aria-label="收起面板" onClick={close}>
          ×
        </button>
      </div>
      {activeSection !== "boards" && (
        <>
          <div className="toolbox-nav" role="tablist" aria-label="素材">
            {[
              ["components", "组件"],
              ["presets", "场景"],
              ["sources", "仓库"],
              ["history", "历史"],
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
        </>
      )}
      <div className="toolbox-content">
        {activeSection === "boards" && navigate && (
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
        {activeSection === "boards" && focusInstance && (
          <div className="board-components">
            {b.instances
              .filter((c) => c.spaceId === b.views[viewId]?.spaceId)
              .map((c) => (
                <button
                  key={c.id}
                  aria-label={`定位 ${c.title}`}
                  onClick={() => focusInstance(c.id)}
                >
                  <Icon name={c.type} size={16} />
                  <span>{c.title}</span>
                </button>
              ))}
          </div>
        )}
        {activeSection === "boards" ? null : section === "components" ? (
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
                    <Icon name={c.type} />
                  </span>
                  <span>{c.title}</span>
                  <span className="palette-grip" aria-hidden="true">
                    <Icon name="grip" size={14} />
                  </span>
                </button>
              ))}
            </div>
            {packGroups.map(({ pack, items }) => (
              <section className="pack-group" key={pack.id}>
                <header className="pack-heading">
                  <b className="pack-name">{pack.name}</b>
                  <small className="pack-meta">
                    {pack.author ? pack.author + " · " : ""}
                    {packSource(pack)}
                  </small>
                  <div className="pack-actions">
                    <button
                      disabled={busy || packBusy}
                      onClick={() => void exportPack(pack)}
                    >
                      导出
                    </button>
                    <button
                      disabled={busy || packBusy}
                      onClick={() => void removePack(pack)}
                    >
                      移除
                    </button>
                  </div>
                </header>
                <div className="palette-list">
                  {items.map((c) => {
                    const base = componentTypes.find((t) => t.type === c.type);
                    const size =
                      c.width === undefined && c.height === undefined
                        ? undefined
                        : {
                            width: c.width ?? base?.width ?? 280,
                            height: c.height ?? base?.height ?? 180,
                          };
                    return (
                      <button
                        className="palette-item"
                        key={pack.id + ":" + c.key}
                        disabled={busy || packBusy}
                        draggable={!busy && !packBusy}
                        onDragStart={(e) => drag(e, c.type, c.title, c.data)}
                        onClick={() =>
                          create(c.type, c.title, c.data, undefined, size)
                        }
                        title={"拖入画布，或点击添加" + c.title}
                      >
                        <span className="palette-icon pack" aria-hidden="true">
                          <Icon name={c.icon ?? c.type} />
                        </span>
                        <span>{c.title}</span>
                        <span className="palette-grip" aria-hidden="true">
                          <Icon name="grip" size={14} />
                        </span>
                      </button>
                    );
                  })}
                </div>
                {exported?.id === pack.id && (
                  <textarea
                    className="pack-export"
                    aria-label={pack.name + " 的清单"}
                    readOnly
                    value={exported.json}
                  />
                )}
              </section>
            ))}
            <details className="pack-import">
              <summary>导入组件包</summary>
              <div className="pack-import-body">
                <p className="pack-hint">
                  组件包是一份 JSON
                  清单，只是数据：它只会给这里多出几组预填组件，
                  不会安装新代码，也不会改动任何源码。
                </p>
                <label>
                  粘贴 JSON
                  <textarea
                    aria-label="组件包 JSON"
                    placeholder='{"protocol":"sand-table/component-pack","version":1,…}'
                    value={packJson}
                    onChange={(e) => setPackJson(e.target.value)}
                  />
                </label>
                <button
                  disabled={busy || packBusy || !packJson.trim()}
                  onClick={() => void importPack({ json: packJson.trim() })}
                >
                  从粘贴的 JSON 导入
                </button>
                <label>
                  或粘贴 https:// 链接
                  <input
                    aria-label="组件包链接"
                    placeholder="https://example.com/pack.json"
                    value={packUrl}
                    onChange={(e) => setPackUrl(e.target.value)}
                  />
                </label>
                <button
                  disabled={busy || packBusy || !packUrl.trim()}
                  onClick={() => void importPack({ url: packUrl.trim() })}
                >
                  从链接导入
                </button>
                {packError && (
                  <p className="pack-error" role="alert">
                    {packError}
                  </p>
                )}
                {packNotice && <p className="pack-notice">{packNotice}</p>}
              </div>
            </details>
          </>
        ) : section === "presets" ? (
          <>
            <h2>从一个场景开始</h2>
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
        ) : section === "history" ? (
          <HistoryPanel
            history={history}
            busy={busy}
            /* 撤销、重做、跳转都走 MCP 工具：面板不直接改 store。 */
            call={call}
            refreshBoard={async () => {
              await action("sand_read_board");
            }}
            onUndo={() => onUndo?.()}
            onRedo={() => onRedo?.()}
            onJump={(id) => onJump?.(id)}
          />
        ) : (
          <>
            <h2>导入代码仓库</h2>
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
        {b.workspaces.length > 0 && (
          <button onClick={() => showPanel("changes")}>代码改动</button>
        )}
      </div>
    </aside>
  );
}
