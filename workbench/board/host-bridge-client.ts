import type { HostTaskRequest, HostTaskEvent } from "../core/objects.ts";
import { HOST_BRIDGE_KEY, type InjectedHost } from "../core/host-bridge.ts";
export const HOST_BRIDGE_MESSAGE = "sand-table:host-bridge";
export const SUBMIT_TASK_MESSAGE = "sand-table:submit-task";
export const SUBMIT_RESULT_MESSAGE = "sand-table:submit-task-result";
export const SUBMIT_ERROR_MESSAGE = "sand-table:submit-task-error";
export type HostBridgeClientOptions = {
  scope: {
    addEventListener(type: string, listener: (event: any) => void): void;
    removeEventListener(type: string, listener: (event: any) => void): void;
  };
  parent: { postMessage(message: unknown, targetOrigin: string): void };
  /** Optional pin, e.g. the local workbench shell. Otherwise learn from the parent handshake. */
  targetOrigin?: string;
  timeoutMs?: number;
  onCapabilities?: (host: InjectedHost) => void;
};
export function installHostBridgeClient(options: HostBridgeClientOptions) {
  const pending = new Map<
    string,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const listeners = new Set<(event: HostTaskEvent) => void>();
  let origin = options.targetOrigin,
    seq = 0,
    disposed = false;
  const request = (type: string, body: Record<string, unknown>): Promise<any> =>
    new Promise((resolve, reject) => {
      if (disposed || !origin) {
        reject(Error("宿主桥尚未连接。"));
        return;
      }
      const id = `st-${++seq}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Error("宿主响应超时，请检查连接后重试。"));
      }, options.timeoutMs ?? 20000);
      pending.set(id, { resolve, reject, timer });
      try {
        options.parent.postMessage({ type, id, ...body }, origin);
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  const submit = (requestBody: HostTaskRequest) =>
    request(SUBMIT_TASK_MESSAGE, { request: requestBody });
  const onMessage = (event: any) => {
    if (
      disposed ||
      event.source !== options.parent ||
      (origin && event.origin !== origin)
    )
      return;
    const data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.type === HOST_BRIDGE_MESSAGE) {
      const host = data.host as InjectedHost | undefined;
      if (
        !host ||
        typeof host.host !== "string" ||
        !event.origin ||
        event.origin === "null"
      )
        return;
      origin = event.origin;
      const injected: InjectedHost = {
        ...host,
        submitTask: host.capabilities?.taskSubmit ? submit : undefined,
        cancelTask: host.capabilities?.eventStream
          ? async (taskId) => {
              await request("sand-table:cancel-task", { taskId });
            }
          : undefined,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
      (options.scope as any)[HOST_BRIDGE_KEY] = injected;
      options.onCapabilities?.(injected);
    } else if (data.type === "sand-table:task-event") {
      for (const listener of listeners) listener(data.event);
    } else if (
      data.type === SUBMIT_RESULT_MESSAGE ||
      data.type === SUBMIT_ERROR_MESSAGE
    ) {
      const entry = pending.get(String(data.id));
      if (!entry) return;
      pending.delete(String(data.id));
      clearTimeout(entry.timer);
      if (data.type === SUBMIT_ERROR_MESSAGE)
        entry.reject(Error(String(data.message ?? "宿主操作失败。")));
      else entry.resolve({ taskId: String(data.taskId ?? "") });
    }
  };
  options.scope.addEventListener("message", onMessage);
  options.parent.postMessage(
    { type: "sand-table:bridge-ready" },
    origin || "*",
  );
  return {
    submit,
    dispose() {
      disposed = true;
      options.scope.removeEventListener("message", onMessage);
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(Error("宿主桥已断开。"));
      }
      pending.clear();
      listeners.clear();
    },
  };
}
