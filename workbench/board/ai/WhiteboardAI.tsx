import { useEffect, useRef, useState } from "react";
import type { Board } from "../data-client/model.ts";
import type { HostTaskEvent, HostTaskRequest } from "../data-client/objects.ts";
import { aiRequest, aiTargets, type AIScope } from "./context.ts";
import {
  activeTurn,
  AI_STATE_LABELS,
  applyAIEvent,
  type AITurn,
} from "./conversation.ts";

type Thread = { draft: string; scope: AIScope; turns: AITurn[] };
const emptyThread = (): Thread => ({ draft: "", scope: "board", turns: [] });
const suggestions = [
  ["整理结构", "请整理这些内容，按主题分组，并用关系连接有依赖的内容。"],
  [
    "找出遗漏",
    "请检查这些内容有哪些遗漏、矛盾或尚待验证的假设，并把建议放到白板上。",
  ],
  ["总结要点", "请总结这些内容的关键结论和下一步，在白板上新增一张总结便签。"],
] as const;

export function WhiteboardAI({
  board,
  viewId,
  open,
  focusScope,
  ready,
  hostEvents,
  send,
  cancel,
  onClose,
  onConnect,
}: {
  board: Board;
  viewId: string;
  open: boolean;
  focusScope: { scope: AIScope; seq: number };
  ready: boolean;
  hostEvents?: HostTaskEvent[];
  send?: (request: HostTaskRequest) => Promise<{ taskId: string }>;
  cancel?: (taskId: string) => Promise<void>;
  onClose: () => void;
  onConnect: () => void;
}) {
  const key = JSON.stringify([board.workspaceId, board.views[viewId]?.spaceId]);
  const [threads, setThreads] = useState<Record<string, Thread>>({});
  const thread = threads[key] ?? emptyThread();
  const [notice, setNotice] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const submitting = useRef(false);
  const events = useRef(new Map<string, HostTaskEvent[]>());
  const seen = useRef(new WeakSet<HostTaskEvent>());
  const update = (threadKey: string, change: (current: Thread) => Thread) =>
    setThreads((current) => ({
      ...current,
      [threadKey]: change(current[threadKey] ?? emptyThread()),
    }));
  useEffect(() => {
    if (!open) return;
    update(key, (current) => ({ ...current, scope: focusScope.scope }));
    setNotice("");
    input.current?.focus();
  }, [open, focusScope.seq]);
  useEffect(() => {
    setNotice("");
  }, [key]);
  useEffect(() => {
    const incoming = (hostEvents ?? []).filter(
      (event) => !seen.current.has(event),
    );
    if (!incoming.length) return;
    for (const event of incoming) {
      seen.current.add(event);
      events.current.set(
        event.taskId,
        [...(events.current.get(event.taskId) ?? []), event].slice(-40),
      );
    }
    if (events.current.size > 100)
      events.current.delete(events.current.keys().next().value!);
    setThreads((current) =>
      Object.fromEntries(
        Object.entries(current).map(([id, value]) => [
          id,
          {
            ...value,
            turns: value.turns.map((turn) =>
              incoming.reduce(applyAIEvent, turn),
            ),
          },
        ]),
      ),
    );
  }, [hostEvents]);
  useEffect(() => {
    if (open && log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [open, thread.turns]);

  let targets: ReturnType<typeof aiTargets> = [],
    contextError = "";
  try {
    targets = aiTargets(board, viewId, thread.scope);
  } catch (error) {
    contextError = (error as Error).message;
  }
  const active = thread.turns.find(activeTurn);
  async function submit() {
    if (submitting.current || active || !ready || !send) return;
    if (thread.turns.length >= 50) {
      setNotice("本次对话已满 50 条，请清空已结束的对话后继续。");
      return;
    }
    let request: HostTaskRequest;
    try {
      request = aiRequest(board, viewId, thread.scope, thread.draft);
    } catch (error) {
      setNotice((error as Error).message);
      return;
    }
    const id = crypto.randomUUID(),
      text = thread.draft;
    const turn: AITurn = {
      id,
      boardId: request.boardId,
      text,
      targets,
      state: "submitting",
      messages: [],
    };
    submitting.current = true;
    setNotice("");
    update(key, (current) => ({ ...current, turns: [...current.turns, turn] }));
    try {
      const { taskId } = await send(request);
      update(key, (current) => ({
        ...current,
        draft: current.draft === text ? "" : current.draft,
        turns: current.turns.map((item) => {
          if (item.id !== id) return item;
          const accepted: AITurn = { ...item, taskId, state: "queued" };
          const early = events.current.get(taskId);
          return early ? early.reduce(applyAIEvent, accepted) : accepted;
        }),
      }));
    } catch (error) {
      update(key, (current) => ({
        ...current,
        turns: current.turns.map((item) =>
          item.id === id
            ? {
                ...item,
                state: "rejected",
                messages: [
                  (error as Error).message ||
                    "宿主没有接受请求，请检查连接后重试。",
                ],
              }
            : item,
        ),
      }));
    } finally {
      submitting.current = false;
    }
  }

  return (
    <aside
      className={`whiteboard-ai${open ? " studio-inspector" : ""}`}
      aria-label="和 AI 协作"
      hidden={!open}
    >
      <div className="inspector-heading">
        <span>和 AI 协作</span>
        <button type="button" aria-label="收起 AI 协作" onClick={onClose}>
          ×
        </button>
      </div>
      {!ready ? (
        <section className="ai-connect">
          <h2>让 AI 和你一起编辑</h2>
          <p>
            在支持任务提交的宿主中打开白板，即可直接提问、整理内容并收到回应。
          </p>
          <p>
            当前连接没有白板内的对话通道。已连接的 MCP
            客户端可以在自己的对话中读写这张白板。
          </p>
          <button type="button" onClick={onConnect}>
            查看连接方式
          </button>
        </section>
      ) : (
        <>
          <div className="ai-scope">
            <label>
              讨论范围
              <select
                aria-label="AI 讨论范围"
                value={thread.scope}
                onChange={(e) =>
                  update(key, (current) => ({
                    ...current,
                    scope: e.target.value as AIScope,
                  }))
                }
              >
                <option value="board">当前白板</option>
                <option value="selection">当前选区</option>
              </select>
            </label>
            <div className="ai-targets" aria-label="AI 目标预览">
              {contextError ? (
                <p role="status">{contextError}</p>
              ) : (
                <>
                  <small>
                    {targets.length
                      ? `${targets.length} 个对象`
                      : "空白画布，可以从一句话开始"}
                  </small>
                  {targets.slice(0, 5).map((target) => (
                    <span key={target.objectId}>{target.title}</span>
                  ))}
                  {targets.length > 5 && (
                    <small>另有 {targets.length - 5} 个对象</small>
                  )}
                </>
              )}
            </div>
          </div>
          <div
            className="ai-conversation"
            ref={log}
            role="log"
            aria-label="白板协作对话"
            aria-live="polite"
          >
            {!thread.turns.length && (
              <div className="ai-welcome">
                <h2>从一个想法开始</h2>
                <p>说说你想梳理什么，或框选画布上的内容继续讨论。</p>
              </div>
            )}
            {thread.turns.map((turn) => (
              <article className="ai-turn" key={turn.id}>
                <p className="ai-user-message">{turn.text}</p>
                <small className="ai-turn-context">
                  {turn.targets.length
                    ? `提交时包含 ${turn.targets.length} 个对象`
                    : "从空白画布开始"}
                </small>
                <div aria-label="AI 任务状态">
                  <strong>{AI_STATE_LABELS[turn.state]}</strong>
                  {turn.messages.map((message, index) => (
                    <p className="ai-response" key={index}>
                      {message}
                    </p>
                  ))}
                  {turn.state === "running" && turn.taskId && cancel && (
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await cancel(turn.taskId!);
                          setNotice("已请求停止，等待宿主确认。");
                        } catch (error) {
                          setNotice((error as Error).message);
                        }
                      }}
                    >
                      停止 AI
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
          <div className="ai-compose">
            <div className="ai-suggestions">
              {suggestions.map(([label, text]) => (
                <button
                  type="button"
                  key={label}
                  onClick={() => {
                    update(key, (current) => ({ ...current, draft: text }));
                    input.current?.focus();
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            <div>
              <textarea
                ref={input}
                aria-label="给 AI 的编排请求"
                placeholder="描述你的想法，或询问选中的内容…"
                maxLength={8000}
                value={thread.draft}
                onChange={(e) =>
                  update(key, (current) => ({
                    ...current,
                    draft: e.target.value,
                  }))
                }
                onKeyDown={(e) => {
                  if (
                    (e.metaKey || e.ctrlKey) &&
                    e.key === "Enter" &&
                    !e.nativeEvent.isComposing
                  ) {
                    e.preventDefault();
                    void submit();
                  }
                }}
              />
              <div className="ai-compose-actions">
                <small>⌘ / Ctrl + Enter 发送</small>
                <button
                  type="button"
                  onClick={() => void submit()}
                  disabled={
                    !thread.draft.trim() ||
                    Boolean(active) ||
                    Boolean(contextError)
                  }
                >
                  发送
                </button>
              </div>
            </div>
            {notice && <p role="status">{notice}</p>}
            <div className="ai-session-note">
              <small>对话保留到本次页面关闭；白板内容自动保存。</small>
              {thread.turns.length > 0 && (
                <button
                  type="button"
                  disabled={Boolean(active)}
                  onClick={() =>
                    update(key, (current) => ({ ...current, turns: [] }))
                  }
                >
                  清空对话
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </aside>
  );
}
