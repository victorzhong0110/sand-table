import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon.tsx";
import { indentOf } from "./history-layout.ts";
import type { HistorySnapshot, TimelineRecord } from "./data-client/history.ts";
import "./history.css";

/** MCP 工具调用：与 board/main.tsx 的 call 同签名。 */
type ToolCall = (name: string, args?: Record<string, unknown>) => Promise<any>;

function clock(at: number) {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes(),
  ).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

/**
 * 这一条在时间线上的位置标签。
 *
 * - 当前：板面正停在这里。
 * - 旧分支：被后来的编辑分叉取代了，但**仍然可达**（可以跳回去）。
 * - 可重做：在游标之后，还能前滚回去。
 */
function stateTag(record: TimelineRecord) {
  if (record.current) return { text: "当前", className: "is-current" };
  if (record.branch) return { text: "旧分支", className: "is-branch" };
  if (record.ahead) return { text: "可重做", className: "is-ahead" };
  return undefined;
}

/** 作者是人还是 Agent：一眼看得出。 */
function authorBadge(record: TimelineRecord) {
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
 * 白板的时间线历史。
 *
 * 面板只读服务端给的历史快照（core/history.ts 的 HistorySnapshot），
 * 并且只通过 MCP 工具改历史：sand_undo / sand_redo / sand_undo_to。
 * 面板不直接碰 store，也不自己维护历史状态。
 *
 * 记录是一条**时间线**（不是两列）：按创建顺序排成一条线，
 * 当前位置高亮，被分叉取代但仍可达的旧分支照样显示、也能跳过去。
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
  /* 当前位置那一行：展开时把它滚进视野，省得自己找。 */
  const currentRef = useRef<HTMLLIElement | null>(null);

  /* 上层给的新快照：没有本地改动在飞的时候才采纳——
     自己刚改完历史时，本地拉回来的快照更新鲜，不能被旧快照盖掉。 */
  useEffect(() => {
    if (inFlight.current) return;
    setSnapshot(history);
  }, [history]);

  const records = snapshot?.records ?? [];
  /* 折叠时只留最近的一段：时间线是按时间正序的，最近的在末尾。 */
  const visible = expanded ? records : records.slice(-10);
  const boardId = snapshot?.boardId ?? history?.boardId;
  const disabled = Boolean(busy) || pending;

  useEffect(() => {
    if (!expanded) return;
    currentRef.current?.scrollIntoView({ block: "nearest" });
  }, [expanded, snapshot?.cursorId]);

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
        <ol className="history-timeline">
          {visible.map((record) => {
            const tag = stateTag(record);
            return (
              <li
                key={record.id}
                ref={record.current ? currentRef : undefined}
                className={
                  "history-node is-" +
                  record.authorKind +
                  (tag ? " " + tag.className : "")
                }
                style={{ paddingLeft: `${indentOf(record) * 16}px` }}
              >
                <button
                  className="history-entry"
                  disabled={disabled}
                  onClick={() => void run("jump", record.id)}
                  aria-current={record.current ? "true" : undefined}
                  title={
                    record.current
                      ? "板面现在停在这一步"
                      : "回到这一步之后的内容"
                  }
                >
                  <span className="history-dot" aria-hidden="true" />
                  <span className="history-body">
                    <span className="history-label" title={record.label}>
                      {record.label}
                    </span>
                    <small>
                      {clock(record.at)} · {authorBadge(record)} {record.author}
                    </small>
                  </span>
                  {tag && (
                    <span className={"history-tag " + tag.className}>
                      {tag.text}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
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
