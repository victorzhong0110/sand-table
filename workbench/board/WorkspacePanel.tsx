import { useRef, useState } from "react";
import { Icon } from "./Icon.tsx";
import type { WorkspaceDescriptor } from "./data-client/objects.ts";
import "./workspace.css";

/** 导入完成后给人看的结果。 */
export type WorkspaceImportReport = {
  workspaceId: string;
  title: string;
  counts: {
    objects: number;
    presentations: number;
    relations: number;
    blobs: number;
  };
  degraded: { id: string; reason: string }[];
  external: { kind: string; uri: string; fragment?: string }[];
};

/**
 * 工作空间管理面板。
 *
 * 这是一个**只做展示**的组件：条目由上层传进来，操作也通过回调交出去。
 * 面板自己不读文件、不发请求、不认识存储层——它只知道
 * 「有一堆工作空间」和「用户点了新建 / 切换 / 重命名 / 删除」。
 * 这样服务端（MCP 工具）换实现时，面板不用跟着改。
 */
export type WorkspacePanelProps = {
  /** 工作空间条目。 */
  workspaces: WorkspaceDescriptor[];
  /** 当前活动工作空间。 */
  activeId?: string;
  /** 读不出来的工作空间：跳过但要点名，用户才知道少了什么。 */
  errors?: { id: string; reason: string }[];
  /** 有操作在进行：先把按钮按住，免得连点。 */
  busy?: boolean;
  /** 新建。id 留空表示由服务端决定。 */
  onCreate?: (input: { id?: string; title: string }) => void;
  /** 切换到某个工作空间。 */
  onSwitch?: (id: string) => void;
  /** 改标题。 */
  onRename?: (id: string, title: string) => void;
  /** 删除。 */
  onDelete?: (id: string) => void;
  /** 重新读取列表。 */
  onRefresh?: () => void;
  onExport?: () => void;
  onReload?: () => void;
  /** 读入一份工作空间 JSON。只在 v3 传入。 */
  onImport?: (json: string) => void;
  /** 最近一次导入的结果。 */
  importReport?: WorkspaceImportReport | null;
  recoveryMessage?: string;
};

function clock(at: number) {
  if (!at) return "—";
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes(),
  ).padStart(2, "0")}`;
}

export function WorkspacePanel({
  workspaces,
  activeId,
  errors,
  busy,
  onCreate,
  onSwitch,
  onRename,
  onDelete,
  onRefresh,
  onExport,
  onReload,
  onImport,
  importReport,
  recoveryMessage,
}: WorkspacePanelProps) {
  const [newTitle, setNewTitle] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [importError, setImportError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const disabled = Boolean(busy);

  async function readImportFile(file: File) {
    setImportError("");
    try {
      const text = await file.text();
      onImport?.(text);
    } catch {
      setImportError("这个文件读不出来。请换一个导出的工作空间文件再试。");
    }
  }

  function submitCreate() {
    const title = newTitle.trim();
    if (!title) return;
    onCreate?.({ title });
    setNewTitle("");
  }

  function submitRename(id: string) {
    const title = renameTitle.trim();
    if (!title) return;
    onRename?.(id, title);
    setRenamingId(null);
    setRenameTitle("");
  }

  return (
    <section className="workspace-panel">
      <header className="workspace-header">
        <h2>
          <Icon name="board" size={14} />
          工作空间
        </h2>
        {onRefresh && (
          <button
            className="workspace-refresh"
            disabled={disabled}
            onClick={onRefresh}
            title="重新读取列表"
          >
            刷新
          </button>
        )}
      </header>

      <div className="workspace-actions">
        {onExport && (
          <button disabled={disabled} onClick={onExport}>
            导出工作空间
          </button>
        )}
        {onImport && (
          <>
            <button
              disabled={disabled}
              onClick={() => fileRef.current?.click()}
            >
              导入
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              hidden
              aria-label="选择要导入的工作空间文件"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void readImportFile(file);
              }}
            />
          </>
        )}
        {onReload && (
          <button disabled={disabled} onClick={onReload}>
            保留副本并重新加载
          </button>
        )}
      </div>
      {importError && (
        <p className="workspace-errors" role="alert">
          {importError}
        </p>
      )}
      {importReport && (
        <div role="status">
          <p>
            已导入 {importReport.counts.objects} 个对象、
            {importReport.counts.presentations} 个展示、
            {importReport.counts.relations} 条关系、
            {importReport.counts.blobs} 个附件。
          </p>
          {importReport.degraded.length > 0 && (
            <ul className="workspace-errors">
              {importReport.degraded.map((item) => (
                <li key={`${item.id}:${item.reason}`}>{item.reason}</li>
              ))}
            </ul>
          )}
          {importReport.external.length > 0 && (
            <>
              <p>这些外部资源没有随包带走：</p>
              <ul>
                {importReport.external.map((item) => (
                  <li key={`${item.kind}:${item.uri}:${item.fragment ?? ""}`}>
                    {item.kind} {item.uri}
                    {item.fragment ? `#${item.fragment}` : ""}
                  </li>
                ))}
              </ul>
            </>
          )}
          <button
            disabled={disabled}
            onClick={() => onSwitch?.(importReport.workspaceId)}
          >
            切换到导入的工作空间
          </button>
        </div>
      )}
      {recoveryMessage && <p role="status">{recoveryMessage}</p>}
      {workspaces.length === 0 ? (
        <p className="workspace-empty">还没有工作空间。</p>
      ) : (
        <ul className="workspace-list">
          {workspaces.map((workspace) => {
            const active = workspace.id === activeId;
            const renaming = renamingId === workspace.id;
            return (
              <li
                key={workspace.id}
                className={"workspace-item" + (active ? " is-active" : "")}
              >
                <div className="workspace-main">
                  {renaming ? (
                    <input
                      className="workspace-input"
                      value={renameTitle}
                      autoFocus
                      onChange={(e) => setRenameTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") submitRename(workspace.id);
                        if (e.key === "Escape") setRenamingId(null);
                      }}
                      aria-label="新的标题"
                    />
                  ) : (
                    <span className="workspace-title">{workspace.title}</span>
                  )}
                  <small className="workspace-meta">
                    {workspace.id} · {workspace.boardCount} 板 ·{" "}
                    {workspace.objectCount} 对象 · {clock(workspace.updatedAt)}
                  </small>
                </div>

                <div className="workspace-actions">
                  {renaming ? (
                    <>
                      <button
                        disabled={disabled || !renameTitle.trim()}
                        onClick={() => submitRename(workspace.id)}
                      >
                        保存
                      </button>
                      <button
                        disabled={disabled}
                        onClick={() => setRenamingId(null)}
                      >
                        取消
                      </button>
                    </>
                  ) : (
                    <>
                      {!active && (
                        <button
                          disabled={disabled}
                          onClick={() => onSwitch?.(workspace.id)}
                        >
                          切换
                        </button>
                      )}
                      <button
                        disabled={disabled}
                        onClick={() => {
                          setRenamingId(workspace.id);
                          setRenameTitle(workspace.title);
                          setConfirmingId(null);
                        }}
                      >
                        重命名
                      </button>
                      {confirmingId === workspace.id ? (
                        <>
                          <button
                            className="workspace-danger"
                            disabled={disabled}
                            onClick={() => {
                              setConfirmingId(null);
                              onDelete?.(workspace.id);
                            }}
                          >
                            确认删除
                          </button>
                          <button
                            disabled={disabled}
                            onClick={() => setConfirmingId(null)}
                          >
                            取消
                          </button>
                        </>
                      ) : (
                        <button
                          className="workspace-danger"
                          disabled={disabled || active}
                          title={
                            active
                              ? "当前正在用的工作空间不能删"
                              : "删除工作空间"
                          }
                          onClick={() => setConfirmingId(workspace.id)}
                        >
                          删除
                        </button>
                      )}
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {errors && errors.length > 0 && (
        <ul className="workspace-errors" role="alert">
          {errors.map((error) => (
            <li key={error.id}>
              <strong>{error.id}</strong>：{error.reason}
            </li>
          ))}
        </ul>
      )}

      <div className="workspace-create">
        <input
          className="workspace-input"
          value={newTitle}
          placeholder="新工作空间的标题"
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submitCreate();
          }}
          aria-label="新工作空间的标题"
        />
        <button disabled={disabled || !newTitle.trim()} onClick={submitCreate}>
          新建
        </button>
      </div>
    </section>
  );
}
