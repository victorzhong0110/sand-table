// v2 工作空间文件的读取与版本迁移。
//
// 这段逻辑是从 v2 的 core/workspace.ts 复制过来的：v2 目录在 T24 会被删除，
// 导入器必须能独立存活，所以这里不 import core/ 的任何代码，类型也用本文件里的局部类型。
//
// 只保留读取需要的部分：v2 的撤销历史不导入（docs/kernel-v3/01-data-model.md §10），
// 所以 history 不在这里解析，v1 → v2 这一步只改版本号。

import { readFileSync } from "node:fs";

/** v2 工作空间文件的版本。落盘的 v2 文件始终是这个版本。 */
export const V2_SCHEMA_VERSION = 2;

/** v2 的布局矩形。 */
export type V2Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
  pinned: boolean;
};

/** v2 板内分区。 */
export type V2Space = {
  id: string;
  title: string;
  parentId?: string;
  objectId?: string;
};

/** v2 展示实例的绑定。 */
export type V2Binding = {
  kind: "object" | "local" | "tool";
  objectId?: string;
};

/** v2 展示实例。 */
export type V2Presentation = {
  id: string;
  spaceId: string;
  type: string;
  binding?: V2Binding;
  objectId?: string;
  appearance?: { icon?: string; detail?: "full" | "label" | "icon" };
  title: string;
  data: Record<string, unknown>;
  rect: V2Rect;
  updatedAt: number;
  author: string;
};

/** v2 的外部资源定位。 */
export type V2ExternalLocator = {
  kind: "file" | "git" | "pdf" | "url" | "dataset" | "symbol";
  uri: string;
  fragment?: string;
  version?: string;
};

/** v2 的对象来源。 */
export type V2ObjectSource = {
  origin: "human" | "imported" | "ai-generated" | "ai-inferred" | "code-index";
  author?: string;
  basis?: string;
  external?: V2ExternalLocator;
  importedAt?: number;
  fingerprint?: string;
};

/** v2 的内容对象。 */
export type V2Object = {
  id: string;
  kind: "native" | "code" | "reference";
  type: string;
  typeVersion: number;
  title: string;
  body?: string;
  data?: Record<string, unknown>;
  source?: V2ObjectSource;
  version: number;
  createdAt: number;
  updatedAt: number;
  author: string;
};

/** v2 的对象关系。 */
export type V2Relation = {
  id: string;
  source: string;
  target: string;
  kind: string;
  status: "confirmed" | "inferred";
  attributes?: Record<string, unknown>;
  basis?: string;
  evidence?: V2ExternalLocator[];
  createdAt: number;
  author: string;
};

/** v2 的空间链接：两端是展示实例。 */
export type V2SpaceLink = {
  id: string;
  source: string;
  target: string;
  kind: "related" | "depends-on" | "supports" | "compares" | "belongs-to";
  description: string;
  author: string;
};

/** v2 的分组。 */
export type V2Group = {
  id: string;
  title: string;
  objectIds: string[];
  instanceIds?: string[];
};

/** v2 的附件。 */
export type V2Asset = {
  id: string;
  name: string;
  mime: string;
  dataUrl?: string;
  bytes: number;
};

/** v2 导览的一站。 */
export type V2GuideStep = {
  title: string;
  explanation: string;
  objectIds: string[];
  evidence: V2Evidence[];
  uncertainty: string;
};

/** v2 的代码证据。 */
export type V2Evidence = {
  workspaceId: string;
  path: string;
  startLine: number;
  endLine: number;
  hash: string;
};

/** v2 的导览。 */
export type V2Guide = {
  id: string;
  title: string;
  purpose: string;
  inputs: string;
  outputs: string;
  agentId: string;
  steps: V2GuideStep[];
  stale: boolean;
  status: string;
  createdAt: number;
};

/** v2 的审计条目。 */
export type V2AuditEntry = {
  id: string;
  at: number;
  actor: string;
  actorKind: "human" | "agent";
  action: string;
  target?: { kind: string; id: string };
  via?: "undo" | "redo";
};

/** v2 导入的组件包（清单的存储形态）。 */
export type V2ComponentPack = {
  id: string;
  name: string;
  version: number;
  description?: string;
  author?: string;
  homepage?: string;
  source: string;
  importedAt: number;
  importedBy: string;
  components: {
    key: string;
    type: string;
    title: string;
    icon?: string;
    width?: number;
    height?: number;
    data?: Record<string, unknown>;
  }[];
};

/** v2 的板级状态。 */
export type V2Board = {
  id: string;
  title: string;
  revision: number;
  contentRevision: number;
  spaces: V2Space[];
  presentations: V2Presentation[];
  views: Record<string, unknown>;
  focusedViewId?: string;
  selection: string[];
  placements: Record<string, unknown>;
  notes: Record<string, string>;
  groups: V2Group[];
  spaceLinks: V2SpaceLink[];
  assets: V2Asset[];
  componentPacks: V2ComponentPack[];
  activities: unknown[];
  spaceActivities: unknown[];
  guides: V2Guide[];
  intents: Record<string, unknown>[];
  proposals: Record<string, unknown>[];
  validations: Record<string, unknown>[];
  theme?: unknown;
};

/** v2 的工作空间快照。 */
export type V2Workspace = {
  schemaVersion: number;
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  revision: number;
  contentRevision: number;
  boards: V2Board[];
  objects: V2Object[];
  relations: V2Relation[];
  resources: unknown[];
  activities: unknown[];
  audit: V2AuditEntry[];
};

/** v2 文件坏了或者版本太新。导入器据此报错，不猜内容。 */
export class V2MigrationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "V2MigrationError";
  }
}

/** 一个版本迁移步骤。链式执行：0 → 1 → 2 … */
type V2Migration = {
  from: number;
  to: number;
  describe: string;
  apply: (raw: Record<string, unknown>) => Record<string, unknown>;
};

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

/**
 * 版本迁移链。新增版本时在此追加 { from, to, describe, apply }，
 * migrateV2() 会按链逐级执行，不会跳过中间版本。
 */
export const V2_MIGRATIONS: V2Migration[] = [
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
      "v1 → v2：历史从双栈（撤销栈 + 重做栈）迁成分支时间线（单条日志 + 游标）；撤销历史不导入，所以这里只改版本号",
    apply: (raw) => {
      const next = { ...raw };
      next.schemaVersion = 2;
      return next;
    },
  },
];

const readSchemaVersion = (raw: Record<string, unknown>): number => {
  const value = raw.schemaVersion;
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
    throw new V2MigrationError(
      `工作空间文件的 schemaVersion 必须是大于等于 0 的整数，实际是 ${JSON.stringify(value)}`,
    );
  return value;
};

const normalizeSpace = (raw: unknown): V2Space => {
  const r = isRecord(raw) ? raw : {};
  const space: V2Space = {
    id: asString(r.id, ""),
    title: asString(r.title, ""),
  };
  if (typeof r.parentId === "string") space.parentId = r.parentId;
  if (typeof r.objectId === "string") space.objectId = r.objectId;
  return space;
};

/**
 * 展示实例逐字段归一化。
 * 缺 id / spaceId / type / rect 的实例是坏数据：判为损坏，而不是放行到运行时才炸。
 */
const normalizePresentation = (raw: unknown): V2Presentation => {
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
    throw new V2MigrationError(
      `展示实例坏了：${JSON.stringify(raw).slice(0, 200)}`,
    );
  const presentation: V2Presentation = {
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

const normalizeObject = (raw: unknown): V2Object => {
  const r = isRecord(raw) ? raw : {};
  const object: V2Object = {
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
  if (typeof r.body === "string") object.body = r.body;
  if (isRecord(r.data)) object.data = { ...r.data };
  if (isRecord(r.source)) {
    const s = r.source;
    const source: V2ObjectSource = {
      origin:
        s.origin === "imported" ||
        s.origin === "ai-generated" ||
        s.origin === "ai-inferred" ||
        s.origin === "code-index"
          ? s.origin
          : "human",
    };
    if (typeof s.author === "string") source.author = s.author;
    if (typeof s.basis === "string") source.basis = s.basis;
    if (typeof s.importedAt === "number") source.importedAt = s.importedAt;
    if (typeof s.fingerprint === "string") source.fingerprint = s.fingerprint;
    if (isRecord(s.external)) {
      const e = s.external;
      const kind = e.kind;
      const external: V2ExternalLocator = {
        kind:
          kind === "git" ||
          kind === "pdf" ||
          kind === "url" ||
          kind === "dataset" ||
          kind === "symbol"
            ? kind
            : "file",
        uri: asString(e.uri, ""),
      };
      if (typeof e.fragment === "string") external.fragment = e.fragment;
      if (typeof e.version === "string") external.version = e.version;
      source.external = external;
    }
    object.source = source;
  }
  return object;
};

const normalizeRelation = (raw: unknown): V2Relation => {
  const r = isRecord(raw) ? raw : {};
  const relation: V2Relation = {
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
    relation.evidence = r.evidence.filter(isRecord) as V2ExternalLocator[];
  return relation;
};

const normalizeSpaceLink = (raw: unknown): V2SpaceLink => {
  const r = isRecord(raw) ? raw : {};
  const kind = r.kind;
  return {
    id: asString(r.id, ""),
    source: asString(r.source, ""),
    target: asString(r.target, ""),
    kind:
      kind === "depends-on" ||
      kind === "supports" ||
      kind === "compares" ||
      kind === "belongs-to"
        ? kind
        : "related",
    description: asString(r.description, ""),
    author: asString(r.author, "unknown"),
  };
};

const normalizeGroup = (raw: unknown): V2Group => {
  const r = isRecord(raw) ? raw : {};
  const group: V2Group = {
    id: asString(r.id, ""),
    title: asString(r.title, ""),
    objectIds: asArray(r.objectIds).filter(
      (value): value is string => typeof value === "string",
    ),
  };
  if (Array.isArray(r.instanceIds))
    group.instanceIds = r.instanceIds.filter(
      (value): value is string => typeof value === "string",
    );
  return group;
};

const normalizeAsset = (raw: unknown): V2Asset => {
  const r = isRecord(raw) ? raw : {};
  const asset: V2Asset = {
    id: asString(r.id, ""),
    name: asString(r.name, ""),
    mime: asString(r.mime, "application/octet-stream"),
    bytes: asNumber(r.bytes, 0),
  };
  if (typeof r.dataUrl === "string") asset.dataUrl = r.dataUrl;
  return asset;
};

const normalizeGuideStep = (raw: unknown): V2GuideStep => {
  const r = isRecord(raw) ? raw : {};
  return {
    title: asString(r.title, ""),
    explanation: asString(r.explanation, ""),
    objectIds: asArray(r.objectIds).filter(
      (value): value is string => typeof value === "string",
    ),
    evidence: asArray(r.evidence).filter(isRecord) as V2Evidence[],
    uncertainty: asString(r.uncertainty, ""),
  };
};

const normalizeGuide = (raw: unknown): V2Guide => {
  const r = isRecord(raw) ? raw : {};
  return {
    id: asString(r.id, ""),
    title: asString(r.title, ""),
    purpose: asString(r.purpose, ""),
    inputs: asString(r.inputs, ""),
    outputs: asString(r.outputs, ""),
    agentId: asString(r.agentId, "unknown"),
    steps: asArray(r.steps).map(normalizeGuideStep),
    stale: r.stale === true,
    status: asString(r.status, ""),
    createdAt: asNumber(r.createdAt, 0),
  };
};

const normalizeAuditEntry = (raw: unknown): V2AuditEntry => {
  const r = isRecord(raw) ? raw : {};
  const entry: V2AuditEntry = {
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

const normalizeComponentPack = (raw: unknown): V2ComponentPack => {
  const r = isRecord(raw) ? raw : {};
  const pack: V2ComponentPack = {
    id: asString(r.id, ""),
    name: asString(r.name, ""),
    version: asNumber(r.version, 1),
    source: asString(r.source, ""),
    importedAt: asNumber(r.importedAt, 0),
    importedBy: asString(r.importedBy, "unknown"),
    components: [],
  };
  if (typeof r.description === "string") pack.description = r.description;
  if (typeof r.author === "string") pack.author = r.author;
  if (typeof r.homepage === "string") pack.homepage = r.homepage;
  for (const component of asArray(r.components)) {
    if (!isRecord(component)) continue;
    const key = asString(component.key, "");
    const type = asString(component.type, "");
    const title = asString(component.title, "");
    if (!key || !type || !title) continue;
    const converted: V2ComponentPack["components"][number] = {
      key,
      type,
      title,
    };
    if (typeof component.icon === "string") converted.icon = component.icon;
    if (typeof component.width === "number") converted.width = component.width;
    if (typeof component.height === "number")
      converted.height = component.height;
    if (isRecord(component.data)) converted.data = { ...component.data };
    pack.components.push(converted);
  }
  return pack;
};

const normalizeBoard = (raw: unknown): V2Board => {
  const r = isRecord(raw) ? raw : {};
  const notes: Record<string, string> = {};
  if (isRecord(r.notes))
    for (const [key, value] of Object.entries(r.notes))
      if (typeof value === "string") notes[key] = value;
  const board: V2Board = {
    id: asString(r.id, ""),
    title: asString(r.title, ""),
    revision: asNumber(r.revision, 0),
    contentRevision: asNumber(r.contentRevision, 0),
    spaces: asArray(r.spaces).filter(isRecord).map(normalizeSpace),
    presentations: asArray(r.presentations).map(normalizePresentation),
    views: isRecord(r.views) ? { ...r.views } : {},
    selection: asArray(r.selection).filter(
      (value): value is string => typeof value === "string",
    ),
    placements: isRecord(r.placements) ? { ...r.placements } : {},
    notes,
    groups: asArray(r.groups).map(normalizeGroup),
    spaceLinks: asArray(r.spaceLinks).map(normalizeSpaceLink),
    assets: asArray(r.assets).map(normalizeAsset),
    componentPacks: asArray(r.componentPacks).map(normalizeComponentPack),
    activities: asArray(r.activities),
    spaceActivities: asArray(r.spaceActivities),
    guides: asArray(r.guides).map(normalizeGuide),
    intents: asArray(r.intents).filter(isRecord),
    proposals: asArray(r.proposals).filter(isRecord),
    validations: asArray(r.validations).filter(isRecord),
  };
  if (typeof r.focusedViewId === "string")
    board.focusedViewId = r.focusedViewId;
  if (r.theme !== undefined) board.theme = r.theme;
  return board;
};

/** 唯一性检查：重复 id 是坏数据，必须在读回时就说清楚，而不是静默取第一个。 */
const assertUniqueIds = (objects: V2Object[], relations: V2Relation[]) => {
  const seen = new Set<string>();
  for (const object of objects) {
    if (!object.id) continue;
    if (seen.has(object.id))
      throw new V2MigrationError(
        `工作空间文件里有重复的对象 id「${object.id}」`,
      );
    seen.add(object.id);
  }
  for (const relation of relations) {
    if (!relation.id) continue;
    if (seen.has(relation.id))
      throw new V2MigrationError(
        `工作空间文件里有重复的 id「${relation.id}」（对象与关系用了同一个 id）`,
      );
    seen.add(relation.id);
  }
};

/** 把任意（可能来自旧版本或外部编辑的）结构收敛为当前版本的 v2 工作空间。 */
const normalizeWorkspace = (raw: unknown): V2Workspace => {
  const r = isRecord(raw) ? raw : {};
  const id = asString(r.id, "");
  if (!id)
    throw new V2MigrationError(
      "工作空间文件里没有可用的 id，不会凭空造一个空工作空间。",
    );
  const objects = asArray(r.objects).filter(isRecord).map(normalizeObject);
  const relations = asArray(r.relations)
    .filter(isRecord)
    .map(normalizeRelation);
  assertUniqueIds(objects, relations);
  return {
    schemaVersion: V2_SCHEMA_VERSION,
    id,
    title: asString(r.title, "未命名工作空间"),
    createdAt: asNumber(r.createdAt, 0),
    updatedAt: asNumber(r.updatedAt, 0),
    revision: asNumber(r.revision, 0),
    contentRevision: asNumber(r.contentRevision, 0),
    boards: asArray(r.boards).filter(isRecord).map(normalizeBoard),
    objects,
    relations,
    resources: asArray(r.resources).filter(isRecord),
    activities: asArray(r.activities).filter(isRecord),
    audit: asArray(r.audit).filter(isRecord).map(normalizeAuditEntry),
  };
};

/**
 * 把任意来源的原始内容迁移到 v2 的形状。
 * 未来版本抛错（不丢弃数据）；结构非法抛错。
 */
export function migrateV2(raw: unknown): V2Workspace {
  if (!isRecord(raw))
    throw new V2MigrationError("工作空间文件必须是一个 JSON 对象。");
  let current: Record<string, unknown> = raw;
  let version = readSchemaVersion(current);
  if (version > V2_SCHEMA_VERSION)
    throw new V2MigrationError(
      `工作空间文件的版本是 ${version}，比这个导入器支持的版本 ${V2_SCHEMA_VERSION} 还新，没有丢弃数据，请换更新的 Sand Table 打开。`,
    );
  while (version < V2_SCHEMA_VERSION) {
    const step = V2_MIGRATIONS.find((m) => m.from === version);
    if (!step)
      throw new V2MigrationError(
        `工作空间文件的版本 ${version} 没有可用的升级路径。`,
      );
    current = step.apply(current);
    version = step.to;
  }
  return normalizeWorkspace(current);
}

/** 读取并解析一个 v2 工作空间文件。读不了就抛错，调用方据此不改任何文件。 */
export function readV2Workspace(file: string): V2Workspace {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new V2MigrationError(
      `读不到旧的工作空间文件 ${file}：${describe(error)}`,
      { cause: error },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new V2MigrationError(
      `旧的工作空间文件 ${file} 不是合法的 JSON，没有导入任何内容。请检查文件是否损坏。`,
      { cause: error },
    );
  }
  return migrateV2(parsed);
}
