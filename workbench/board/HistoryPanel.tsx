import { useState } from "react";
import { Icon } from "./Icon.tsx";
import type { HistoryEntry, HistorySnapshot } from "../core/history.ts";
import "./history.css";

const kindLabel: Record<HistoryEntry["kind"], string> = {
  edit: "编辑",
  undo: "撤销",
  redo: "重做",
};

function clock(at: number) {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes(),
  ).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

/**
 * The board's reversible history.
 *
 * Every write is a record on one history, and so is every undo: the undo is
 * pushed, never popped, and it carries the author that made it. Clicking a
 * record jumps the board to the content that record produced; the jump is
 * recorded like any other step.
 */
export function HistoryPanel({
  history,
  busy,
  onUndo,
  onRedo,
  onJump,
}: {
  history?: HistorySnapshot;
  busy?: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onJump: (recordId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const records = history?.records ?? [];
  const visible = expanded ? records : records.slice(-10);
  return (
    <section className="history-panel">
      <div className="history-actions">
        <button
          disabled={busy || !history?.canUndo}
          onClick={onUndo}
          title="撤销上一步（Cmd+Z / Ctrl+Z）"
        >
          <Icon name="undo" size={16} />
          撤销
        </button>
        <button
          disabled={busy || !history?.canRedo}
          onClick={onRedo}
          title="重做（Cmd+Shift+Z / Ctrl+Shift+Z）"
        >
          <Icon name="undo" size={16} />
          重做
        </button>
      </div>
      {records.length === 0 ? (
        <p className="history-empty">还没有可回退的操作。</p>
      ) : (
        <ol className="history-list">
          {visible
            .slice()
            .reverse()
            .map((r) => (
              <li key={r.id}>
                <button
                  className={
                    "history-entry is-" + r.kind + (r.current ? " is-current" : "")
                  }
                  disabled={busy}
                  onClick={() => onJump(r.id)}
                  title="回到这一步之后的内容"
                  aria-current={r.current ? "true" : undefined}
                >
                  <span className="history-kind">{kindLabel[r.kind]}</span>
                  <span className="history-label">{r.label}</span>
                  <small>
                    {clock(r.at)} · {r.author}
                  </small>
                </button>
              </li>
            ))}
        </ol>
      )}
      {records.length > 10 && (
        <button
          className="history-more"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
        >
          {expanded ? "收起" : `显示全部 ${records.length} 条`}
        </button>
      )}
      <p className="history-note" title={history?.note}>
        每一次写入都在同一条历史上，撤销也是一条记录：Cmd+Z 一步步往回走，Cmd+Shift+Z
        往回走一步；被撤掉的那一步可以再被翻回来。回退只回退白板内容，
        不会绕过「人确认」那道闸。
      </p>
    </section>
  );
}
