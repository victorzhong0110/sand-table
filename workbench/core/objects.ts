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
  origin:
    | "human"
    | "imported"
    | "ai-generated"
    | "ai-inferred"
    | "code-index";
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
  /** 所属白板。 */
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
  appearance?: { icon?: string; detail?: "full" | "label" | "icon" };
  /** 未绑定对象时的本地标题。 */
  title: string;
  /** 未绑定对象时的本地内容 / 视图配置。 */
  data: Record<string, unknown>;
  rect: Rect;
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
    | "board"
    | "relation"
    | /** 一次意图涉及多个实体时的批量快照。 */
      "batch";
  id: string;
  before: unknown;
  after: unknown;
};

/** 批量补丁里的单个实体快照。value 为 null 表示该实体在此刻不存在。 */
export type EntitySnapshot = {
  target: "object" | "presentation" | "relation";
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
  patch: Patch;
};

/** 撤销栈状态：撤销栈与重做栈分离（I10）。 */
export type HistoryState = { undo: HistoryEntry[]; redo: HistoryEntry[] };

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
  history: HistoryState;
  audit: AuditEntry[];
};
