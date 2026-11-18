import { useEffect, useRef, useState } from "react";
import type { Board } from "../data-client/model.ts";
import type { HostBridge } from "../../core/host-bridge.ts";
import type {
  HostTaskEvent,
  HostTaskRequest,
  HostTaskTimeline,
} from "../data-client/objects.ts";
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
  follow,
  reconcile,
  onClose,
  onConnect,
}: {
  board: Board;
  viewId: string;
  open: boolean;
  focusScope: { scope: AIScope; seq: number };
  ready: boolean;
  hostEvents?: HostTaskEvent[];
  send?: HostBridge["submitTask"];
  follow?: HostBridge["followTasks"];
  reconcile?: HostBridge["reconcileTask"];
  cancel?: HostBridge["cancelTask"];
  onClose: () => void;
  onConnect: () => void;
}) {
  const key = JSON.stringify([board.workspaceId, board.views[viewId]?.spaceId]);
  const [threads, setThreads] = useState<Record<string, Thread>>({});
  const thread = threads[key] ?? emptyThread();
  const [notice, setNotice] = useState("");
  const [projection, setProjection] = useState<{
    key: string;
    value: HostTaskTimeline;
  }>();
  const [projectionError, setProjectionError] = useState("");
  const snapshot = projection?.key === key ? projection.value : undefined;
  const followRef = useRef(follow);
  followRef.current = follow;
  const recoverable = !!follow;
  const [refresh, refreshTasks] = useState(0);
  useEffect(() => {
    const workspaceId = board.workspaceId;
    const boardId = board.views[viewId]?.spaceId;
    if (!open || !recoverable || !workspaceId || !boardId) return;
    setProjectionError("");
    let stopped = false,
      busy = false;
    const poll = async () => {
      if (busy) return;
      busy = true;
      try {
        const value = await followRef.current!({ workspaceId, boardId });
        if (stopped) return;
        setProjection({ key, value });
        const ids = new Set(value.tasks.map((task) => task.taskId));
        setThreads((current) => {
          const entry = current[key];
          if (!entry || !entry.turns.some((turn) => ids.has(turn.id)))
            return current;
          return {
            ...current,
            [key]: {
              ...entry,
              turns: entry.turns.filter((turn) => !ids.has(turn.id)),
            },
          };
        });
        setProjectionError("");
      } catch {
        if (!stopped)
          setProjectionError("与宿主的连接正在恢复，进行中的任务状态待核对。");
      } finally {
        busy = false;
      }
    };
    void poll();
    const timer = setInterval(() => {
      if (!document.hidden) void poll();
    }, 1200);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [key, open, recoverable, refresh]);
  const restored: AITurn[] = (snapshot?.tasks ?? []).map((task) => ({
    id: task.taskId,
    taskId: task.taskId,
    boardId: task.boardId,
    text: task.instruction,
    targets: task.targets.map((target) => ({ ...target, title: "" })),
    state:
      projectionError && ["queued", "running", "waiting"].includes(task.state)
        ? "waiting"
        : task.state,
    messages: task.messages,
    snapshot: task,
  }));
  const restoredIds = new Set(restored.map((turn) => turn.id));
  const turns = [
    ...restored,
    ...thread.turns.filter(
      (turn) =>
        !restoredIds.has(turn.id) &&
        (!recoverable ||
          (turn.session?.id === snapshot?.session.id &&
            turn.session?.createdAt === snapshot?.session.createdAt)),
    ),
  ];

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
  }, [open, thread.turns, snapshot]);

  let targets: ReturnType<typeof aiTargets> = [],
    contextError = "";
  try {
    targets = aiTargets(board, viewId, thread.scope);
  } catch (error) {
    contextError = (error as Error).message;
  }
  const active = turns.find(
    (turn) => activeTurn(turn) && !(recoverable && turn.state === "waiting"),
  );
  async function submit() {
    if (
      submitting.current ||
      active ||
      !ready ||
      !send ||
      (recoverable && (!snapshot || projectionError))
    )
      return;
    if (!recoverable && thread.turns.length >= 50) {
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
      session: snapshot?.session,
      state: "submitting",
      messages: [],
    };
    submitting.current = true;
    setNotice("");
    update(key, (current) => ({ ...current, turns: [...current.turns, turn] }));
    try {
      const { taskId, state } = await send({
        ...request,
        requestId: id,
        displayText: text.trim(),
        ...(snapshot
          ? {
              sessionId: snapshot.session.id,
              sessionCreatedAt: snapshot.session.createdAt,
            }
          : {}),
      });
      refreshTasks((n) => n + 1);
      update(key, (current) => ({
        ...current,
        draft: current.draft === text ? "" : current.draft,
        turns: current.turns.map((item) => {
          if (item.id !== id) return item;
          const accepted: AITurn = {
            ...item,
            taskId,
            state: state ?? "queued",
          };
          const early = events.current.get(taskId);
          return early ? early.reduce(applyAIEvent, accepted) : accepted;
        }),
      }));
    } catch (error) {
      const unknown =
        recoverable && !(error as { declined?: boolean }).declined;
      update(key, (current) => ({
        ...current,
        turns: current.turns.map((item) =>
          item.id === id
            ? {
                ...item,
                state: unknown ? "waiting" : "rejected",
                messages: [
                  unknown
                    ? "提交状态待核对。恢复连接后会查询原请求。"
                    : (error as Error).message ||
                      "宿主没有接受请求，请检查连接。",
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
            {!turns.length && (
              <div className="ai-welcome">
                <h2>从一个想法开始</h2>
                <p>说说你想梳理什么，或框选画布上的内容继续讨论。</p>
              </div>
            )}
            {turns.map((turn) => (
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
                  {turn.snapshot?.reason && <p>{turn.snapshot.reason}</p>}
                  {turn.snapshot?.deliveries.map((item) => (
                    <p key={item.operationId}>
                      {item.state === "written"
                        ? "作品已写入原白板"
                        : "作品待核对"}
                      {item.reason && item.state !== "written"
                        ? ` · ${item.reason}`
                        : ""}
                    </p>
                  ))}
                  {reconcile &&
                    turn.snapshot?.deliveries.some(
                      (item) => item.state === "pending",
                    ) && (
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            await reconcile({
                              taskId: turn.snapshot!.taskId,
                              session: turn.snapshot!.session,
                            });
                            refreshTasks((n) => n + 1);
                          } catch (error) {
                            setNotice((error as Error).message);
                          }
                        }}
                      >
                        核对交付
                      </button>
                    )}
                  {turn.state === "running" &&
                    turn.taskId &&
                    cancel &&
                    (!recoverable || turn.snapshot) && (
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            await cancel(turn.taskId!, turn.snapshot?.session);
                            refreshTasks((n) => n + 1);
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
                    Boolean(contextError) ||
                    (recoverable && (!snapshot || Boolean(projectionError)))
                  }
                >
                  发送
                </button>
              </div>
            </div>
            {(notice || projectionError) && (
              <p role="status">{notice || projectionError}</p>
            )}
            <div className="ai-session-note">
              <small>
                {recoverable
                  ? snapshot
                    ? `DSH 会话 ${snapshot.session.id}`
                    : "正在核对 DSH 会话"
                  : "当前宿主仅在此页面保留对话。"}
              </small>
              {!recoverable && thread.turns.length > 0 && (
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
