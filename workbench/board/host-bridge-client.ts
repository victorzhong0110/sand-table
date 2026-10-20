// 白板侧的宿主桥接线。
//
// 宿主（DSH 插件的 Client 半）把自报的能力用 postMessage 送来，
// 白板据此决定「问 AI」入口显不显示，并把任务提交回去。
//
// 契约：docs/architecture/dsh-integration.zh-CN.md；
// 消息格式见 workbench/dsh-plugin/README.md 的「宿主桥的消息契约」。
//
// 跨源时只能传**数据**，所以能力用消息带、提交用请求-应答往返。

import type { HostTaskRequest } from "../core/objects.ts";
import { HOST_BRIDGE_KEY, type InjectedHost } from "../core/host-bridge.ts";

export const HOST_BRIDGE_MESSAGE = "sand-table:host-bridge";
export const SUBMIT_TASK_MESSAGE = "sand-table:submit-task";
export const SUBMIT_RESULT_MESSAGE = "sand-table:submit-task-result";
export const SUBMIT_ERROR_MESSAGE = "sand-table:submit-task-error";

export type HostBridgeClientOptions = {
  /** 白板自己的窗口。 */
  scope: {
    addEventListener: (type: string, listener: (event: any) => void) => void;
    removeEventListener: (type: string, listener: (event: any) => void) => void;
  };
  /** 宿主窗口（跨源时用 postMessage 通信）。 */
  parent: { postMessage: (message: unknown, targetOrigin: string) => void };
  /** 目标来源。跨源时必须是具体源，不能是 "*"。 */
  targetOrigin: string;
  /** 收到宿主能力时调用。 */
  onCapabilities?: (host: InjectedHost) => void;
};

type Pending = {
  resolve: (taskId: string) => void;
  reject: (error: Error) => void;
};

/**
 * 装上宿主桥接线。
 *
 * 返回的对象负责两件事：把宿主能力写进注入点（让 `resolveBridge` 能读到），
 * 以及提供跨源的提交往返。
 */
export function installHostBridgeClient(options: HostBridgeClientOptions) {
  const pending = new Map<string, Pending>();
  let seq = 0;
  let disposed = false;

  const submit = (request: HostTaskRequest): Promise<{ taskId: string }> => {
    const id = `st-${++seq}`;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve: (taskId) => resolve({ taskId }), reject });
      options.parent.postMessage(
        { type: SUBMIT_TASK_MESSAGE, id, request },
        options.targetOrigin,
      );
    });
  };

  const onMessage = (event: any) => {
    if (disposed) return;
    const data = event?.data;
    if (!data || typeof data !== "object") return;
    if (data.type === HOST_BRIDGE_MESSAGE) {
      const host = data.host as InjectedHost | undefined;
      if (!host || typeof host.host !== "string") return;
      const injected: InjectedHost = {
        ...host,
        /* 跨源传不了函数：提交走消息往返，事件流跨源时暂不支持。 */
        submitTask: host.capabilities?.taskSubmit ? submit : undefined,
        subscribe: undefined,
      };
      (options.scope as unknown as Record<string, unknown>)[HOST_BRIDGE_KEY] =
        injected;
      options.onCapabilities?.(injected);
      return;
    }
    if (
      data.type === SUBMIT_RESULT_MESSAGE ||
      data.type === SUBMIT_ERROR_MESSAGE
    ) {
      const entry = pending.get(String(data.id));
      if (!entry) return;
      pending.delete(String(data.id));
      if (data.type === SUBMIT_RESULT_MESSAGE)
        entry.resolve(String(data.taskId));
      else
        entry.reject(new Error(String(data.message ?? "宿主提交任务失败。")));
    }
  };

  options.scope.addEventListener("message", onMessage);

  return {
    /** 提交任务（跨源往返）。 */
    submit,
    dispose() {
      disposed = true;
      options.scope.removeEventListener("message", onMessage);
      for (const [, entry] of pending)
        entry.reject(new Error("宿主桥已断开。"));
      pending.clear();
    },
  };
}
