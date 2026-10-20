// 宿主桥：Sand Table 与外部 Agent 宿主（DSH 等）之间的协议。
//
// 契约见 docs/architecture/dsh-integration.zh-CN.md。
//
// 存在的唯一理由：**入口显隐由宿主的真实能力决定，不由猜测决定**。
// 拿不到能力就不显示对话入口——这是集成轮决策 D7 的延续。

import type {
  HostCapabilities,
  HostTaskEvent,
  HostTaskRequest,
} from "./objects.ts";

/** 宿主桥：把「向宿主提交任务、接收事件」抽象成接口。 */
export type HostBridge = {
  /** 宿主标识，例如 "dsh" / "mcp" / "local"。 */
  readonly host: string;
  /** 宿主自报的能力。 */
  capabilities(): HostCapabilities;
  /**
   * 提交任务。宿主不支持时抛错，错误文案要说明原因
   * （不要假装提交成功）。
   */
  submitTask(request: HostTaskRequest): Promise<{ taskId: string }>;
  /** 订阅任务事件。返回取消订阅函数。 */
  subscribe(listener: (event: HostTaskEvent) => void): () => void;
};

/** 没有任何执行能力的宿主（MCP 不是任务执行通道）。 */
export function noHostCapabilities(host: string): HostCapabilities {
  return {
    host,
    taskSubmit: false,
    eventStream: false,
    contentRead: false,
  };
}

/** 独立模式：没有宿主，白板仍可完整使用。 */
export const localBridge: HostBridge = {
  host: "local",
  capabilities: () => noHostCapabilities("local"),
  submitTask: async () => {
    throw new Error("当前没有可用的 Agent 宿主，无法提交任务。");
  },
  subscribe: () => () => {},
};

/** 仅 MCP 模式：外部客户端自己发起对话，白板这边不执行任务。 */
export const mcpBridge: HostBridge = {
  host: "mcp",
  capabilities: () => noHostCapabilities("mcp"),
  submitTask: async () => {
    throw new Error("仅 MCP 接入时不提供任务执行通道，对话在外部客户端发起。");
  },
  subscribe: () => () => {},
};

/** 宿主注入到页面里的对象形状（由宿主保证，Sand Table 只读）。 */
export type InjectedHost = {
  host: string;
  version?: string;
  capabilities?: Partial<HostCapabilities>;
  submitTask?: (request: HostTaskRequest) => Promise<{ taskId: string }>;
  subscribe?: (listener: (event: HostTaskEvent) => void) => (() => void) | void;
};

/** 注入点的全局键名。 */
export const HOST_BRIDGE_KEY = "__SAND_TABLE_HOST__";

/**
 * 从宿主注入的对象读出桥。
 *
 * 读不到就返回 undefined——那是「没有宿主」，不是错误。
 * 能力字段要**逐项**采信宿主自报：宿主说 taskSubmit 为假，
 * 就不能因为对象里恰好带了 submitTask 函数就显示入口。
 */
export function readInjectedBridge(scope: unknown): HostBridge | undefined {
  if (!scope || typeof scope !== "object") return undefined;
  const holder = scope as Record<string, unknown>;
  const injected = holder[HOST_BRIDGE_KEY];
  if (!injected || typeof injected !== "object") return undefined;
  const host = injected as InjectedHost;
  if (typeof host.host !== "string" || !host.host.trim()) return undefined;
  const raw = host.capabilities ?? {};
  const capabilities: HostCapabilities = {
    host: host.host,
    version: host.version,
    taskSubmit: raw.taskSubmit === true,
    eventStream: raw.eventStream === true,
    contentRead: raw.contentRead === true,
    resultKinds: Array.isArray(raw.resultKinds) ? raw.resultKinds : undefined,
  };
  return {
    host: host.host,
    capabilities: () => capabilities,
    submitTask: async (request: HostTaskRequest) => {
      if (!capabilities.taskSubmit)
        throw new Error("宿主没有声明任务提交能力。");
      if (typeof host.submitTask !== "function")
        throw new Error("宿主声明了任务提交能力，但没有提供提交入口。");
      return host.submitTask(request);
    },
    subscribe: (listener: (event: HostTaskEvent) => void) => {
      if (!capabilities.eventStream || typeof host.subscribe !== "function")
        return () => {};
      const off = host.subscribe(listener);
      return typeof off === "function" ? off : () => {};
    },
  };
}

/**
 * 统一入口：按当前环境挑一个桥。
 *
 * @param scope 宿主注入点的宿主对象（浏览器里传 window，测试里传假对象）
 * @param mode  已知的接入模式：没有宿主时传 "mcp" 或 "local"
 */
export function resolveBridge(
  scope: unknown,
  mode: "mcp" | "local" = "local",
): HostBridge {
  const injected = readInjectedBridge(scope);
  if (injected) return injected;
  return mode === "mcp" ? mcpBridge : localBridge;
}

/**
 * 界面要不要显示白板内对话入口。
 *
 * 只有宿主真的能「接收任务并返回响应」时才显示。
 * 复制提示词、打开接入说明都**不算**发送任务。
 */
export function canShowTaskEntry(bridge: HostBridge): boolean {
  return bridge.capabilities().taskSubmit === true;
}
