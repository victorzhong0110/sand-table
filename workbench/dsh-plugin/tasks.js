// DSH-owned execution: correlate the durable prompt rpcId with its actual turn.
// No model calls or parallel agent runtime live here.
import { randomUUID } from "node:crypto";
export function createTaskChannel(ctx) {
  const tasks = new Map();
  const turns = new Map();
  const enabled = () =>
    typeof ctx.get("sessionController")?.prompt === "function" &&
    typeof ctx.on === "function";
  const emit = (task, state, message, results) => {
    task.events.push({
      taskId: task.id,
      boardId: task.boardId,
      state,
      message,
      ...(results?.length ? { results } : {}),
      at: Date.now(),
    });
    task.state = state;
  };
  const dispose = enabled()
    ? ctx.on("session/event", (session, event) => {
        if (event.type === "turn/start") turns.set(session.id, event.data.turn);
        if (event.type === "user/message") {
          const task = tasks.get(event.data?.source?.rpcId);
          if (task?.sessionId === session.id) {
            task.turn = turns.get(session.id);
            emit(task, "running", "AI 正在处理");
          }
        }
        for (const task of tasks.values()) {
          if (
            task.sessionId !== session.id ||
            task.state !== "running" ||
            task.turn !== event.data?.turn
          )
            continue;
          if (event.type === "assistant/message") {
            const text = (event.data.message?.content ?? [])
              .filter((p) => p.type === "text")
              .map((p) => p.text)
              .join("\n");
            if (text)
              emit(task, "running", text, [
                {
                  kind: "text",
                  title: "AI 回复",
                  text,
                  source: `DSH ${session.id} / turn ${task.turn}`,
                },
              ]);
          }
          if (event.type === "tool/result" && !event.data.message?.isError) {
            for (const part of event.data.message?.content ?? []) {
              if (part.type !== "text") continue;
              try {
                const value = JSON.parse(part.text);
                if (
                  value &&
                  typeof value.kind === "string" &&
                  [
                    "paper",
                    "document",
                    "dataset",
                    "data",
                    "file",
                    "resource",
                  ].includes(value.kind)
                )
                  emit(task, "running", "收到插件结果", [
                    {
                      ...value,
                      source:
                        value.source ??
                        `DSH ${session.id} / tool result ${event.seq}`,
                    },
                  ]);
              } catch {
                /* Unstructured tool output belongs in the host transcript. */
              }
            }
          }
          if (event.type === "turn/end") {
            const reason = event.data.reason?.kind;
            emit(
              task,
              reason === "completed"
                ? "done"
                : reason === "aborted"
                  ? "cancelled"
                  : "failed",
              reason === "completed"
                ? "已完成"
                : reason === "aborted"
                  ? "已取消"
                  : `执行结束：${reason ?? "未知原因"}`,
            );
          }
        }
      })
    : undefined;
  return {
    enabled,
    async submit(request, agent, signal) {
      if (!enabled()) throw Error("宿主没有可用的任务及响应通道。");
      if (!request?.instruction?.trim() || !request.boardId)
        throw Error("任务需要指令和 boardId。");
      if (tasks.size >= 200) {
        for (const [id, t] of tasks)
          if (["done", "failed", "cancelled"].includes(t.state))
            tasks.delete(id);
        if (tasks.size >= 200)
          throw Error("未完成任务过多，请先结束现有任务。");
      }
      const id = randomUUID();
      const task = {
        id,
        sessionId: agent.id,
        boardId: request.boardId,
        state: "queued",
        events: [],
      };
      tasks.set(id, task);
      emit(task, "queued", "已提交给宿主会话");
      try {
        const value = await ctx.get("sessionController").prompt(
          {
            requestId: id,
            sessionId: agent.id,
            mode: "queue",
            content: [
              {
                type: "text",
                text: [
                  request.instruction,
                  "",
                  `Sand Table boardId: ${request.boardId}`,
                  `contextVersion: ${request.contextVersion}`,
                  `targets: ${JSON.stringify(request.targets ?? [])}`,
                  "先用 sand_table_read_board / sand_table_read_object 读取最新内容；引用与版本不代替事实。",
                ].join("\n"),
              },
            ],
          },
          signal,
        );
        if (!value?.accepted) throw Error("宿主没有确认接收任务。");
        return { taskId: id };
      } catch (error) {
        tasks.delete(id);
        throw error;
      }
    },
    status(id, agent, after = 0) {
      const task = tasks.get(id);
      if (!task || task.sessionId !== agent.id)
        throw Error("当前会话中找不到该任务。");
      return {
        events: task.events.slice(after),
        cursor: task.events.length,
        state: task.state,
      };
    },
    async cancel(id, agent) {
      const task = tasks.get(id);
      if (!task || task.sessionId !== agent.id)
        throw Error("当前会话中找不到该任务。");
      if (task.state !== "running" || task.turn !== turns.get(agent.id))
        throw Error("只能取消该任务正在执行的轮次。");
      const controller = ctx.get("sessionController");
      if (typeof controller.cancel !== "function")
        throw Error("宿主没有取消通道。");
      await controller.cancel({ sessionId: agent.id });
      // Acknowledging cancellation is not evidence that the turn has ended.
      return { accepted: true };
    },
    dispose() {
      dispose?.();
      tasks.clear();
    },
  };
}
