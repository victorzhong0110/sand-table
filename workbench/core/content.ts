// 对象、语义关系与展示实例的纯函数层。
// 契约见 docs/architecture/workspace-kernel.zh-CN.md 第 3、4 节（issue #11 的 P2）。
// 本文件只做纯计算：不读写文件系统、不发网络请求，UI 与 MCP 接线由上层负责。
//
// 三层职责（不要在接线时混淆）：
// - 原生对象 WorkspaceObject：内容的唯一真相，独立生命周期与版本。
// - 语义关系 ObjectRelation：对象之间的语义，与布局无关，不由位置相近自动产生。
// - 展示实例 Presentation：只管呈现与布局；绑定对象时内容来自对象，而不是 instance.data。
//
// 共享状态原则（版本与快照必须互不污染）：
// - 受版本保护的内容（对象的 data / source）**写时深拷贝、读时也返回副本**。
//   新版本不与旧版本共享任何可变结构：否则调用方可以绕过 version 就地改写内容，
//   并把撤销栈里的旧快照一起改坏（历史 before 会跟着变）。
// - 不受版本保护的布局（展示实例的 rect）属于白板状态，按原实例返回，由白板写路径负责。
import { boundObjectId } from "./objects.ts";
import type {
  ExternalLocator,
  ObjectRelation,
  ObjectSource,
  Presentation,
  WorkspaceObject,
} from "./objects.ts";

/** 对象 / 展示实例 / 语义关系的集合状态。 */
export type ObjectState = {
  objects: WorkspaceObject[];
  presentations: Presentation[];
  relations: ObjectRelation[];
};

/** 对象版本冲突：写入携带的 expectedVersion 与当前版本不一致（I9）。 */
export class StaleVersionError extends Error {
  readonly id: string;
  readonly expectedVersion: number;
  readonly currentVersion: number;
  constructor(id: string, expectedVersion: number, currentVersion: number) {
    super(
      `对象 ${id} 版本冲突：期望 ${expectedVersion}，当前 ${currentVersion}`,
    );
    this.name = "StaleVersionError";
    this.id = id;
    this.expectedVersion = expectedVersion;
    this.currentVersion = currentVersion;
  }
}

/** 对象仍被引用，拒绝删除（I3）。 */
export class ReferencedObjectError extends Error {
  readonly id: string;
  readonly presentationIds: string[];
  readonly relationIds: string[];
  constructor(id: string, presentationIds: string[], relationIds: string[]) {
    super(
      `对象 ${id} 仍被引用：展示实例 ${presentationIds.length} 个，关系 ${relationIds.length} 条`,
    );
    this.name = "ReferencedObjectError";
    this.id = id;
    this.presentationIds = presentationIds;
    this.relationIds = relationIds;
  }
}

/** 目标对象不存在。 */
export class ObjectNotFoundError extends Error {
  readonly id: string;
  constructor(id: string) {
    super(`对象 ${id} 不存在`);
    this.name = "ObjectNotFoundError";
    this.id = id;
  }
}

/** 关系 ID 重复：不允许用同一个 ID 静默覆盖既有关系。 */
export class DuplicateRelationError extends Error {
  readonly id: string;
  constructor(id: string) {
    super(`关系 ${id} 已存在`);
    this.name = "DuplicateRelationError";
    this.id = id;
  }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/** 深拷贝：数组与普通对象逐层复制，Date 复制时间戳，其余按引用保留。 */
const deepCopyValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map((item) => deepCopyValue(item));
  if (value instanceof Date) return new Date(value.getTime());
  if (isPlainObject(value)) {
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(value)) copy[key] = deepCopyValue(value[key]);
    return copy;
  }
  return value;
};

/** 深拷贝：切断与调用方的引用共享，避免外部改动污染内核状态。 */
export const deepCopy = <T>(value: T): T => deepCopyValue(value) as T;

const findObject = (
  objects: WorkspaceObject[],
  id: string,
): WorkspaceObject | undefined => objects.find((o) => o.id === id);

/**
 * 展示实例绑定的对象 ID。
 * 统一绑定用 binding.objectId；代码投影实例走旧字段 objectId（见 core/objects.ts）。
 * binding 明确声明为 local / tool 时不绑定任何对象。
 *
 * 这是**唯一**的绑定判定：删除、引用检查、撤销快照都必须用它，
 * 否则会出现「删掉了却撤不回来」这类口径分裂。
 */
export const boundId = (presentation: Presentation): string | undefined => {
  if (presentation.binding && presentation.binding.kind !== "object")
    return undefined;
  return boundObjectId(presentation);
};

/** 展示实例是否绑定到指定对象。 */
const bindsTo = (presentation: Presentation, objectId: string): boolean =>
  boundId(presentation) === objectId;

/**
 * 新建对象。kind 默认 "native"，version 从 1 起，createdAt / updatedAt 取传入的 now。
 * data / source 在写入时深拷贝，调用方之后再改自己的对象不会影响这里的内容。
 */
export function createObject(input: {
  id: string;
  type: string;
  title: string;
  body?: string;
  data?: Record<string, unknown>;
  source?: ObjectSource;
  typeVersion?: number;
  kind?: WorkspaceObject["kind"];
  now: number;
  author: string;
}): WorkspaceObject {
  return {
    id: input.id,
    kind: input.kind ?? "native",
    type: input.type,
    typeVersion: input.typeVersion ?? 1,
    title: input.title,
    ...(input.body === undefined ? {} : { body: input.body }),
    ...(input.data === undefined ? {} : { data: deepCopy(input.data) }),
    ...(input.source === undefined ? {} : { source: deepCopy(input.source) }),
    version: 1,
    createdAt: input.now,
    updatedAt: input.now,
    author: input.author,
  };
}

/**
 * 更新对象内容。expectedVersion 与当前版本不一致时抛 StaleVersionError，
 * 绝不静默覆盖（I9）。返回新对象，不修改传入的数组。
 *
 * 新版本与旧版本**不共享任何可变结构**：未被 patch 覆盖的 data / source 也会深拷贝，
 * 否则调用方拿到新版本后可以绕过 version 就地改写内容，并把撤销栈里的旧快照一起改坏。
 *
 * patch.data 与 patch.body 是整体替换，不是字段合并；patch.source 只能覆盖，不能清除。
 */
export function updateObject(
  objects: WorkspaceObject[],
  id: string,
  patch: {
    title?: string;
    body?: string;
    data?: Record<string, unknown>;
    source?: ObjectSource;
    type?: string;
    typeVersion?: number;
  },
  expectedVersion: number,
  now: number,
  author: string,
): WorkspaceObject {
  const current = findObject(objects, id);
  if (!current) throw new ObjectNotFoundError(id);
  if (current.version !== expectedVersion)
    throw new StaleVersionError(id, expectedVersion, current.version);
  const next: WorkspaceObject = { ...current };
  // 旧版本的可变载荷先脱钩：新版本必须与旧版本、调用方持有的引用完全独立。
  if (next.data !== undefined) next.data = deepCopy(next.data);
  if (next.source !== undefined) next.source = deepCopy(next.source);
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.body !== undefined) next.body = patch.body;
  if (patch.data !== undefined) next.data = deepCopy(patch.data);
  if (patch.source !== undefined) next.source = deepCopy(patch.source);
  if (patch.type !== undefined) next.type = patch.type;
  if (patch.typeVersion !== undefined) next.typeVersion = patch.typeVersion;
  next.version = current.version + 1;
  next.updatedAt = now;
  next.author = author;
  return next;
}

/**
 * 复制出独立对象：与「再放一份展示」是两件事（I2）。
 * 内容深拷贝，新 ID，version 重置为 1，createdAt / updatedAt 取 now。
 * source 随内容一起保留（来源描述的是内容出处，不是这次复制动作）。
 */
export function cloneObject(
  objects: WorkspaceObject[],
  id: string,
  newId: string,
  now: number,
  author: string,
): WorkspaceObject {
  const current = findObject(objects, id);
  if (!current) throw new ObjectNotFoundError(id);
  return {
    id: newId,
    kind: current.kind,
    type: current.type,
    typeVersion: current.typeVersion,
    title: current.title,
    ...(current.body === undefined ? {} : { body: current.body }),
    ...(current.data === undefined ? {} : { data: deepCopy(current.data) }),
    ...(current.source === undefined
      ? {}
      : { source: deepCopy(current.source) }),
    version: 1,
    createdAt: now,
    updatedAt: now,
    author,
  };
}

/**
 * 删除对象。
 * - onReferenced = "refuse"：仍有展示实例或关系引用时抛 ReferencedObjectError，
 *   不静默损坏引用（I3）。
 * - onReferenced = "detach"：连带移除引用它的展示实例与关系后删除，
 *   removed 里给出被移除的 id 列表。
 */
export function deleteObject(
  state: ObjectState,
  id: string,
  opts: { onReferenced: "refuse" | "detach" },
): {
  state: ObjectState;
  removed: { presentationIds: string[]; relationIds: string[] };
} {
  if (!findObject(state.objects, id)) throw new ObjectNotFoundError(id);
  const presentationIds = state.presentations
    .filter((p) => bindsTo(p, id))
    .map((p) => p.id);
  const relationIds = state.relations
    .filter((r) => r.source === id || r.target === id)
    .map((r) => r.id);
  if (
    opts.onReferenced === "refuse" &&
    (presentationIds.length > 0 || relationIds.length > 0)
  )
    throw new ReferencedObjectError(id, presentationIds, relationIds);
  const removedPresentations = new Set(presentationIds);
  const removedRelations = new Set(relationIds);
  return {
    state: {
      objects: state.objects.filter((o) => o.id !== id),
      presentations: state.presentations.filter(
        (p) => !removedPresentations.has(p.id),
      ),
      relations: state.relations.filter((r) => !removedRelations.has(r.id)),
    },
    removed: { presentationIds, relationIds },
  };
}

/**
 * 建立语义关系。status 默认 "confirmed"；推测性关系必须显式传 "inferred"（I5）。
 * 关系只由显式意图产生，本模块不提供任何「因为位置相近所以建立关系」的入口。
 * 同一 id 已存在时抛 DuplicateRelationError，不静默覆盖既有关系。
 * attributes / evidence 写入时深拷贝，调用方之后再改自己的输入不影响关系。
 */
export function relate(
  relations: ObjectRelation[],
  input: {
    id: string;
    source: string;
    target: string;
    kind: string;
    status?: "confirmed" | "inferred";
    attributes?: Record<string, unknown>;
    basis?: string;
    evidence?: ExternalLocator[];
    now: number;
    author: string;
  },
): ObjectRelation[] {
  if (relations.some((r) => r.id === input.id))
    throw new DuplicateRelationError(input.id);
  const relation: ObjectRelation = {
    id: input.id,
    source: input.source,
    target: input.target,
    kind: input.kind,
    status: input.status ?? "confirmed",
    ...(input.attributes === undefined
      ? {}
      : { attributes: deepCopy(input.attributes) }),
    ...(input.basis === undefined ? {} : { basis: input.basis }),
    ...(input.evidence === undefined
      ? {}
      : { evidence: deepCopy(input.evidence) }),
    createdAt: input.now,
    author: input.author,
  };
  return [...relations, relation];
}

/** 移除一条语义关系。id 不存在时原样返回（幂等）。 */
export function unlink(
  relations: ObjectRelation[],
  id: string,
): ObjectRelation[] {
  return relations.filter((r) => r.id !== id);
}

/**
 * 核心接缝：展示实例的呈现内容来自被绑定的对象，而不是 instance.data（I2）。
 * instance.data 在绑定场景下只保存视图级配置，不参与内容解析。
 *
 * 绑定指向已不存在的对象时回退到展示实例的本地内容，并保留悬空 objectId，
 * 让上层能识别「引用失效」，而不是假装对象还在。
 *
 * 返回的是**内容快照**（data / source 深拷贝）：内容受版本保护，
 * 拿到快照后就地改写会绕过 version 冲突检测，也会污染撤销栈里的旧快照。
 * 要改内容必须走 updateObject。
 */
/**
 * 只读视图：**不复制**内容。
 *
 * 渲染与检索路径用它。一块装了几百个组件的代码白板，每次渲染都深拷贝一遍
 * 文件内容，会把浏览器主线程拖垮（初始渲染迟迟出不来）。
 *
 * 返回值是内核状态的引用：只读，不要改。
 * 需要可改的副本时用 resolveContent()。
 */
export function peekContent(
  presentation: Presentation,
  objects: WorkspaceObject[],
): {
  title: string;
  body?: string;
  data: Record<string, unknown>;
  objectId?: string;
  source?: ObjectSource;
} {
  const objectId = boundId(presentation);
  if (objectId) {
    const object = findObject(objects, objectId);
    if (object)
      return {
        title: object.title,
        ...(object.body === undefined ? {} : { body: object.body }),
        data: object.data ?? {},
        objectId: object.id,
        ...(object.source === undefined ? {} : { source: object.source }),
      };
    return {
      title: presentation.title,
      data: presentation.data ?? {},
      objectId,
    };
  }
  return { title: presentation.title, data: presentation.data ?? {} };
}

export function resolveContent(
  presentation: Presentation,
  objects: WorkspaceObject[],
): {
  title: string;
  body?: string;
  data: Record<string, unknown>;
  objectId?: string;
  source?: ObjectSource;
} {
  const objectId = boundId(presentation);
  if (objectId) {
    const object = findObject(objects, objectId);
    if (object)
      return {
        title: object.title,
        ...(object.body === undefined ? {} : { body: object.body }),
        data: deepCopy(object.data ?? {}),
        objectId: object.id,
        ...(object.source === undefined
          ? {}
          : { source: deepCopy(object.source) }),
      };
    return {
      title: presentation.title,
      data: deepCopy(presentation.data ?? {}),
      objectId,
    };
  }
  return { title: presentation.title, data: deepCopy(presentation.data ?? {}) };
}

/**
 * 同一对象的全部展示实例（同一对象可以出现在多块白板上）。
 * 筛选依据是展示实例的绑定关系（统一 binding 或代码投影旧字段 objectId）：
 * 对象已被删除时仍会返回这些悬空展示，便于上层识别引用失效；
 * objects 保留在签名里是为了与 resolveContent 对称。
 *
 * 返回的是原展示实例引用：布局不受版本保护，移动/改布局走白板的写路径。
 */
export function presentationsFor(
  objects: WorkspaceObject[],
  presentations: Presentation[],
  objectId: string,
): Presentation[] {
  return presentations.filter((p) => bindsTo(p, objectId));
}

/**
 * 白板嵌套无环检查（I4）：把 child 放进 parent 是否会形成环。
 * - 自嵌套（parentId === childId）：false
 * - child 是 parent 的祖先：false
 * - 兄弟节点或互不相关：true
 */
export function canNest(
  spaces: { id: string; parentId?: string }[],
  parentId: string,
  childId: string,
): boolean {
  if (parentId === childId) return false;
  const parents = new Map<string, string | undefined>();
  for (const space of spaces) parents.set(space.id, space.parentId);
  const seen = new Set<string>();
  let cursor: string | undefined = parentId;
  while (cursor) {
    if (cursor === childId) return false;
    if (seen.has(cursor)) break;
    seen.add(cursor);
    cursor = parents.get(cursor);
  }
  return true;
}
