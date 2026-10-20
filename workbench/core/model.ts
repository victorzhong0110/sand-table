import type {
  Space,
  ComponentInstance,
  View,
  SpaceLink,
  Asset,
  ThemeConfig,
} from "./spaces.ts";
import type {
  WorkspaceObject,
  ObjectRelation,
  ResourceReference,
  HistoryEntry,
  AuditEntry,
  HistoryState,
} from "./objects.ts";
import type { ChangeIntent, Proposal, ValidationReport } from "./changes.ts";
export type Evidence = {
  workspaceId: string;
  path: string;
  startLine: number;
  endLine: number;
  hash: string;
};
export type Item = {
  id: string;
  workspaceId: string;
  kind: "workspace" | "file" | "symbol";
  title: string;
  parentId?: string;
  source?: Evidence;
};
export type Relation = {
  source: string;
  target: string;
  kind: "contains" | "imports" | "syntactic-call";
};
export type Workspace = {
  id: string;
  label: string;
  head: string;
  branch: string;
  snapshot: string;
  files: number;
  omitted: string[];
};
export type Projection = {
  workspaces: Workspace[];
  objects: Item[];
  relations: Relation[];
};
export type Placement = { x: number; y: number; pinned: boolean };
export type Activity = {
  agentId: string;
  workspaceId: string;
  objectIds: string[];
  task: string;
  action: string;
  state: "running" | "waiting" | "done" | "unknown";
  reportedAt: number;
  stale?: boolean;
};
export type Explanation = {
  id: string;
  agentId: string;
  text: string;
  evidence: Evidence[];
  stale: boolean;
  status: "agent-inference";
};
export type GuideStep = {
  title: string;
  explanation: string;
  objectIds: string[];
  evidence: Evidence[];
  uncertainty: string;
};
export type GuideDraft = {
  title: string;
  purpose: string;
  inputs: string;
  outputs: string;
  agentId: string;
  steps: GuideStep[];
};
export type Guide = GuideDraft & {
  id: string;
  stale: boolean;
  status: "agent-inference";
  createdAt: number;
};
export type GuideFocus = { guideId: string; step: number };
export type Group = {
  id: string;
  title: string;
  objectIds: string[];
  instanceIds?: string[];
};
export type SpaceActivity = {
  agentId: string;
  spaceId: string;
  instanceIds: string[];
  task: string;
  action: string;
  state: "running" | "waiting" | "done" | "unknown";
  reportedAt: number;
  stale?: boolean;
};
export type Board = Projection & {
  id: string;
  revision: number;
  title: string;
  expiresAt: number;
  presentation?: "canvas" | "code";
  autoProjectSources?: boolean;
  selection: string[];
  placements: Record<string, Placement>;
  notes: Record<string, string>;
  groups: Group[];
  activities: Activity[];
  spaceActivities?: SpaceActivity[];
  explanations: Explanation[];
  guides: Guide[];
  spaces: Space[];
  instances: ComponentInstance[];
  views: Record<string, View>;
  focusedViewId?: string;
  spaceLinks: SpaceLink[];
  assets: Asset[];
  theme?: ThemeConfig | null;
  intents: ChangeIntent[];
  proposals: Proposal[];
  validations: ValidationReport[];
  guideFocus?: GuideFocus;
  lastContextRead?: { at: number; revision: number; objectIds: string[] };
  // —— 通用工作空间内核（issue #11）——
  /** 所属工作空间。空白启动时也会落盘，不依赖 Git 或 AI。 */
  workspaceId?: string;
  /** 原生内容对象：内容的唯一真相，与代码投影对象分开。 */
  contentObjects: WorkspaceObject[];
  /** 语义关系：对象之间的语义，与展示布局无关。 */
  objectRelations: ObjectRelation[];
  /** 外部资源引用：整体或具体片段，失效必须可识别。 */
  resources: ResourceReference[];
  /** 内容版本：与布局 revision 分离，避免镜头操作干扰内容编辑。 */
  contentRevision: number;
  /** 撤销栈：按用户意图分组。与审计日志不是同一概念。 */
  history: HistoryState;
  /** 审计日志：只追加，记录执行者与动作。 */
  audit: AuditEntry[];
};
