import type { HostTaskEvent } from "../data-client/objects.ts";
import type { AITarget } from "./context.ts";

export type AITurn = {
  id: string;
  boardId: string;
  text: string;
  targets: AITarget[];
  taskId?: string;
  state: HostTaskEvent["state"] | "submitting" | "rejected";
  messages: string[];
  eventAt?: number;
};

export const AI_STATE_LABELS: Record<AITurn["state"], string> = {
  submitting: "正在发送",
  queued: "已排队",
  running: "进行中",
  waiting: "等待中",
  done: "已完成",
  failed: "失败",
  cancelled: "已取消",
  rejected: "发送失败",
};

export function activeTurn(turn: AITurn): boolean {
  return ["submitting", "queued", "running", "waiting"].includes(turn.state);
}

export function applyAIEvent(turn: AITurn, event: HostTaskEvent): AITurn {
  if (
    turn.taskId !== event.taskId ||
    (event.boardId && turn.boardId !== event.boardId) ||
    !activeTurn(turn) ||
    (turn.eventAt !== undefined && event.at < turn.eventAt)
  )
    return turn;
  const raw = event.message?.trim();
  const message = raw === AI_STATE_LABELS[event.state] ? undefined : raw;
  const messages =
    message && turn.messages.at(-1) !== message
      ? [...turn.messages, message].slice(-30)
      : turn.messages;
  return { ...turn, state: event.state, messages, eventAt: event.at };
}
