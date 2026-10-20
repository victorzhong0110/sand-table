// 通用工作空间的持久化存储层。
// 契约见 docs/architecture/workspace-kernel.zh-CN.md 第 4、5 节（issue #11 的 P0 交付物）。
//
// 落盘格式：
//   <root>/<workspaceId>/workspace.json      权威状态
//   <root>/<workspaceId>/workspace.json.bak  上一份（主文件损坏时回退）
//   <root>/<workspaceId>/attachments/        附件二进制
//
// 本模块只负责存储：内容模型见 core/objects.ts 与 core/content.ts，历史见 core/history.ts。
// 约束：只用 node 内置模块；不使用 enum / namespace / 参数属性 / 装饰器
// （node --experimental-strip-types 不支持）。

import { randomUUID } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ObjectState } from "./content.ts";
import { migrateHistoryState } from "./history.ts";
import type {
  AuditEntry,
  HistoryEntry,
  ObjectRelation,
  Patch,
  PersistedBoard as SharedPersistedBoard,
  Presentation,
  ResourceReference,
  TimelineEntry,
  TimelineState,
  WorkspaceActivity,
  WorkspaceObject,
  WorkspaceSnapshot as SharedWorkspaceSnapshot,
} from "./objects.ts";

/** 工作空间文件格式版本。落盘文件始终写入当前版本。 */
export const WORKSPACE_SCHEMA_VERSION = 2;

/** 导出包格式标识。 */
export const WORKSPACE_BUNDLE_FORMAT = "sand-table-workspace-bundle";

/** 导出包自身（而非工作空间文件）的版本。 */
export const WORKSPACE_BUNDLE_VERSION = 1;

/** 白板状态随工作空间一起持久化。接线由上层负责，本模块只做存储。 */
export type PersistedBoard = {
  id: string;
  title: string;
  revision: number;
  contentRevision: number;
  spaces: { id: string; title: string; parentId?: string; objectId?: string }[];
  presentations: Presentation[];
  views: Record<string, unknown>;
  focusedViewId?: string;
  selection: string[];
  placements: Record<string, unknown>;
  notes: Record<string, string>;
  groups: unknown[];
  spaceLinks: unknown[];
  assets: unknown[];
  /** 导入的组件包：白板级内容，重启后仍在。 */
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
 * 对象状态与文件结构的对应关系（显式给出，不要靠猜）。
 * - objects 与 relations 在文件顶层；
 * - presentations 在 boards[0].presentations（展示实例是白板状态，不是工作空间级实体）。
 * 纯函数层 core/content.ts 的 ObjectState 是一块**扁平**结构，
 * 直接把它当成文件的某一段写进去会让被删的展示实例在重启后复活。
 */
export const readObjectState = (file: WorkspaceFile): ObjectState => ({
  objects: file.objects,
  presentations: file.boards[0]?.presentations ?? [],
  relations: file.relations,
});

/** 把对象状态写回文件：按上面的对应关系落到各自的位置。 */
export const writeObjectState = (
  file: WorkspaceFile,
  state: ObjectState,
): WorkspaceFile => ({
  ...file,
  objects: state.objects,
  relations: state.relations,
  boards: file.boards.map((board, index) =>
    index === 0 ? { ...board, presentations: state.presentations } : board,
  ),
});

/** workspace.json 的完整内容。 */
export type WorkspaceFile = {
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
  /** 历史状态 v2：单条日志 + 游标。v1 的双栈只在迁移链里出现。 */
  history: TimelineState;
  audit: AuditEntry[];
};

/**
 * 本文件的 PersistedBoard / WorkspaceFile 与 core/objects.ts 的共享类型必须互相可赋值，
 * 否则负责人接线时 board.history 与 history.state、workspace 与 snapshot 互相赋值会编译失败。
 * 下面是纯类型守卫：两边不再互相可赋值时直接报类型错，不产生任何运行时代码。
 */
type AssertTrue<T extends true> = T;
type PersistedBoardMatchesShared = AssertTrue<
  PersistedBoard extends SharedPersistedBoard
    ? SharedPersistedBoard extends PersistedBoard
      ? true
      : false
    : false
>;
type WorkspaceFileMatchesShared = AssertTrue<
  WorkspaceFile extends SharedWorkspaceSnapshot
    ? SharedWorkspaceSnapshot extends WorkspaceFile
      ? true
      : false
    : false
>;

/** list() 输出的工作空间摘要。 */
export type WorkspaceSummary = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  schemaVersion: number;
};

/** list() 的结果：可用摘要 + 被跳过的损坏工作空间。 */
export type WorkspaceListResult = {
  workspaces: WorkspaceSummary[];
  errors: { id: string; reason: string }[];
};

/** load() 的结果。recovered 为 true 表示内容来自备份，必须显式告警。 */
export type WorkspaceLoadResult = {
  workspace: WorkspaceFile;
  recovered: boolean;
  reason?: string;
};

/** 外部依赖：导出包必须显式声明，导入时提示「引用未随包迁移」。 */
export type ExternalDependency = {
  kind: string;
  uri: string;
  fragment?: string;
  version?: string;
  /** 引用位置，例如 resource:<id> / object:<id> / relation:<id>。 */
  referencedBy: string[];
};

/** 导出包中的附件条目。 */
export type BundleAttachment = {
  name: string;
  bytes: number;
  /** inlineAttachments 为 true 时附带 base64 内容，使导出包自包含。 */
  dataBase64?: string;
};

/** 自包含导出包。 */
export type WorkspaceBundle = {
  format: typeof WORKSPACE_BUNDLE_FORMAT;
  bundleVersion: number;
  exportedAt: number;
  schemaVersion: number;
  workspace: WorkspaceFile;
  externalDependencies: ExternalDependency[];
  attachments: BundleAttachment[];
  /** 导出时主文件是否走了回退路径。 */
  source: { recovered: boolean; reason?: string };
};

/** 存储层最近一次失败的可观察记录。 */
export type WorkspaceStoreError = {
  operation: "create" | "save" | "load" | "list" | "export" | "import";
  message: string;
  workspaceId?: string;
  at: number;
};

/** 一个版本迁移步骤。链式执行：0 → 1 → 2 … */
export type WorkspaceMigration = {
  from: number;
  to: number;
  describe: string;
  apply: (raw: Record<string, unknown>) => Record<string, unknown>;
};

/** 注入的文件系统接口，便于测试写失败等异常路径。 */
export type WorkspaceFileStat = { size: number; isDirectory(): boolean };

export type WorkspaceFileSystem = {
  existsSync(path: string): boolean;
  mkdirSync(path: string, options: { recursive: boolean }): void;
  readFileSync(path: string, encoding: "utf8"): string;
  readFileBuffer(path: string): Buffer;
  writeFileSync(path: string, data: string, encoding: "utf8"): void;
  openSync(path: string, flags: string): number;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
  renameSync(from: string, to: string): void;
  copyFileSync(from: string, to: string): void;
  unlinkSync(path: string): void;
  readdirSync(path: string): string[];
  statSync(path: string): WorkspaceFileStat;
};

/** 存储层错误基类。上层可统一 catch WorkspaceError。 */
export class WorkspaceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WorkspaceError";
  }
}

/** 主文件与备份都不可读。绝不静默返回空工作空间。 */
export class WorkspaceCorruptError extends WorkspaceError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WorkspaceCorruptError";
  }
}

/** 同 ID 的工作空间已存在，导入不得静默覆盖。 */
export class WorkspaceConflictError extends WorkspaceError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WorkspaceConflictError";
  }
}

/** 文件版本高于当前实现：拒绝读取，绝不丢弃数据。 */
export class WorkspaceVersionError extends WorkspaceError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WorkspaceVersionError";
  }
}

/** 工作空间不存在。 */
export class WorkspaceNotFoundError extends WorkspaceError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WorkspaceNotFoundError";
  }
}

/** 工作空间 ID 非法（会越出 root 目录或不符合命名规则）。 */
export class WorkspaceIdError extends WorkspaceError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WorkspaceIdError";
  }
}

/** 工作空间 ID 必须能安全地作为目录名：不允许路径分隔符与相对路径。 */
const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown, fallback: string): string =>
  typeof value === "string" ? value : fallback;

const asNumber = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const asArray = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const normalizeSpace = (raw: unknown): PersistedBoard["spaces"][number] => {
  const r = isRecord(raw) ? raw : {};
  const space: PersistedBoard["spaces"][number] = {
    id: asString(r.id, ""),
    title: asString(r.title, ""),
  };
  if (typeof r.parentId === "string") space.parentId = r.parentId;
  if (typeof r.objectId === "string") space.objectId = r.objectId;
  return space;
};

/**
 * 展示实例逐字段归一化。
 * 缺 id / spaceId / type / rect 的实例是坏数据：判为损坏（走 .bak 回退），
 * 而不是放行到运行时才炸出一个 TypeError。
 */
const normalizePresentation = (raw: unknown): Presentation => {
  const r = isRecord(raw) ? raw : {};
  const rect = isRecord(r.rect) ? r.rect : {};
  const id = asString(r.id, "");
  const spaceId = asString(r.spaceId, "");
  const type = asString(r.type, "");
  const numbers = [rect.x, rect.y, rect.width, rect.height];
  if (
    !id ||
    !spaceId ||
    !type ||
    !numbers.every((n) => typeof n === "number" && Number.isFinite(n))
  )
    throw new WorkspaceCorruptError(
      `presentation is malformed: ${JSON.stringify(raw).slice(0, 200)}`,
    );
  const presentation: Presentation = {
    id,
    spaceId,
    type,
    title: asString(r.title, ""),
    data: isRecord(r.data) ? { ...r.data } : {},
    rect: {
      x: rect.x as number,
      y: rect.y as number,
      width: rect.width as number,
      height: rect.height as number,
      pinned: rect.pinned === true,
    },
    updatedAt: asNumber(r.updatedAt, 0),
    author: asString(r.author, "unknown"),
  };
  if (isRecord(r.binding)) {
    const kind = r.binding.kind;
    if (kind === "object" || kind === "local" || kind === "tool") {
      presentation.binding = {
        kind,
        ...(typeof r.binding.objectId === "string"
          ? { objectId: r.binding.objectId }
          : {}),
      };
    }
  }
  if (typeof r.objectId === "string") presentation.objectId = r.objectId;
  if (isRecord(r.appearance)) {
    const detail = r.appearance.detail;
    presentation.appearance = {
      ...(typeof r.appearance.icon === "string"
        ? { icon: r.appearance.icon }
        : {}),
      ...(detail === "full" || detail === "label" || detail === "icon"
        ? { detail }
        : {}),
    };
  }
  return presentation;
};

const normalizeBoard = (raw: unknown): PersistedBoard => {
  const r = isRecord(raw) ? raw : {};
  const views = isRecord(r.views) ? r.views : {};
  const placements = isRecord(r.placements) ? r.placements : {};
  const notes: Record<string, string> = {};
  if (isRecord(r.notes))
    for (const [key, value] of Object.entries(r.notes))
      if (typeof value === "string") notes[key] = value;
  const board: PersistedBoard = {
    id: asString(r.id, ""),
    title: asString(r.title, ""),
    revision: asNumber(r.revision, 0),
    contentRevision: asNumber(r.contentRevision, 0),
    spaces: asArray(r.spaces).filter(isRecord).map(normalizeSpace),
    presentations: asArray(r.presentations).map(normalizePresentation),
    views: { ...views },
    selection: asArray(r.selection).filter(
      (value): value is string => typeof value === "string",
    ),
    placements: { ...placements },
    notes,
    groups: asArray(r.groups),
    spaceLinks: asArray(r.spaceLinks),
    assets: asArray(r.assets),
    activities: asArray(r.activities),
    guides: asArray(r.guides),
    intents: asArray(r.intents),
    proposals: asArray(r.proposals),
    validations: asArray(r.validations),
  };
  if (typeof r.focusedViewId === "string")
    board.focusedViewId = r.focusedViewId;
  if (Array.isArray(r.spaceActivities))
    board.spaceActivities = r.spaceActivities;
  // 组件包是可选字段：文件里没有就不写进去，往返才不会多出空数组。
  if (Array.isArray(r.componentPacks)) board.componentPacks = r.componentPacks;
  if (r.theme !== undefined) board.theme = r.theme;
  return board;
};

const normalizeObject = (raw: unknown): WorkspaceObject => {
  const r = isRecord(raw) ? raw : {};
  return {
    ...(r as Partial<WorkspaceObject>),
    id: asString(r.id, ""),
    kind: r.kind === "code" || r.kind === "reference" ? r.kind : "native",
    type: asString(r.type, "note"),
    typeVersion: asNumber(r.typeVersion, 1),
    title: asString(r.title, ""),
    version: asNumber(r.version, 1),
    createdAt: asNumber(r.createdAt, 0),
    updatedAt: asNumber(r.updatedAt, 0),
    author: asString(r.author, "unknown"),
  };
};

const normalizeRelation = (raw: unknown): ObjectRelation => {
  const r = isRecord(raw) ? raw : {};
  const relation: ObjectRelation = {
    id: asString(r.id, ""),
    source: asString(r.source, ""),
    target: asString(r.target, ""),
    kind: asString(r.kind, "related"),
    status: r.status === "inferred" ? "inferred" : "confirmed",
    createdAt: asNumber(r.createdAt, 0),
    author: asString(r.author, "unknown"),
  };
  if (isRecord(r.attributes)) relation.attributes = r.attributes;
  if (typeof r.basis === "string") relation.basis = r.basis;
  if (Array.isArray(r.evidence))
    relation.evidence = r.evidence.filter(
      isRecord,
    ) as ObjectRelation["evidence"];
  return relation;
};

const normalizeResource = (raw: unknown): ResourceReference => {
  const r = isRecord(raw) ? raw : {};
  const resource: ResourceReference = {
    id: asString(r.id, ""),
    kind:
      r.kind === "file" ||
      r.kind === "git" ||
      r.kind === "pdf" ||
      r.kind === "url" ||
      r.kind === "dataset" ||
      r.kind === "symbol"
        ? r.kind
        : "file",
    uri: asString(r.uri, ""),
    status: r.status === "stale" || r.status === "missing" ? r.status : "valid",
  };
  if (typeof r.fragment === "string") resource.fragment = r.fragment;
  if (typeof r.version === "string") resource.version = r.version;
  if (typeof r.fingerprint === "string") resource.fingerprint = r.fingerprint;
  if (typeof r.title === "string") resource.title = r.title;
  return resource;
};

const normalizeActivity = (raw: unknown): WorkspaceActivity => {
  const r = isRecord(raw) ? raw : {};
  const activity: WorkspaceActivity = {
    id: asString(r.id, ""),
    actor: asString(r.actor, "unknown"),
    actorKind: r.actorKind === "agent" ? "agent" : "human",
    state:
      r.state === "running" ||
      r.state === "waiting" ||
      r.state === "done" ||
      r.state === "unknown"
        ? r.state
        : "unknown",
    task: asString(r.task, ""),
    action: asString(r.action, ""),
    targetObjectIds: asArray(r.targetObjectIds).filter(
      (value): value is string => typeof value === "string",
    ),
    reportedAt: asNumber(r.reportedAt, 0),
    reportedBy:
      r.reportedBy === "host" || r.reportedBy === "system"
        ? r.reportedBy
        : "agent-self-report",
  };
  if (typeof r.targetSpaceId === "string")
    activity.targetSpaceId = r.targetSpaceId;
  if (Array.isArray(r.inputs)) activity.inputs = r.inputs as string[];
  if (Array.isArray(r.outputs)) activity.outputs = r.outputs as string[];
  if (typeof r.stale === "boolean") activity.stale = r.stale;
  return activity;
};

const normalizePatchTarget = (value: unknown): Patch["target"] => {
  switch (value) {
    case "presentation":
    case "relation":
    case "batch":
      return value;
    default:
      return "object";
  }
};

const normalizeHistoryEntry = (raw: unknown): TimelineEntry => {
  const r = isRecord(raw) ? raw : {};
  const patch = isRecord(r.patch) ? r.patch : {};
  return {
    id: asString(r.id, ""),
    intentId: asString(r.intentId, ""),
    label: asString(r.label, ""),
    at: asNumber(r.at, 0),
    author: asString(r.author, "unknown"),
    // parentId 与 seq 是时间线的骨架：归一化时丢了它，树就塌成一堆散点，
    // 「跳到任意一条记录」随之失效。条目级字段一律保留。
    ...(typeof r.parentId === "string" && r.parentId
      ? { parentId: r.parentId }
      : {}),
    seq: asNumber(r.seq, 0),
    // kind 是 I12 的判别字段：丢了它，存一次盘之后这条动作就再也说不清是不是外部效果。
    ...(typeof r.kind === "string" && r.kind ? { kind: r.kind } : {}),
    // authorKind 决定面板上这条是人做的还是 Agent 做的：同样不能丢。
    ...(r.authorKind === "agent" || r.authorKind === "human"
      ? { authorKind: r.authorKind }
      : {}),
    patch: {
      target: normalizePatchTarget(patch.target),
      id: asString(patch.id, ""),
      before: patch.before,
      after: patch.after,
    },
  };
};

/**
 * 归一化历史状态。
 *
 * v2 是权威形状；读到 v1（双栈）时按迁移链处理——这里做的是**兜底**，
 * 正常路径由 WORKSPACE_MIGRATIONS 先把 v1 迁成 v2。
 */
const normalizeHistoryState = (raw: unknown): TimelineState => {
  const r = isRecord(raw) ? raw : {};
  if (Array.isArray(r.entries)) {
    const entries = asArray(r.entries)
      .filter(isRecord)
      .map(normalizeHistoryEntry);
    return {
      version: 2,
      entries,
      cursorId:
        typeof r.cursorId === "string" && r.cursorId ? r.cursorId : undefined,
    };
  }
  // v1 双栈：undo 串成一条链，redo 挂在链尾之下作为分支，不丢记录。
  // 迁移规则只有一处实现（core/history.ts 的 migrateHistoryState），
  // 两边各写一份迟早会漂。
  return migrateHistoryState({
    undo: asArray(r.undo).filter(isRecord),
    redo: asArray(r.redo).filter(isRecord),
  } as never);
};

const normalizeAuditEntry = (raw: unknown): AuditEntry => {
  const r = isRecord(raw) ? raw : {};
  const entry: AuditEntry = {
    id: asString(r.id, ""),
    at: asNumber(r.at, 0),
    actor: asString(r.actor, "unknown"),
    actorKind: r.actorKind === "agent" ? "agent" : "human",
    action: asString(r.action, ""),
  };
  if (isRecord(r.target))
    entry.target = {
      kind: asString(r.target.kind, ""),
      id: asString(r.target.id, ""),
    };
  if (r.via === "undo" || r.via === "redo") entry.via = r.via;
  return entry;
};

/** 把任意（可能来自旧版本或外部编辑的）结构收敛为当前版本的 WorkspaceFile。 */
const normalizeWorkspace = (raw: unknown): WorkspaceFile => {
  const r = isRecord(raw) ? raw : {};
  const id = asString(r.id, "");
  if (!id)
    throw new WorkspaceCorruptError(
      "workspace file has no usable id; refusing to invent an empty workspace",
    );
  const history = isRecord(r.history) ? r.history : {};
  const objects = asArray(r.objects).filter(isRecord).map(normalizeObject);
  const relations = asArray(r.relations)
    .filter(isRecord)
    .map(normalizeRelation);
  // 唯一性（I1）：重复 id 落盘读回必须被检出，不能静默通过。
  assertUniqueIds(objects, relations);
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    id,
    title: asString(r.title, "Untitled workspace"),
    createdAt: asNumber(r.createdAt, 0),
    updatedAt: asNumber(r.updatedAt, 0),
    revision: asNumber(r.revision, 0),
    contentRevision: asNumber(r.contentRevision, 0),
    boards: asArray(r.boards).filter(isRecord).map(normalizeBoard),
    objects,
    relations,
    resources: asArray(r.resources).filter(isRecord).map(normalizeResource),
    activities: asArray(r.activities).filter(isRecord).map(normalizeActivity),
    history: normalizeHistoryState(history),
    audit: asArray(r.audit).filter(isRecord).map(normalizeAuditEntry),
  };
};

/** 唯一性检查：重复 id 是坏数据，必须在读回时就说清楚，而不是静默取第一个。 */
const assertUniqueIds = (
  objects: WorkspaceObject[],
  relations: ObjectRelation[],
) => {
  const seen = new Map<string, string>();
  for (const object of objects) {
    if (!object.id) continue;
    if (seen.has(object.id))
      throw new WorkspaceCorruptError(
        `workspace file contains duplicate object id "${object.id}"`,
      );
    seen.set(object.id, "object");
  }
  for (const relation of relations) {
    if (!relation.id) continue;
    if (seen.has(relation.id))
      throw new WorkspaceCorruptError(
        `workspace file contains duplicate id "${relation.id}" (object and relation share an id)`,
      );
    seen.set(relation.id, "relation");
  }
};

/**
 * 版本迁移链。新增版本时在此追加 { from, to, describe, apply }，
 * migrate() 会按链逐级执行，不会跳过中间版本。
 */
export const WORKSPACE_MIGRATIONS: WorkspaceMigration[] = [
  {
    from: 0,
    to: 1,
    describe:
      "v0 → v1：单板 board 升级为 boards 数组，并补齐 history / audit / contentRevision 默认值",
    apply: (raw) => {
      const next = { ...raw };
      if (!Array.isArray(next.boards)) {
        const legacy = next.board;
        next.boards = isRecord(legacy) ? [legacy] : [];
        delete next.board;
      }
      if (!isRecord(next.history)) next.history = { undo: [], redo: [] };
      if (!Array.isArray(next.audit)) next.audit = [];
      if (typeof next.contentRevision !== "number") next.contentRevision = 0;
      next.schemaVersion = 1;
      return next;
    },
  },
  {
    from: 1,
    to: 2,
    describe:
      "v1 → v2：历史从双栈（撤销栈 + 重做栈）迁成分支时间线（单条日志 + 游标）",
    apply: (raw) => {
      const next = { ...raw };
      const history = isRecord(next.history) ? next.history : {};
      if (Array.isArray(history.entries)) {
        // 已经是 v2 形状，别动。
        next.schemaVersion = 2;
        return next;
      }
      next.history = migrateHistoryState({
        undo: asArray(history.undo).filter(isRecord),
        redo: asArray(history.redo).filter(isRecord),
      } as never);
      next.schemaVersion = 2;
      return next;
    },
  },
];

const readSchemaVersion = (raw: Record<string, unknown>): number => {
  const value = raw.schemaVersion;
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
    throw new WorkspaceCorruptError(
      `workspace schemaVersion must be a non-negative integer, got ${JSON.stringify(value)}`,
    );
  return value;
};

/**
 * 把任意来源的原始内容迁移到当前版本。
 * 未来版本抛 WorkspaceVersionError（不丢弃数据）；结构非法抛 WorkspaceCorruptError。
 */
export function migrate(raw: unknown): WorkspaceFile {
  if (!isRecord(raw))
    throw new WorkspaceCorruptError("workspace file must be a JSON object");
  let current: Record<string, unknown> = raw;
  let version = readSchemaVersion(current);
  if (version > WORKSPACE_SCHEMA_VERSION)
    throw new WorkspaceVersionError(
      `workspace schema version ${version} is newer than the supported version ${WORKSPACE_SCHEMA_VERSION}; refusing to discard data`,
    );
  while (version < WORKSPACE_SCHEMA_VERSION) {
    const step = WORKSPACE_MIGRATIONS.find((m) => m.from === version);
    if (!step)
      throw new WorkspaceCorruptError(
        `no migration path from workspace schema version ${version}`,
      );
    current = step.apply(current);
    version = step.to;
  }
  return normalizeWorkspace(current);
}

/** 收集工作空间引用的全部外部依赖（资源、对象来源、关系证据）。 */
export function collectExternalDependencies(
  workspace: WorkspaceFile,
): ExternalDependency[] {
  const found = new Map<string, ExternalDependency>();
  const add = (
    locator:
      | { kind?: string; uri?: string; fragment?: string; version?: string }
      | undefined,
    by: string,
  ) => {
    if (!locator) return;
    const uri = typeof locator.uri === "string" ? locator.uri : "";
    if (!uri) return;
    const kind = typeof locator.kind === "string" ? locator.kind : "unknown";
    const fragment =
      typeof locator.fragment === "string" ? locator.fragment : "";
    const revision = typeof locator.version === "string" ? locator.version : "";
    const key = `${kind}\u0000${uri}\u0000${fragment}\u0000${revision}`;
    const existing = found.get(key);
    if (existing) {
      if (!existing.referencedBy.includes(by)) existing.referencedBy.push(by);
      return;
    }
    const entry: ExternalDependency = { kind, uri, referencedBy: [by] };
    if (fragment) entry.fragment = fragment;
    if (revision) entry.version = revision;
    found.set(key, entry);
  };
  for (const resource of workspace.resources)
    add(
      {
        kind: resource.kind,
        uri: resource.uri,
        fragment: resource.fragment,
        version: resource.version,
      },
      `resource:${resource.id}`,
    );
  for (const object of workspace.objects)
    add(object.source?.external, `object:${object.id}`);
  for (const relation of workspace.relations)
    for (const evidence of relation.evidence ?? [])
      add(evidence, `relation:${relation.id}`);
  return [...found.values()].sort((a, b) =>
    a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0,
  );
}

/** 默认文件系统实现。测试可注入包装版模拟写失败。 */
export const nodeWorkspaceFileSystem: WorkspaceFileSystem = {
  existsSync: (target) => existsSync(target),
  mkdirSync: (target, options) => {
    mkdirSync(target, options);
  },
  readFileSync: (target, encoding) => readFileSync(target, encoding),
  readFileBuffer: (target) => readFileSync(target),
  writeFileSync: (target, data, encoding) => {
    writeFileSync(target, data, encoding);
  },
  openSync: (target, flags) => openSync(target, flags),
  fsyncSync: (fd) => {
    fsyncSync(fd);
  },
  closeSync: (fd) => {
    closeSync(fd);
  },
  renameSync: (from, to) => {
    renameSync(from, to);
  },
  copyFileSync: (from, to) => {
    copyFileSync(from, to);
  },
  unlinkSync: (target) => {
    unlinkSync(target);
  },
  readdirSync: (target) => readdirSync(target),
  statSync: (target) => statSync(target),
};

/**
 * 工作空间存储。文件系统是唯一权威（契约 §5.2）。
 *
 * 写：先写 .tmp 并 fsync，再把上一份保留为 .bak，最后 rename 覆盖主文件。
 * 读：主文件不可读时回退 .bak 并显式标记 recovered；两者都不可读时抛
 * WorkspaceCorruptError，绝不返回空工作空间。
 */
export class WorkspaceStore {
  /** 存储根目录。<root>/<workspaceId>/workspace.json */
  readonly root: string;
  /** 最近一次失败。save() 失败时上层据此展示「保存失败」。 */
  lastError: WorkspaceStoreError | null = null;
  private readonly now: () => number;
  private readonly fs: WorkspaceFileSystem;

  constructor(
    root: string,
    options?: { now?: () => number; fs?: WorkspaceFileSystem },
  ) {
    if (typeof root !== "string" || !root.trim())
      throw new WorkspaceError("workspace root must be a non-empty path");
    this.root = resolve(root);
    this.now = options?.now ?? Date.now;
    this.fs = options?.fs ?? nodeWorkspaceFileSystem;
  }

  /** <root>/<workspaceId> */
  workspaceDir(id: string): string {
    return join(this.root, this.assertId(id));
  }

  /**
   * 确保工作空间目录存在，返回目录路径。
   *
   * 锁文件要落在目录里，而独占创建不会建目录——
   * 新工作空间第一次保存时目录还没有，锁会直接创建失败。
   */
  ensureDir(id: string): string {
    const dir = this.workspaceDir(id);
    this.fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** <root>/<workspaceId>/workspace.json */
  mainPath(id: string): string {
    return join(this.workspaceDir(id), "workspace.json");
  }

  /** <root>/<workspaceId>/workspace.json.bak */
  backupPath(id: string): string {
    return join(this.workspaceDir(id), "workspace.json.bak");
  }

  /** <root>/<workspaceId>/workspace.json.tmp */
  tempPath(id: string): string {
    return join(this.workspaceDir(id), "workspace.json.tmp");
  }

  /** <root>/<workspaceId>/attachments */
  attachmentsDir(id: string): string {
    return join(this.workspaceDir(id), "attachments");
  }

  /** 该 ID 是否已被占用（主文件或备份存在）。 */
  exists(id: string): boolean {
    const target = this.assertId(id);
    return (
      this.fs.existsSync(this.mainPath(target)) ||
      this.fs.existsSync(this.backupPath(target))
    );
  }

  /**
   * 新建一个空白工作空间（纯内存，不落盘）。
   * 落盘必须显式调用 save()，避免「以为存了其实没存」。
   */
  create(input?: { id?: string; title?: string; now?: number }): WorkspaceFile {
    try {
      const at = input?.now ?? this.now();
      const id = input?.id ?? randomUUID();
      this.assertId(id);
      const workspace: WorkspaceFile = {
        schemaVersion: WORKSPACE_SCHEMA_VERSION,
        id,
        title: input?.title ?? "Untitled workspace",
        createdAt: at,
        updatedAt: at,
        revision: 0,
        contentRevision: 0,
        boards: [],
        objects: [],
        relations: [],
        resources: [],
        activities: [],
        history: { version: 2, entries: [], cursorId: undefined },
        audit: [],
      };
      this.lastError = null;
      return workspace;
    } catch (error) {
      return this.fail("create", error, input?.id);
    }
  }

  /**
   * 原子写。失败时抛错并保留主文件原内容，绝不留下半截文件。
   * 返回落盘后的（已归一化的）内容；调用方负责 updatedAt / revision。
   */
  save(workspace: WorkspaceFile): WorkspaceFile {
    try {
      const persisted = this.persist(workspace);
      this.lastError = null;
      return persisted;
    } catch (error) {
      const id = isRecord(workspace) ? asString(workspace.id, "") : "";
      return this.fail("save", error, id || undefined);
    }
  }

  /**
   * 读取工作空间。主文件不可读时回退 .bak 并标记 recovered。
   * 两者都不可读时抛 WorkspaceCorruptError。
   */
  load(id: string): WorkspaceLoadResult {
    let targetId = "";
    try {
      targetId = this.assertId(id);
      const primary = this.mainPath(targetId);
      const backup = this.backupPath(targetId);
      const hasPrimary = this.fs.existsSync(primary);
      const hasBackup = this.fs.existsSync(backup);
      if (!hasPrimary && !hasBackup)
        throw new WorkspaceNotFoundError(
          `workspace "${targetId}" not found under ${this.root}`,
        );
      if (hasPrimary) {
        try {
          const workspace = this.readWorkspaceFile(primary);
          this.lastError = null;
          return { workspace, recovered: false };
        } catch (error) {
          // 未来版本不是「损坏」：拒绝回退，避免用旧备份覆盖更新的数据。
          if (error instanceof WorkspaceVersionError) throw error;
          if (!hasBackup)
            throw new WorkspaceCorruptError(
              `workspace "${targetId}" is unreadable and no backup exists: ${describe(error)}`,
              { cause: error },
            );
          try {
            const workspace = this.readWorkspaceFile(backup);
            return {
              workspace,
              recovered: true,
              reason: `primary workspace.json is unreadable (${describe(error)}); recovered from workspace.json.bak`,
            };
          } catch (backupError) {
            if (backupError instanceof WorkspaceVersionError) throw backupError;
            throw new WorkspaceCorruptError(
              `workspace "${targetId}" is unreadable in both files: primary (${describe(error)}), backup (${describe(backupError)})`,
              { cause: backupError },
            );
          }
        }
      }
      const workspace = this.readWorkspaceFile(backup);
      return {
        workspace,
        recovered: true,
        reason:
          "primary workspace.json is missing; recovered from workspace.json.bak",
      };
    } catch (error) {
      return this.fail("load", error, targetId || undefined);
    }
  }

  /**
   * 列出所有工作空间摘要。单个文件损坏时跳过并记录，不影响整体。
   * 注意：损坏的工作空间不会回退到备份（list 只读主文件），
   * 需要恢复时用 load(id) 走回退路径。
   */
  list(): WorkspaceListResult {
    const workspaces: WorkspaceSummary[] = [];
    const errors: { id: string; reason: string }[] = [];
    try {
      if (!this.fs.existsSync(this.root)) {
        this.lastError = null;
        return { workspaces, errors };
      }
      let entries: string[];
      try {
        entries = this.fs.readdirSync(this.root);
      } catch (error) {
        // 根目录读不出来（例如 root 指向一个文件或没有权限）：
        // 报告即可，不能让整个 list 崩掉。
        this.recordError("list", error, this.root);
        errors.push({
          id: this.root,
          reason: `workspace root is unreadable: ${describe(error)}`,
        });
        return { workspaces, errors };
      }
      for (const entry of entries) {
        if (entry.startsWith(".")) continue;
        const main = join(this.root, entry, "workspace.json");
        if (!this.fs.existsSync(main)) continue;
        try {
          const workspace = this.readWorkspaceFile(main);
          workspaces.push({
            id: workspace.id,
            title: workspace.title,
            createdAt: workspace.createdAt,
            updatedAt: workspace.updatedAt,
            schemaVersion: workspace.schemaVersion,
          });
        } catch (error) {
          errors.push({
            id: entry,
            reason: `workspace.json is unreadable: ${describe(error)}`,
          });
        }
      }
      workspaces.sort(
        (a, b) =>
          b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
      this.lastError = null;
      return { workspaces, errors };
    } catch (error) {
      return this.fail("list", error);
    }
  }

  /**
   * 导出为自包含 JSON 包。外部依赖单独列出，导入时需要提示「引用未随包迁移」。
   */
  exportBundle(id: string, options?: { inlineAttachments?: boolean }): string {
    let targetId = "";
    try {
      targetId = this.assertId(id);
      const loaded = this.load(targetId);
      const bundle: WorkspaceBundle = {
        format: WORKSPACE_BUNDLE_FORMAT,
        bundleVersion: WORKSPACE_BUNDLE_VERSION,
        exportedAt: this.now(),
        schemaVersion: loaded.workspace.schemaVersion,
        workspace: loaded.workspace,
        externalDependencies: collectExternalDependencies(loaded.workspace),
        attachments: this.collectAttachments(
          targetId,
          options?.inlineAttachments === true,
        ),
        source: { recovered: loaded.recovered, reason: loaded.reason },
      };
      this.lastError = null;
      return JSON.stringify(bundle, null, 2) + "\n";
    } catch (error) {
      return this.fail("export", error, targetId || undefined);
    }
  }

  /**
   * 导入导出包。解析 + 迁移后落盘并返回工作空间内容。
   * 同 ID 已存在时抛 WorkspaceConflictError，除非显式传 overwrite。
   */
  importBundle(json: string, options?: { overwrite?: boolean }): WorkspaceFile {
    try {
      const workspace = migrate(this.parseBundle(json));
      this.assertId(workspace.id);
      if (!options?.overwrite && this.exists(workspace.id))
        throw new WorkspaceConflictError(
          `workspace "${workspace.id}" already exists under ${this.root}; import requires an explicit choice and never silently replaces an existing workspace`,
        );
      this.persist(workspace);
      this.lastError = null;
      return workspace;
    } catch (error) {
      return this.fail("import", error);
    }
  }

  /** 归一化 + 原子写。不修改调用方传入的对象。 */
  private persist(workspace: WorkspaceFile): WorkspaceFile {
    // 先校验 ID：越界或非法命名必须在碰文件系统之前就被拒绝。
    const rawId = isRecord(workspace) ? workspace.id : undefined;
    this.assertId(typeof rawId === "string" ? rawId : "");
    const persisted = migrate(workspace);
    this.assertId(persisted.id);
    this.fs.mkdirSync(this.workspaceDir(persisted.id), { recursive: true });
    this.fs.mkdirSync(this.attachmentsDir(persisted.id), { recursive: true });
    this.writeAtomic(
      this.mainPath(persisted.id),
      JSON.stringify(persisted, null, 2) + "\n",
    );
    return persisted;
  }

  /**
   * 原子写：写 .tmp → fsync → 备份上一份为 .bak → rename 覆盖。
   * 任何一步失败都抛错，主文件内容保持不变，临时文件被清理。
   */
  private writeAtomic(target: string, contents: string): void {
    const directory = dirname(target);
    const temp = `${target}.tmp`;
    const backup = `${target}.bak`;
    const tempBackup = `${backup}.tmp`;
    this.fs.mkdirSync(directory, { recursive: true });
    let tempWritten = false;
    try {
      this.fs.writeFileSync(temp, contents, "utf8");
      tempWritten = true;
      const fd = this.fs.openSync(temp, "r+");
      try {
        this.fs.fsyncSync(fd);
      } finally {
        this.fs.closeSync(fd);
      }
      if (this.fs.existsSync(target)) {
        this.fs.copyFileSync(target, tempBackup);
        this.fs.renameSync(tempBackup, backup);
      }
      this.fs.renameSync(temp, target);
      tempWritten = false;
      this.syncDirectory(directory);
    } catch (error) {
      if (tempWritten) this.safeUnlink(temp);
      this.safeUnlink(tempBackup);
      throw error;
    }
  }

  /** 目录 fsync：让 rename 本身落盘。部分平台不支持，失败不影响主流程。 */
  private syncDirectory(directory: string): void {
    let fd: number | undefined;
    try {
      fd = this.fs.openSync(directory, "r");
      this.fs.fsyncSync(fd);
    } catch {
      // 平台不支持目录 fsync：不影响内容正确性。
    } finally {
      if (fd !== undefined)
        try {
          this.fs.closeSync(fd);
        } catch {
          // 忽略关闭失败。
        }
    }
  }

  private safeUnlink(target: string): void {
    try {
      this.fs.unlinkSync(target);
    } catch {
      // 清理失败不掩盖原始错误。
    }
  }

  private readWorkspaceFile(file: string): WorkspaceFile {
    const text = this.fs.readFileSync(file, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new WorkspaceCorruptError(
        `${file} is not valid JSON: ${describe(error)}`,
        { cause: error },
      );
    }
    return migrate(parsed);
  }

  private parseBundle(json: string): unknown {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (error) {
      throw new WorkspaceCorruptError(
        `bundle is not valid JSON: ${describe(error)}`,
        { cause: error },
      );
    }
    if (!isRecord(parsed))
      throw new WorkspaceCorruptError("bundle must be a JSON object");
    return isRecord(parsed.workspace) ? parsed.workspace : parsed;
  }

  private collectAttachments(id: string, inline: boolean): BundleAttachment[] {
    const directory = this.attachmentsDir(id);
    if (!this.fs.existsSync(directory)) return [];
    const names = this.fs
      .readdirSync(directory)
      .filter((name) => !name.startsWith("."))
      .sort();
    return names.map((name) => {
      const full = join(directory, name);
      const attachment: BundleAttachment = {
        name,
        bytes: this.fs.statSync(full).size,
      };
      if (inline)
        attachment.dataBase64 = this.fs.readFileBuffer(full).toString("base64");
      return attachment;
    });
  }

  private assertId(id: string): string {
    if (typeof id !== "string" || !WORKSPACE_ID_PATTERN.test(id))
      throw new WorkspaceIdError(
        `invalid workspace id ${JSON.stringify(id)}; ids must match ${WORKSPACE_ID_PATTERN.source}`,
      );
    return id;
  }

  /** 记录失败并抛出。lastError 供上层展示「保存失败」。 */
  private fail(
    operation: WorkspaceStoreError["operation"],
    error: unknown,
    workspaceId?: string,
  ): never {
    this.recordError(operation, error, workspaceId);
    throw error;
  }

  /** 只记录失败，不抛出。用于「整体成功但局部有问题」的场景。 */
  private recordError(
    operation: WorkspaceStoreError["operation"],
    error: unknown,
    workspaceId?: string,
  ): void {
    this.lastError = {
      operation,
      message: describe(error),
      workspaceId,
      at: this.now(),
    };
  }
}
