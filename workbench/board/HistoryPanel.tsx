import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon.tsx";
import type { HistoryRecord, HistorySnapshot } from "../core/history.ts";
import "./history.css";

/** MCP 工具调用：与 board/main.tsx 的 call 同签名。 */
type ToolCall = (name: string, args?: Record<string, unknown>) => Promise<any>;

const kindLabel: Record<HistoryRecord["kind"], string> = {
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
 * 撤销栈与重做栈的分界。
 *
 * 服务端给的记录是「新到旧」：撤销栈在前，重做栈（已撤销、待重做）在后。
 * 重做栈的记录 kind 是 "redo"（core/store.ts 的 history() 按所在的栈给 kind：
 * 撤销栈给 "edit"，重做栈给 "redo"），所以第一条 kind 为 "redo" 的记录
 * 就是重做栈的开始。
 */
function splitStacks(records: HistoryRecord[]) {
  const at = records.findIndex((r) => r.kind === "redo");
  if (at < 0) return { undo: records, redo: [] as HistoryRecord[] };
  return { undo: records.slice(0, at), redo: records.slice(at) };
}

/** 作者是人还是 Agent：一眼看得出。 */
function authorBadge(record: HistoryRecord) {
  const agent = record.authorKind === "agent";
  return (
    <span className={"history-author is-" + record.authorKind}>
      {agent ? (
        <Icon name="ai" size={11} />
      ) : (
        <span className="history-human-dot" aria-hidden="true" />
      )}
      {agent ? "Agent" : "人"}
    </span>
  );
}

/**
 * 白板的可回退历史。
 *
 * 面板只读服务端给的历史快照（core/history.ts 的 HistorySnapshot），
 * 并且只通过 MCP 工具改历史：sand_undo / sand_redo / sand_undo_to。
 * 面板不直接碰 store，也不自己维护历史状态。
 *
 * 记录是「新到旧」：撤销栈在前，重做栈（已撤销、待重做）在后。
 * 撤销栈的记录可以跳到它；重做栈的记录已经不在板面上，只显示为「已撤销」。
 */
export function HistoryPanel({
  history,
  busy,
  call,
  refreshBoard,
  onUndo,
  onRedo,
  onJump,
}: {
  /** 服务端给的历史快照。 */
  history?: HistorySnapshot;
  busy?: boolean;
  /** MCP 工具调用：撤销、重做、跳转都走这里。 */
  call?: ToolCall;
  /** 历史改完把板面拉回来，画布才跟上（不提供就只更新面板）。 */
  refreshBoard?: () => unknown;
  /** 没有工具桥时的回退：上层用同一批 MCP 工具接上。 */
  onUndo?: () => void;
  onRedo?: () => void;
  onJump?: (recordId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [snapshot, setSnapshot] = useState<HistorySnapshot | undefined>(
    history,
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  /* 上层每次渲染都会传一个新的 call 下来，放进 ref 里才不会把读取的时机搅乱。 */
  const callRef = useRef(call);
  callRef.current = call;

  /* 上层给的新快照：没有本地改动在飞的时候才采纳——
     自己刚改完历史时，本地拉回来的快照更新鲜，不能被旧快照盖掉。 */
  useEffect(() => {
    if (inFlight.current) return;
    setSnapshot(history);
  }, [history]);

  const records = snapshot?.records ?? [];
  const visible = expanded ? records : records.slice(0, 10);
  const shown = splitStacks(visible);
  const boardId = snapshot?.boardId ?? history?.boardId;
  const disabled = Boolean(busy) || pending;

  /* 打开面板时从服务端拉一次：上层给的快照最多滞后几秒，
     而面板是「现在能撤什么」的唯一去处，不能拿旧的糊弄人。 */
  useEffect(() => {
    const tool = callRef.current;
    if (!tool || !boardId) return;
    let alive = true;
    void tool("sand_history", { boardId })
      .then((data) => {
        if (alive && data?.records) setSnapshot(data as HistorySnapshot);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [boardId]);

  async function run(op: "undo" | "redo" | "jump", recordId?: string) {
    if (disabled) return;
    setPending(true);
    inFlight.current = true;
    setError("");
    try {
      if (!call) {
        /* 没有工具桥：回退到上层给的回调（它们同样走 MCP 工具）。 */
        if (op === "undo") onUndo?.();
        else if (op === "redo") onRedo?.();
        else if (recordId) onJump?.(recordId);
        return;
      }
      if (!boardId) throw new Error("还不知道白板编号，无法操作历史。");
      if (op === "undo") await call("sand_undo", { boardId });
      else if (op === "redo") await call("sand_redo", { boardId });
      else await call("sand_undo_to", { boardId, recordId: recordId ?? "" });
      /* 历史改完：自己拉一次快照，再把板面拉回来。 */
      const fresh = await call("sand_history", { boardId });
      if (fresh?.records) setSnapshot(fresh as HistorySnapshot);
      if (refreshBoard) await refreshBoard();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <section className="history-panel">
      <div className="history-actions">
        <button
          disabled={disabled || !snapshot?.canUndo}
          onClick={() => void run("undo")}
          title="撤销上一步（Cmd+Z / Ctrl+Z）"
        >
          <Icon name="undo" size={16} />
          撤销
        </button>
        <button
          className="is-redo"
          disabled={disabled || !snapshot?.canRedo}
          onClick={() => void run("redo")}
          title="重做（Cmd+Shift+Z / Ctrl+Shift+Z）"
        >
          <Icon name="undo" size={16} />
          重做
        </button>
      </div>
      {error && (
        <p className="history-error" role="alert">
          {error}
        </p>
      )}
      {!snapshot ? (
        <p className="history-empty">正在读取历史…</p>
      ) : records.length === 0 ? (
        <p className="history-empty">还没有可回退的操作。</p>
      ) : (
        <ol className="history-list">
          {shown.undo.map((r) => (
            <li key={r.id}>
              <button
                className={"history-entry is-" + r.kind + " is-" + r.authorKind}
                disabled={disabled}
                onClick={() => void run("jump", r.id)}
                title="回到这一步之后的内容"
              >
                <span className="history-kind">{kindLabel[r.kind]}</span>
                <span className="history-label">{r.label}</span>
                <small>
                  {clock(r.at)} · {authorBadge(r)} {r.author}
                </small>
              </button>
            </li>
          ))}
          {shown.redo.length > 0 && (
            <li className="history-divider">已撤销 · 待重做</li>
          )}
          {shown.redo.map((r) => (
            <li key={r.id}>
              <div
                className={"history-entry is-undone is-" + r.authorKind}
                title="已撤销：用「重做」把它翻回来"
              >
                <span className="history-kind">已撤销</span>
                <span className="history-label">{r.label}</span>
                <small>
                  {clock(r.at)} · {authorBadge(r)} {r.author}
                </small>
              </div>
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
      {snapshot?.note && (
        <p className="history-note" title={snapshot.note}>
          {snapshot.note}
        </p>
      )}
    </section>
  );
}
