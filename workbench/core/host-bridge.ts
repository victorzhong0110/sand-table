// 宿主桥：Sand Table 与外部 Agent 宿主（DSH 等）之间的协议。
//
// 契约见 docs/architecture/dsh-integration.zh-CN.md。
//
// 存在的唯一理由：**入口显隐由宿主的真实能力决定，不由猜测决定**。
// 拿不到能力就不显示对话入口——这是集成轮决策 D7 的延续。

import { safeUrl } from "../board/data-client/spaces.ts";
import type {
  HostCapabilities,
  HostTaskEvent,
  HostTaskRequest,
} from "../board/data-client/objects.ts";

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
  cancelTask?(taskId: string): Promise<void>;
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
  cancelTask?: (taskId: string) => Promise<void>;
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
    taskSubmit:
      raw.taskSubmit === true && typeof host.submitTask === "function",
    eventStream: raw.eventStream === true,
    contentRead: raw.contentRead === true,
    resultKinds: Array.isArray(raw.resultKinds) ? raw.resultKinds : undefined,
  };
  return {
    host: host.host,
    capabilities: () => capabilities,
    submitTask: async (request: HostTaskRequest) => {
      if (raw.taskSubmit === true && typeof host.submitTask !== "function")
        throw new Error("宿主声明了任务提交能力，但没有提供提交入口。");
      if (!capabilities.taskSubmit)
        throw new Error("宿主没有声明任务提交能力。");
      if (typeof host.submitTask !== "function")
        throw new Error("宿主提交入口已断开。");
      return host.submitTask(request);
    },
    cancelTask: host.cancelTask,
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

/**
 * 宿主插件结果的呈现映射。
 *
 * 插件结果不一定自带可嵌入的白板 UI：文献结果要变成文献卡与来源引用，
 * 数据结果要变成表格或图表，文件结果要变成资源引用，
 * 剩下的通用文本/链接走基础组件降级。
 *
 * 契约见 docs/architecture/dsh-integration.zh-CN.md 第 7.2 节。
 */
export type HostResult = {
  kind: string;
  title?: string;
  /** 通用文本内容。 */
  text?: string;
  /** 链接。 */
  url?: string;
  /** 表格数据：首行是表头。 */
  rows?: (string | number)[][];
  /** 资源定位。 */
  resource?: { uri: string; fragment?: string; fingerprint?: string };
  /** 来源说明：结果从哪来。 */
  source?: string;
};

export type MappedResult = {
  /** 目标组件类型。 */
  type: string;
  title: string;
  data: Record<string, unknown>;
  /** 原始结果的来源说明，保留可追溯性。 */
  source?: string;
};

/**
 * 把宿主结果映射成白板组件。
 *
 * 映射是**降级优先**的：认得的类型给专门组件，认不出的走基础文本组件，
 * 但来源与资源引用一律保留——结果可以看不懂，来源不能丢。
 */
export function mapHostResult(result: HostResult): MappedResult {
  const title = result.title || result.kind;
  if (result.kind === "document" || result.kind === "paper") {
    return {
      type: "evidence",
      title,
      data: {
        summary: result.text || title,
        ...(result.resource ? { externalResource: result.resource } : {}),
        ...(result.resource?.fragment && result.resource.fingerprint
          ? {
              citation: {
                uri: result.resource.uri,
                fingerprint: result.resource.fingerprint,
                status: "valid",
                ...(result.resource.fragment
                  ? { fragment: result.resource.fragment }
                  : {}),
              },
            }
          : {}),
      },
      ...(result.source ? { source: result.source } : {}),
    };
  }
  if (result.kind === "dataset" || result.kind === "data") {
    if (result.rows?.length)
      return {
        type: "table",
        title,
        data: {
          columns: result.rows[0].map(String),
          rows: result.rows.slice(1).map((r) => r.map((v) => String(v))),
        },
        ...(result.source ? { source: result.source } : {}),
      };
    return {
      type: "text",
      title,
      data: { text: result.text || "数据结果未包含可绘制的值。" },
      ...(result.source ? { source: result.source } : {}),
    };
  }
  if (result.kind === "file" || result.kind === "resource") {
    return {
      type: "resource",
      title,
      data: {
        url: safeUrl(result.resource?.uri ?? result.url) ?? "",
        resourceUri: result.resource?.uri ?? result.url ?? "",
        description: result.text ?? "",
        ...(result.resource?.fragment
          ? { fragment: result.resource.fragment }
          : {}),
      },
      ...(result.source ? { source: result.source } : {}),
    };
  }
  // 通用降级：文本或链接。
  return {
    type: "text",
    title,
    data: {
      text: result.text ?? (result.url ? result.url : ""),
      ...(safeUrl(result.url) ? { url: safeUrl(result.url) } : {}),
    },
    ...(result.source ? { source: result.source } : {}),
  };
}
