import { createHash } from "node:crypto";
import { z } from "zod";
import {
  artifact,
  binding,
  delivery,
  record,
} from "../server/host/contracts.ts";

export const RECORD_TYPE = "plugin:sand-table/workbench-v1";
export const ARTIFACT_TOOL = "sand_table_publish_artifact";
export const terminal = (state) =>
  ["done", "failed", "cancelled"].includes(state);

export function taskProjection(pluginRecordOf) {
  function init(header, inherited = 0) {
    return {
      session: { id: header.id, createdAt: header.createdAt },
      inherited,
      seq: -1,
      turn: null,
      users: 0,
      active: null,
      calls: {},
      tasks: {},
    };
  }
  function apply(state, event) {
    if (event.seq < state.inherited || event.seq <= state.seq) return state;
    const next = { ...state, seq: event.seq };
    const update = (id, fn) => {
      const task = state.tasks[id];
      if (task) next.tasks = { ...state.tasks, [id]: fn(task) };
    };
    const plugin = pluginRecordOf(event);
    if (plugin?.type === RECORD_TYPE) {
      const decoded = record.safeParse(plugin.data);
      if (!decoded.success) return next;
      const data = decoded.data;
      if (data.kind === "binding") {
        const b = data.binding;
        if (
          b.session.id !== state.session.id ||
          b.session.createdAt !== state.session.createdAt ||
          state.tasks[b.requestId]
        )
          return next;
        next.tasks = {
          ...state.tasks,
          [b.requestId]: {
            binding: b,
            state: "waiting",
            messages: [],
            deliveries: {},
            started: event.time,
            updated: event.time,
          },
        };
      } else {
        update(data.requestId, (task) => {
          if (data.kind === "accepted" && task.state === "waiting")
            return { ...task, state: "queued", updated: event.time };
          if (data.kind === "delivery") {
            const id = data.delivery.operationId;
            const current = task.deliveries[id];
            if (
              !current ||
              current.recorded ||
              current.delivery.seq !== data.delivery.seq
            )
              return task;
            return {
              ...task,
              deliveries: {
                ...task.deliveries,
                [id]: { ...current, recorded: true },
              },
            };
          }
          const entry = task.deliveries[data.operationId];
          if (!entry || entry.state === "written") return task;
          if (data.kind === "written" || data.kind === "delivery-error")
            return {
              ...task,
              deliveries: {
                ...task.deliveries,
                [data.operationId]: {
                  ...entry,
                  ...data,
                  state: data.kind === "written" ? "written" : "pending",
                },
              },
            };
          return task;
        });
      }
      return next;
    }
    const data = event.data;
    if (event.type === "turn/start") {
      next.turn = data.turn;
      next.users = 0;
      next.active = null;
      next.calls = {};
    }
    if (
      event.type === "user/message" &&
      state.turn !== null &&
      data.source?.kind === "user"
    ) {
      next.users++;
      const id = data.source.rpcId;
      if (
        typeof id === "string" &&
        Object.hasOwn(state.tasks, id) &&
        !terminal(state.tasks[id].state)
      ) {
        next.active = state.users === 0 ? id : null;
        update(id, (task) => ({
          ...task,
          state: "running",
          turn: state.turn,
          updated: event.time,
        }));
      } else {
        next.active = null;
      }
    }
    if (data?.turn !== state.turn || state.turn === null) return next;
    if (
      event.type === "tool/call" &&
      state.active &&
      data.name === ARTIFACT_TOOL
    )
      next.calls = { ...state.calls, [data.callId]: true };
    if (event.type === "tool/result" && state.active) {
      const task = state.tasks[state.active];
      const message = data.message;
      const part =
        message?.content?.length === 1 ? message.content[0] : undefined;
      if (
        !message?.isError &&
        Object.hasOwn(state.calls, message?.toolCallId) &&
        part?.type === "text" &&
        part.text.length <= 150000
      ) {
        try {
          const payload = JSON.parse(part.text);
          if (payload.protocol !== "sand-table/artifact-v1") return next;
          const value = artifact.parse(payload.artifact);
          const b = task.binding;
          const operationId = createHash("sha256")
            .update(
              JSON.stringify([
                b.workspaceNamespace,
                b.boardId,
                state.session,
                b.requestId,
                data.turn,
                data.step,
                message.toolCallId,
              ]),
            )
            .digest("hex");
          if (!task.deliveries[operationId])
            update(state.active, (t) => ({
              ...t,
              deliveries: {
                ...t.deliveries,
                [operationId]: {
                  delivery: { operationId, seq: event.seq, artifact: value },
                  state: "pending",
                  recorded: false,
                },
              },
            }));
        } catch {
          /* Invalid payload stays in the DSH tool transcript. */
        }
      }
    }
    if (event.type === "assistant/message" && state.active) {
      const message = (data.message?.content ?? [])
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")
        .slice(0, 6000);
      if (message)
        update(state.active, (task) => ({
          ...task,
          messages: [...task.messages, message].slice(-6),
          updated: event.time,
        }));
    }
    if (event.type === "turn/end") {
      for (const [id, task] of Object.entries(state.tasks)) {
        if (task.turn !== state.turn || terminal(task.state)) continue;
        const kind = data.reason?.kind;
        next.tasks = {
          ...next.tasks,
          [id]: {
            ...task,
            state:
              kind === "completed"
                ? "done"
                : kind === "aborted"
                  ? "cancelled"
                  : "failed",
            ...(kind === "interrupted"
              ? { reason: "宿主重启中断了原轮次。" }
              : {}),
            updated: event.time,
          },
        };
      }
      next.turn = null;
      next.active = null;
      next.calls = {};
    }
    return next;
  }
  return {
    key: "sandTableWorkbenchTasks",
    stateVersion: 1,
    stateSchema: z.object({
      session: z.object({ id: z.string(), createdAt: z.number() }),
      inherited: z.number(),
      seq: z.number(),
      turn: z.number().nullable(),
      users: z.number(),
      active: z.string().nullable(),
      calls: z.record(z.string(), z.literal(true)),
      tasks: z.record(
        z.string(),
        z.object({
          binding,
          state: z.enum([
            "waiting",
            "queued",
            "running",
            "done",
            "failed",
            "cancelled",
          ]),
          messages: z.array(z.string()),
          deliveries: z.record(
            z.string(),
            z
              .object({
                delivery,
                recorded: z.boolean(),
                state: z.enum(["pending", "written"]),
                reason: z.string().optional(),
                objectId: z.string().optional(),
                revision: z.number().optional(),
              })
              .passthrough(),
          ),
          started: z.number(),
          updated: z.number(),
          turn: z.number().optional(),
          reason: z.string().optional(),
        }),
      ),
    }),
    init,
    apply,
  };
}
