// 通用工作空间内核的对象模型。
// 契约见 docs/architecture/workspace-kernel.zh-CN.md（issue #11 的 P0 交付物）。
// 本文件只定义类型；行为实现分别位于 core/content.ts、core/workspace.ts、core/history.ts。

/** 外部资源定位：指向资源整体或具体片段。 */
export type ExternalLocator = {
  kind: "file" | "git" | "pdf" | "url" | "dataset" | "symbol";
  /** 定位标识：路径、仓库地址、URL、数据集名等。 */
  uri: string;
  /** 片段定位：页码、行号、符号名、数据范围。 */
  fragment?: string;
  /** 版本或提交，用于识别外部内容变化。 */
  version?: string;
};

/** 对象来源：人工创建、外部导入、AI 生成或推断。 */
export type ObjectSource = {
  origin: "human" | "imported" | "ai-generated" | "ai-inferred" | "code-index";
  author?: string;
  /** 依据说明。推断性来源必须给依据，不得伪装成已确认事实。 */
  basis?: string;
  external?: ExternalLocator;
  importedAt?: number;
  /** 外部内容指纹，用于识别内容变化与引用失效。 */
  fingerprint?: string;
};

/** 统一对象：原生内容、代码对象与外部引用共用一张表。 */
export type WorkspaceObject = {
  id: string;
  kind: "native" | "code" | "reference";
  /** 对象类型，例如 note / character / event / symbol。 */
  type: string;
  /** 类型版本，用于类型迁移与未知类型降级。 */
  typeVersion: number;
  title: string;
  /** 原生正文。 */
  body?: string;
  /** 类型专属载荷。 */
  data?: Record<string, unknown>;
  source?: ObjectSource;
  /** 对象级版本，冲突检测粒度。 */
  version: number;
  createdAt: number;
  updatedAt: number;
  author: string;
};

/** 语义关系：对象之间的语义，与展示布局无关。 */
export type ObjectRelation = {
  id: string;
  source: string;
  target: string;
  /** 关系类型，例如 参与 / 导致 / 先于 / 支持 / 反驳 / 调用。 */
  kind: string;
  /** 内核关系名。kind 可能是旧界面的短名字。 */
  kernelKind?: string;
  /** 推测性关系不得伪装成已确认事实。 */
  status: "confirmed" | "inferred";
  attributes?: Record<string, unknown>;
  /** 依据说明。 */
  basis?: string;
  evidence?: ExternalLocator[];
  createdAt: number;
  author: string;
};

/** 资源引用：指向外部资源整体或具体片段。 */
export type ResourceReference = {
  id: string;
  kind: "file" | "git" | "pdf" | "url" | "dataset" | "symbol";
  uri: string;
  fragment?: string;
  version?: string;
  /** 引用有效性：有效 / 过期 / 缺失。失效必须可识别，不得静默覆盖。 */
  status: "valid" | "stale" | "missing";
  fingerprint?: string;
  title?: string;
};

/** 展示实例只管呈现与布局；内容来自被绑定的对象。 */
export type PresentationBinding = {
  kind: "object" | "local" | "tool";
  /** kind = "object" 时必填。 */
  objectId?: string;
};

export type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
  pinned: boolean;
};

/** 展示实例：对象在某白板上的一次呈现。 */
export type Presentation = {
  id: string;
  /**
   * 所属空间：白板内部的分区 id（例如 overview，或嵌套出来的子白板空间 id）。
   * 注意：不是「所属白板」——工作空间文件里展示实例挂在 boards[0].presentations 下，
   * 板内空间由 spaces[].id 表达。
   */
  spaceId: string;
  /** 组件类型（渲染方式），不等于对象类型。 */
  type: string;
  binding?: PresentationBinding;
  /**
   * 代码投影实例引用的代码对象 ID（旧字段）。
   * 统一绑定请用 binding；本字段仅供 kind=code 的实例使用。
   * binding 存在时，binding.objectId 必须与本字段一致。
   */
  objectId?: string;
  /** 内核类型名，例如 base.note、novel.character。 */
  kernelType?: string;
  appearance?: {
    icon?: string;
    detail?: "full" | "label" | "icon";
    coverBlob?: string;
  };
  /** 未绑定对象时的本地标题。 */
  title: string;
  /** 未绑定对象时的本地内容 / 视图配置。 */
  data: Record<string, unknown>;
  rect: Rect;
  /**
   * 所在框的展示编号。有值时 rect 的 x、y 是相对该框左上角的坐标。
   * 没有父框时不写。
   */
  parentId?: string | null;
  /** 叠放次序。没写按 0。 */
  z?: number;
  updatedAt: number;
  author: string;
};

/** 取展示实例绑定的对象 ID：统一绑定优先，其次是代码投影旧字段。 */
export function boundObjectId(presentation: Presentation): string | undefined {
  return presentation.binding?.objectId ?? presentation.objectId;
}

/** 一次可撤销的变更：目标 + 变更前后的值。 */
export type Patch = {
  target:
    | "object"
    | "presentation"
    | "relation" /** 一次意图涉及多个实体时的批量快照。 */
    | "batch";
  id: string;
  before: unknown;
  after: unknown;
};

/**
 * 板级内容键。
 *
 * 这些字段在旧模型里随整块白板内容一起被撤销；新模型只覆盖
 * object / presentation / relation 三类实体，若不显式补上，
 * 嵌套白板、分组、主题、组件包的导入/移除会静默失去撤销能力。
 * 详见 docs/architecture/integration-2026-10.zh-CN.md 决策 D2。
 */
export type BoardStateKey =
  | "spaces"
  | "spaceLinks"
  | "groups"
  | "placements"
  | "componentPacks"
  | "theme"
  /** 资源引用（文献片段、代码位置……）：失效状态变了也要能撤销。 */
  | "resources";

/** 批量补丁里的单个实体快照。value 为 null 表示该实体在此刻不存在。 */
export type EntitySnapshot = {
  /**
   * board 时 id 为 BoardStateKey、value 为该键的完整值（null 表示删除该键）；
   * 其余目标下 id 为实体 id、value 为该实体的完整快照。
   */
  target: "object" | "presentation" | "relation" | "board";
  id: string;
  value: unknown;
};

/** 撤销条目：按用户意图分组，同一 intentId 的连续编辑合为一个撤销单位。 */
export type HistoryEntry = {
  id: string;
  /** 意图分组键。同一 intentId 的多次编辑合并为一个撤销单位。 */
  intentId: string;
  label: string;
  at: number;
  author: string;
  /**
   * 动作种类：白板内编辑（"edit-object"、"move"……）或外部效果
   * （"publish"、"run-experiment"……）。外部效果不得进入撤销栈（契约 I12）。
   * 缺失时按未知处理：白板撤销宁可漏撤销，也不得冒充外部回滚。
   */
  kind?: string;
  /**
   * 谁做的：人还是 Agent。面板要能一眼分开两类记录，
   * 所以这一项要跟着条目落盘，不能在读回时猜。
   */
  authorKind?: "human" | "agent";
  patch: Patch;
};

/** 撤销栈状态：撤销栈与重做栈分离（I10）。 */
export type HistoryState = { undo: HistoryEntry[]; redo: HistoryEntry[] };

/**
 * 时间线条目：在撤销条目基础上带父指针。
 *
 * 双栈模型（v1）在「撤销之后又做了新编辑」时会清空重做栈，
 * 被撤销的那段历史从此不可达——想跳回去就没路了。
 * 时间线模型把历史记成**一棵树**：新编辑从当前游标分叉，
 * 旧分支保留，任意一条记录都还能跳回去。
 * 契约见 docs/architecture/history-timeline.zh-CN.md。
 */
export type TimelineEntry = HistoryEntry & {
  /** 父条目 ID：这条记录是在哪条记录之上发生的。缺省表示它是起点。 */
  parentId?: string;
  /** 同一棵时间线上的序号，用于稳定排序。 */
  seq: number;
};

/** 时间线状态 v2：单条日志 + 游标，取代 v1 的双栈。 */
export type TimelineState = {
  version: 2;
  /** 全部记录，含已被分叉取代但仍可达的分支。 */
  entries: TimelineEntry[];
  /** 当前位置：最后一条已生效的记录 ID。缺省表示还没开始。 */
  cursorId?: string;
};

/** 领域包提供的对象类型。 */
export type DomainObjectType = {
  /** 类型名，例如 character / hypothesis。 */
  type: string;
  title: string;
  /** 字段说明，供 UI 渲染与提示。 */
  fields?: {
    key: string;
    label: string;
    kind: "text" | "longtext" | "number" | "boolean" | "list";
    required?: boolean;
  }[];
  /** 默认载荷。 */
  defaultData?: Record<string, unknown>;
  /** 校验：返回错误文案数组，空数组表示通过。 */
  check?: (data: Record<string, unknown>) => string[];
};

/** 领域包提供的组件类型（呈现方式）。 */
export type DomainComponentType = {
  type: string;
  title: string;
  icon?: string;
  material?: "paper" | "glass" | "grid";
  /** 该组件默认绑定哪种对象类型。 */
  objectType?: string;
};

/** 领域包提供的语义关系类型。 */
export type DomainRelationType = {
  kind: string;
  title: string;
  /** 是否允许推测性关系。推测关系不得伪装成已确认事实。 */
  allowsInferred: boolean;
  /** 关系级校验：返回错误文案数组，空数组表示通过。 */
  check?: (relation: {
    status?: "confirmed" | "inferred";
    basis?: string;
    attributes?: Record<string, unknown>;
    evidence?: unknown[];
  }) => string[];
};

/** 领域包提供的工具（领域专用的 MCP 工具）。 */
export type DomainToolSpec = {
  name: string;
  title: string;
  description: string;
  /** 参数 JSON Schema。 */
  inputSchema: Record<string, unknown>;
};

/** 领域包提供的模板。模板是可选起点，不是强制流程。 */
export type DomainTemplate = {
  id: string;
  title: string;
  description?: string;
  /** 模板产出的对象，按顺序编号，关系用下标引用。 */
  objects: {
    type: string;
    title: string;
    data?: Record<string, unknown>;
  }[];
  relations?: {
    source: number;
    target: number;
    kind: string;
    status: "confirmed" | "inferred";
    basis?: string;
  }[];
};

/**
 * 领域包：向内核提供类型、组件、关系、工具与模板。
 *
 * 领域语义不硬编码进内核——内核只认这张表。
 * 契约见 docs/architecture/domain-packs.zh-CN.md。
 */
export type DomainPack = {
  id: string;
  title: string;
  version: number;
  description?: string;
  objectTypes?: DomainObjectType[];
  componentTypes?: DomainComponentType[];
  relationTypes?: DomainRelationType[];
  tools?: DomainToolSpec[];
  templates?: DomainTemplate[];
};

/**
 * 连接器能力声明：能读什么、能写什么、写入是否需要人确认。
 *
 * 未声明的能力在调用时被拒绝，并说明原因——
 * 不允许「先做了再说」。
 */
export type ConnectorCapabilities = {
  read: {
    /** 能读取的资源种类。 */
    kinds: ("file" | "git" | "pdf" | "url" | "dataset" | "symbol")[];
    /** 作用域说明（目录、仓库等）。 */
    scopes: string[];
  };
  /** 写入能力。只读连接器不声明这一项。 */
  write?: {
    /** 写入前是否必须由人确认提案。 */
    requiresConfirmation: boolean;
    /** 外部影响范围：写入会影响哪些外部系统。 */
    externalScope: string;
    /** 允许的写入种类。 */
    kinds: string[];
  };
};

/** 连接器描述符：多连接器管理器列出的条目。 */
export type ConnectorDescriptor = {
  id: string;
  title: string;
  description?: string;
  capabilities: ConnectorCapabilities;
  /** 当前是否可用（例如缺少凭据）。 */
  available: boolean;
  /** 不可用时的原因。 */
  unavailableReason?: string;
};

/** 工作空间描述符：多工作空间管理器列出的条目。 */
export type WorkspaceDescriptor = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  revision: number;
  boardCount: number;
  objectCount: number;
  /** 目录路径。 */
  dir?: string;
};

/**
 * 宿主能力声明：宿主**实际**能做什么。
 *
 * 白板内的 AI 入口按此显示，不按猜测显示：
 * 只有 taskSubmit 为真才显示对话入口。
 * 契约见 docs/architecture/dsh-integration.zh-CN.md。
 */
export type HostCapabilities = {
  /** 宿主标识，例如 "dsh" / "local"。 */
  host: string;
  version?: string;
  /** 能否接收任务并返回响应。 */
  taskSubmit: boolean;
  /** 能否流式回传任务事件。 */
  eventStream: boolean;
  /** 能否读取工作空间内容。 */
  contentRead: boolean;
  /** 能呈现哪些插件结果种类。 */
  resultKinds?: string[];
};

/** 发给宿主的任务请求。上下文用**引用 + 版本**，不用整份快照。 */
export type HostTaskRequest = {
  boardId: string;
  instruction: string;
  /** 目标对象引用与开始时的版本。 */
  targets: { objectId: string; version: number }[];
  /** 开始时的上下文版本。 */
  contextVersion: number;
  /** 关联的会话 ID（宿主侧）。 */
  sessionId?: string;
};

/** 宿主回传的任务事件。状态必须来自实际执行反馈，不伪造进度。 */
export type HostTaskEvent = {
  taskId: string;
  boardId?: string;
  results?: import("../../core/host-bridge.ts").HostResult[];
  state: "queued" | "running" | "waiting" | "done" | "failed" | "cancelled";
  message?: string;
  /** 结果关联到哪个对象。 */
  targetObjectId?: string;
  at: number;
};

/** 审计条目：只追加。与撤销栈是两个概念。 */
export type AuditEntry = {
  id: string;
  at: number;
  actor: string;
  actorKind: "human" | "agent";
  action: string;
  target?: { kind: string; id: string };
  /** 本次动作由撤销/重做触发。 */
  via?: "undo" | "redo";
};

/** 活动：人或 Agent 的任务、进展、目标对象及产物。 */
export type WorkspaceActivity = {
  id: string;
  actor: string;
  /** 执行者是人还是 Agent。 */
  actorKind: "human" | "agent";
  state: "running" | "waiting" | "done" | "unknown";
  task: string;
  action: string;
  /** 关注的对象或白板。 */
  targetObjectIds: string[];
  targetSpaceId?: string;
  inputs?: string[];
  outputs?: string[];
  /** 自报来源：状态必须来自实际执行反馈，不伪造进度。 */
  reportedAt: number;
  reportedBy: "agent-self-report" | "host" | "system";
  stale?: boolean;
};

/**
 * 持久化的板状态。
 * 与运行期的 Board 分离：持久层只保存可跨重启恢复的内容，
 * 运行期的临时状态（闲置到期时间、上下文读取快照）不落盘。
 */
export type PersistedBoard = {
  id: string;
  title: string;
  revision: number;
  contentRevision: number;
  spaces: { id: string; title: string; parentId?: string }[];
  presentations: Presentation[];
  views: Record<string, unknown>;
  focusedViewId?: string;
  selection: string[];
  placements: Record<string, unknown>;
  notes: Record<string, string>;
  groups: unknown[];
  spaceLinks: unknown[];
  assets: unknown[];
  /** 导入的组件包：白板级内容，导入/移除都可撤销，重启后仍在。 */
  componentPacks?: unknown[];
  activities: unknown[];
  spaceActivities?: unknown[];
  guides: unknown[];
  intents: unknown[];
  proposals: unknown[];
  validations: unknown[];
  theme?: unknown;
};

/**
 * 持久化的工作空间快照：工作空间是长期作品的边界，文件是唯一权威。
 * 存储格式带版本号，升级路径由 core/workspace.ts 的迁移链负责。
 */
export type WorkspaceSnapshot = {
  schemaVersion: number;
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  revision: number;
  contentRevision: number;
  boards: PersistedBoard[];
  objects: WorkspaceObject[];
  relations: ObjectRelation[];
  resources: ResourceReference[];
  activities: WorkspaceActivity[];
  /** 历史状态 v2：单条日志 + 游标（双栈 v1 只在迁移链里出现）。 */
  history: TimelineState;
  audit: AuditEntry[];
};
