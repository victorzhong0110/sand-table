// 连接器的通用类型与能力守卫。
//
// 契约见 docs/architecture/domain-packs.zh-CN.md 第 3 节。
//
// 连接器只回答两件事：能读什么、能写什么。
// 没声明的能力在调用时被拒绝，并说明原因——不允许「先做了再说」。

import type {
  ConnectorCapabilities,
  ConnectorDescriptor,
} from "../core/objects.ts";
import type { WorkspaceState } from "../core/changes.ts";

export type { ConnectorCapabilities, ConnectorDescriptor };

/** 一个已绑定的外部来源：连接器读写的具体目标（目录、仓库……）。 */
export type Binding = { id: string; label: string; root: string };

/** 读请求：读哪个来源、读什么种类。 */
export type ConnectorReadRequest = {
  /** 目标来源。没给就用连接器自己绑定的那个。 */
  binding?: Binding;
  /** 资源种类：必须是连接器声明过的，否则被拒绝。 */
  kind: "file" | "git" | "pdf" | "url" | "dataset" | "symbol";
  /** 限定路径（相对来源根目录）。 */
  paths?: string[];
  /** 读多少的上限。 */
  limit?: { maxFiles?: number; maxBytes?: number };
};

/** 读结果：引用 + 只读内容。 */
export type ConnectorReadResult = {
  /** 引用：指向外部资源整体或片段。 */
  references: {
    id: string;
    kind: string;
    uri: string;
    title?: string;
    /** 内容指纹：外部内容变化时必须能识别。 */
    fingerprint?: string;
    /** 片段定位（行号、符号名等）。 */
    fragment?: string;
  }[];
  /** 只读内容。 */
  contents: { id: string; text: string; fingerprint: string }[];
  /** 没读到的部分与原因。省略必须说明，不能静默丢弃。 */
  omitted: string[];
  /** 外部范围的状态（仓库 HEAD、分支等）。 */
  status?: Record<string, unknown>;
};

/** 人确认：写入前必须带，且绑定具体提案版本与摘要。 */
export type ConnectorConfirmation = {
  decision: "accepted" | "rejected" | "revise";
  /** 被确认的提案版本。 */
  version: number;
  /** 被确认的提案摘要。 */
  digest: string;
  /** 谁确认的。 */
  by?: string;
  /** 什么时候确认的。 */
  at?: number;
};

/** 写入目标：一个文件的目标内容与它针对的内容指纹。 */
export type ConnectorWriteFile = {
  /** 目标路径（相对来源根目录）。 */
  path: string;
  /** 目标属于哪个来源（多个工作树时用）。 */
  workspaceId?: string;
  /** 提案针对的内容指纹（写之前文件长这样）。 */
  beforeHash: string | null;
  /** 目标内容。null 表示「删除这个文件」。 */
  content: string | null;
  /** 目标内容指纹。 */
  afterHash?: string | null;
};

/** 写请求。 */
export type ConnectorWriteRequest = {
  /** 目标来源。 */
  binding?: Binding;
  /** 目标文件。 */
  files: ConnectorWriteFile[];
  /** 人确认。没有它，写入一律被拒绝。 */
  confirmation?: ConnectorConfirmation;
  /** 被确认的提案：版本与摘要必须与人确认记录一致。 */
  proposal?: { id: string; version: number; digest: string };
  /** 声明的写入范围（工作空间 id）。范围外的目标必须被拒绝。 */
  scope?: string[];
  /** 写入前记录的工作树基线：核对范围时拿它比。 */
  baseline?: WorkspaceState[];
};

/** 写入准备的结果：宿主照着写就行。 */
export type ConnectorWritePlan = {
  files: {
    path: string;
    beforeHash: string | null;
    afterHash: string | null;
    content: string | null;
  }[];
  /** 写入前的工作树基线：写完之后要拿它核对。 */
  baseline: WorkspaceState[];
  /** 给宿主的指示。 */
  instruction: string;
};

/** 写入之后的核对结果。 */
export type ConnectorVerification = {
  state: "not-applied" | "partial" | "matches" | "diverged" | "incomplete";
  files: {
    path: string;
    state: "before" | "after" | "unexpected";
    actualHash: string | null;
  }[];
  /** 范围之外被动过的文件。 */
  outsideChanges: string[];
  omitted: string[];
};

/**
 * 连接器的能力接口。
 *
 * `write` 只在连接器声明了写能力时才实现：只读连接器不实现写回，
 * 调用时由 writeThrough 给出明确的拒绝理由。
 */
export type Connector = {
  /** 连接器 id：与能力声明里的 id 一致。 */
  id: string;
  /** 连接器名称。 */
  title: string;
  /** 一句话说明这个连接器连的是什么。 */
  description?: string;
  /** 能力声明：能读什么、能写什么、写入要不要人确认、外部影响范围。 */
  descriptor(): ConnectorDescriptor;
  /** 读。 */
  read(
    request: ConnectorReadRequest,
  ): ConnectorReadResult | Promise<ConnectorReadResult>;
  /** 写：准备 + 核对。只有声明了写能力的连接器才有。 */
  write?: {
    prepare(
      request: ConnectorWriteRequest,
    ): ConnectorWritePlan | Promise<ConnectorWritePlan>;
    verify(
      request: ConnectorWriteRequest,
    ): ConnectorVerification | Promise<ConnectorVerification>;
  };
};

/** 读能力的守卫：没声明的种类在调用时被拒绝，并说明原因。 */
export function assertReadCapability(
  connector: Connector,
  kind: ConnectorReadRequest["kind"],
): void {
  const capabilities = connector.descriptor().capabilities;
  if (capabilities.read.kinds.includes(kind)) return;
  throw Error(
    `${connector.descriptor().id} 连接器未声明读取种类「${kind}」：它只能读 ${capabilities.read.kinds.join("、")}。`,
  );
}

/** 写能力的守卫：只读连接器不声明 write，这里给出拒绝理由。 */
export function assertWriteCapability(
  connector: Connector,
): NonNullable<Connector["write"]> {
  const descriptor = connector.descriptor();
  if (!descriptor.capabilities.write)
    throw Error(`${descriptor.id} 连接器是只读的：不能写入外部文件。`);
  if (!connector.write)
    throw Error(`${descriptor.id} 连接器声明了写入能力，但没有实现写入方法。`);
  return connector.write;
}

/** 统一的读入口：先过能力声明，再真正读。 */
export function readThrough(
  connector: Connector,
  request: ConnectorReadRequest,
): ConnectorReadResult | Promise<ConnectorReadResult> {
  assertReadCapability(connector, request.kind);
  return connector.read(request);
}

/**
 * 统一的写入口：先过能力声明，再进入确认链路。
 *
 * 只读连接器走到这里会被拒绝，理由写清楚，不静默忽略。
 */
export function writeThrough(
  connector: Connector,
  request: ConnectorWriteRequest,
): ConnectorWritePlan | Promise<ConnectorWritePlan> {
  const write = assertWriteCapability(connector);
  return write.prepare(request);
}

/** 统一的核对入口：写完之后核对实际内容与范围。 */
export function verifyThrough(
  connector: Connector,
  request: ConnectorWriteRequest,
): ConnectorVerification | Promise<ConnectorVerification> {
  const write = assertWriteCapability(connector);
  return write.verify(request);
}
