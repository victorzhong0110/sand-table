import { Icon } from "./Icon.tsx";
import { useState } from "react";
import type { Board } from "./data-client/model.ts";
import { usePackCatalog, type PaletteEntry } from "./packs/catalog.ts";
import "./packs.css";
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
  openPackSettings,
}: {
  focusInstance?: (id: string) => void;
  activeSection?: string;
  close?: () => void;
  openPackSettings?: () => void;
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
    needsFields?: boolean,
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
    [group, setGroup] = useState("base"),
    [query, setQuery] = useState(""),
    [path, setPath] = useState(""),
    [sourceQuery, setSourceQuery] = useState(""),
    [packError, setPackError] = useState("");
  const catalog = usePackCatalog(call, b.id, b.workspaceId, b.revision);
  const matching = (title: string, description = "") =>
    `${title} ${description}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase());
  const palette = catalog.types.filter(
    (item) =>
      (query.trim().length > 0 || item.pack === group) &&
      matching(item.title, item.description),
  );
  const templateBoardId = b.views[viewId]?.spaceId ?? b.id;
  const needsFields = (item: PaletteEntry, data: Record<string, unknown>) =>
    item.required.some(
      (key) => !Object.prototype.hasOwnProperty.call(data, key),
    ) || Object.keys(data).length < item.minProperties;
  async function applyTemplate(templateId: string) {
    if (!call) return;
    setPackError("");
    try {
      if (!b.workspaceId) throw Error("工作空间尚未准备好，请重新打开工具箱。");
      await call("app_edit", {
        workspaceId: b.workspaceId,
        commands: [
          { op: "template.apply", templateId, boardId: templateBoardId },
        ],
      });
    } catch (error) {
      setPackError(error instanceof Error ? error.message : String(error));
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
    size?: { width: number; height: number },
    requiresFields = false,
  ) {
    e.dataTransfer.effectAllowed = "copy";
    e.dataTransfer.setData(
      "application/x-sand-component",
      JSON.stringify({
        type,
        title,
        data: data ?? {},
        objectId,
        size,
        requiresFields,
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
            {catalog.loading && <p role="status">正在读取组件…</p>}
            {catalog.error && <p role="alert">{catalog.error}</p>}
            <div className="component-categories">
              {catalog.packs
                .filter((pack) => pack.enabled)
                .map((pack) => (
                  <button
                    key={pack.id}
                    aria-pressed={group === pack.id}
                    onClick={() => setGroup(pack.id)}
                  >
                    {pack.title}
                  </button>
                ))}
            </div>
            <div className="palette-list">
              {palette.map((item) => {
                const data = item.defaults;
                return (
                  <button
                    className="palette-item"
                    key={item.type}
                    disabled={busy}
                    draggable={!busy}
                    onDragStart={(event) =>
                      drag(
                        event,
                        item.type,
                        item.title,
                        data,
                        undefined,
                        item.size,
                        needsFields(item, data),
                      )
                    }
                    onClick={() =>
                      create(
                        item.type,
                        item.title,
                        data,
                        undefined,
                        item.size,
                        needsFields(item, data),
                      )
                    }
                    title={item.description || item.title}
                  >
                    <span className="palette-icon pack" aria-hidden="true">
                      <Icon name={item.icon} />
                    </span>
                    <span>{item.title}</span>
                    <span className="palette-grip" aria-hidden="true">
                      <Icon name="grip" size={14} />
                    </span>
                  </button>
                );
              })}
            </div>
            {!catalog.loading && !palette.length && (
              <p className="pack-hint">这里没有匹配的组件。</p>
            )}
            <details className="pack-import">
              <summary>导入组件包</summary>
              <p className="pack-hint">组件包在设置中导入和管理。</p>
              <button onClick={openPackSettings}>打开组件包设置</button>
            </details>
          </>
        ) : section === "presets" ? (
          <>
            <h2>模板</h2>
            {catalog.templates.map((template) => (
              <button
                className="preset-choice"
                key={`${template.pack}:${template.id}`}
                disabled={busy}
                onClick={() => void applyTemplate(template.id)}
              >
                <b>{template.title}</b>
              </button>
            ))}
            {!catalog.templates.length && (
              <p className="pack-hint">当前没有可用模板。</p>
            )}
            <h2>预设</h2>
            {catalog.types.flatMap((item) =>
              item.presets.map((preset, index) => (
                <button
                  className="preset-choice"
                  key={`${item.type}:${preset.key}:${index}`}
                  disabled={busy}
                  onClick={() =>
                    create(
                      item.type,
                      preset.title,
                      { ...item.defaults, ...preset.data },
                      undefined,
                      {
                        width: preset.width ?? item.size?.width ?? 280,
                        height: preset.height ?? item.size?.height ?? 180,
                      },
                      needsFields(item, { ...item.defaults, ...preset.data }),
                    )
                  }
                >
                  <b>{preset.title}</b>
                  <span>{item.title}</span>
                </button>
              )),
            )}
            {packError && (
              <p className="pack-error" role="alert">
                {packError}
              </p>
            )}
          </>
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
