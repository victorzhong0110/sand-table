import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { HistorySnapshot, TimelineRecord } from "./data-client/history.ts";
import { Icon } from "./Icon.tsx";
import {
  layoutHistory,
  type HistoryListEntry,
  type HistoryRow,
} from "./history-layout.ts";
import "./history.css";

type ToolCall = (name: string, args?: Record<string, unknown>) => Promise<any>;

function clock(at: number) {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(
    date.getMinutes(),
  ).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
}

function explain(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);
  try {
    const parsed = JSON.parse(raw) as { code?: unknown; message?: unknown };
    if (typeof parsed.message === "string" && parsed.message)
      return {
        code: typeof parsed.code === "string" ? parsed.code : "",
        message: parsed.message,
      };
  } catch {
    /* 工具失败时文本是 JSON；别的错误保持原样。 */
  }
  return { code: "", message: raw || "这一步没有完成。请再试一次。" };
}

function toEntries(records: readonly TimelineRecord[]): HistoryListEntry[] {
  return records.map((record) => ({
    id: record.id,
    parentId: record.parentId ?? null,
    seq: record.seq,
    current: record.current,
    onCurrentPath: record.onPath,
  }));
}

const STATE_LABEL: Record<string, string> = {
  current: "当前",
  redo: "可重做",
  branch: "旧分支",
};

export function HistoryPanel({
  history,
  busy,
  call,
  refreshBoard,
  onUndo,
  onRedo,
  onJump,
}: {
  history?: HistorySnapshot;
  busy?: boolean;
  call?: ToolCall;
  refreshBoard?: () => unknown;
  onUndo?: () => void;
  onRedo?: () => void;
  onJump?: (recordId: string) => void;
}) {
  const [snapshot, setSnapshot] = useState<HistorySnapshot | undefined>(
    history,
  );
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [active, setActive] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const callRef = useRef(call);
  callRef.current = call;
  const listRef = useRef<HTMLOListElement>(null);
  const rowRefs = useRef<Array<HTMLLIElement | null>>([]);

  useEffect(() => {
    if (inFlight.current) return;
    setSnapshot(history);
  }, [history]);

  const boardId = snapshot?.boardId ?? history?.boardId;
  useEffect(() => {
    const tool = callRef.current;
    if (!tool || !boardId) return;
    let alive = true;
    void tool("sand_history", { boardId, limit: 100 })
      .then((data) => {
        if (alive && data?.records) setSnapshot(data as HistorySnapshot);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [boardId]);

  const records = snapshot?.records ?? [];
  const byId = useMemo(
    () => new Map(records.map((record) => [record.id, record])),
    [records],
  );
  const rows = useMemo(
    () => layoutHistory(toEntries(records), expanded),
    [records, expanded],
  );
  const current = records.find((record) => record.current);
  const canUndo = Boolean(current?.parentId);
  const canRedo = rows.some(
    (row) => row.kind === "entry" && row.state === "redo",
  );
  const disabled = Boolean(busy) || pending;
  const undoReason = canUndo
    ? disabled
      ? "正在处理上一步，请稍候再撤销。"
      : "撤销上一步"
    : "已经是最早的一步，没有可以撤销的操作。";
  const redoReason = canRedo
    ? disabled
      ? "正在处理上一步，请稍候再重做。"
      : "重做下一步"
    : "没有可以重做的步骤。";

  useEffect(() => {
    const index = rows.findIndex(
      (row) => row.kind === "entry" && byId.get(row.id)?.current,
    );
    if (index >= 0) setActive(index);
  }, [snapshot?.cursorId]);

  useEffect(() => {
    rowRefs.current[active]?.scrollIntoView({ block: "nearest" });
  }, [active, rows]);

  async function run(op: "undo" | "redo" | "jump", recordId?: string) {
    if (disabled) return;
    setPending(true);
    inFlight.current = true;
    setError("");
    try {
      if (!call) {
        if (op === "undo") onUndo?.();
        else if (op === "redo") onRedo?.();
        else if (recordId) onJump?.(recordId);
        return;
      }
      if (!boardId) throw new Error("还不知道是哪张白板，暂时不能改历史。");
      const fresh =
        op === "undo"
          ? await call("sand_undo", { boardId })
          : op === "redo"
            ? await call("sand_redo", { boardId })
            : await call("sand_undo_to", { boardId, recordId: recordId ?? "" });
      if (fresh?.records) setSnapshot(fresh as HistorySnapshot);
      if (refreshBoard) await refreshBoard();
    } catch (caught) {
      const described = explain(caught);
      setError(
        described.code === "HISTORY_CONFLICT"
          ? described.message
          : described.message,
      );
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  function toggleBranch(atId: string) {
    setExpanded((currentSet) => {
      const next = new Set(currentSet);
      if (next.has(atId)) next.delete(atId);
      else next.add(atId);
      return next;
    });
  }

  function move(delta: number) {
    if (!rows.length) return;
    setActive((index) => Math.min(rows.length - 1, Math.max(0, index + delta)));
  }

  function branchNear(
    index: number,
  ): Extract<HistoryRow, { kind: "branches" }> | undefined {
    const row = rows[index];
    if (row?.kind === "branches") return row;
    const next = rows[index + 1];
    if (
      row?.kind === "entry" &&
      next?.kind === "branches" &&
      next.atId === row.id
    )
      return next;
    return undefined;
  }

  function onListKey(event: ReactKeyboardEvent) {
    if (
      event.target instanceof HTMLElement &&
      event.target.closest("input, textarea")
    )
      return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      event.stopPropagation();
      move(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      move(-1);
      return;
    }
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      const marker = branchNear(active);
      if (!marker) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "ArrowRight" && !marker.expanded)
        toggleBranch(marker.atId);
      if (event.key === "ArrowLeft" && marker.expanded)
        toggleBranch(marker.atId);
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    event.stopPropagation();
    const row = rows[active];
    if (!row) return;
    if (row.kind === "branches") toggleBranch(row.atId);
    else void run("jump", row.id);
  }

  return (
    <section className="history-panel">
      {error && (
        <p className="history-error" role="alert">
          {error}
        </p>
      )}
      <div className="history-actions">
        <button
          type="button"
          disabled={disabled || !canUndo}
          title={undoReason}
          onClick={() => void run("undo")}
        >
          <Icon name="undo" size={16} />
          撤销
        </button>
        <button
          type="button"
          className="is-redo"
          disabled={disabled || !canRedo}
          title={redoReason}
          onClick={() => void run("redo")}
        >
          <Icon name="undo" size={16} />
          重做
        </button>
      </div>
      {(!canUndo || !canRedo) && records.length > 0 && (
        <p className="history-why">
          {!canUndo && undoReason}
          {!canUndo && !canRedo && " "}
          {!canRedo && redoReason}
        </p>
      )}
      {!snapshot ? (
        <p className="history-empty">正在读取历史…</p>
      ) : records.length === 0 ? (
        <p className="history-empty">还没有可以回退的操作。</p>
      ) : (
        <ol
          className="history-timeline"
          ref={listRef}
          tabIndex={0}
          autoFocus
          aria-label="历史"
          onKeyDown={onListKey}
        >
          {rows.map((row, index) => {
            if (row.kind === "branches") {
              return (
                <li
                  key={`branches:${row.atId}`}
                  ref={(node) => {
                    rowRefs.current[index] = node;
                  }}
                  className={
                    "history-node history-branch-row" +
                    (index === active ? " is-active" : "")
                  }
                >
                  <button
                    type="button"
                    className="history-branches"
                    aria-expanded={row.expanded}
                    onClick={() => {
                      setActive(index);
                      toggleBranch(row.atId);
                    }}
                  >
                    {row.count} 个分支
                  </button>
                </li>
              );
            }
            const record = byId.get(row.id);
            if (!record) return null;
            const label = STATE_LABEL[row.state];
            const agent = record.authorKind === "agent";
            return (
              <li
                key={record.id}
                ref={(node) => {
                  rowRefs.current[index] = node;
                }}
                className={
                  "history-node is-" +
                  record.authorKind +
                  " is-" +
                  row.state +
                  (index === active ? " is-active" : "")
                }
                style={{ paddingLeft: row.indent * 16 }}
              >
                <button
                  type="button"
                  className="history-entry"
                  data-state={row.state}
                  disabled={disabled}
                  aria-current={row.state === "current" ? "true" : undefined}
                  title={record.label}
                  onClick={() => {
                    setActive(index);
                    void run("jump", record.id);
                  }}
                >
                  <span className="history-dot" aria-hidden="true" />
                  <span className="history-body">
                    <span className="history-label">{record.label}</span>
                    <small>
                      {clock(record.at)}
                      <span
                        className={"history-author is-" + record.authorKind}
                      >
                        {agent ? (
                          <Icon name="ai" size={11} />
                        ) : (
                          <span
                            className="history-human-dot"
                            aria-hidden="true"
                          />
                        )}
                        {agent ? "Agent" : "人"}
                      </span>
                    </small>
                  </span>
                  {label && (
                    <span className={"history-tag is-" + row.state}>
                      {label}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
