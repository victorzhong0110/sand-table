// 撤销/重做的**分支时间线**与审计日志。
// 契约见 docs/architecture/history-timeline.zh-CN.md（v2 时间线模型）
// 与 docs/architecture/workspace-kernel.zh-CN.md 第 6 节（I10、I11、I12）。
// 共享类型来自 ./objects.ts（本文件只读引用，不修改它）。
//
// 三个概念必须分开：
//   1. 撤销单位 = 用户意图。一次拖动、一次连续输入、一批同意图的 Agent 修改算一个单位。
//      一个单位可以覆盖多个实体，因此合并按实体做并集：每个实体的 before 取最早值、
//      after 取最新值；涉及多个实体时补丁升级为 target: "batch"。
//   2. 时间线 = 作品生命过程的记录。它是一**棵树**，不是两个栈：
//      每条记录带 parentId（它发生在哪条之上），游标 cursorId 指向板面当前停在哪条之后。
//      新编辑从游标分叉，旧分支原样保留，所以任意一条记录都还能跳回去。
//      v1 的双栈模型做不到这一点：record() 会清空重做栈，被撤销的那段历史从此不可达。
//   3. 审计日志：只追加。撤销本身也进审计，但审计与时间线游标互不影响。
//
// 外部效果（已发布的 PR、已运行的实验、已发送的内容）不进入白板撤销栈（I12）：
// 它们的回滚属于补偿操作。record() 会拒绝这类条目，并把它们留在 refused 列表里。
//
// 本模块不含存储与 UI：调用方负责把 patch 应用到对象，并把撤销/重做追加进审计日志。
// 树结构与路径计算在 core/timeline.ts（本文件只调它，不重复实现）。

import {
  chainUp,
  descendantsOf,
  indexTimeline,
  latestChild,
  pathBetween,
  pruneTimeline,
  sortBySeq,
} from "./timeline.ts";
import type { TimelineIndex } from "./timeline.ts";
import type {
  AuditEntry,
  HistoryEntry,
  HistoryState as LegacyHistoryState,
  Patch,
  TimelineEntry,
  TimelineState,
} from "./objects.ts";

/**
 * 撤销单位内的一条实体快照。
 * board 目标用于板级内容键（嵌套白板、分组、主题、组件包…），
 * 见 docs/architecture/integration-2026-10.zh-CN.md 决策 D2。
 */
export type UnitSnapshot = {
  target: "object" | "presentation" | "relation" | "board";
  id: string;
  value: unknown;
};

/** 构造 History 的可选参数。 */
export type HistoryOptions = {
  /**
   * 严格模式：动作种类未声明的条目不进撤销栈。
   * 对应 core/objects.ts 中 HistoryEntry.kind 的注释（缺失时按未知处理，宁可漏撤销）。
   * 默认关闭；core/store.ts 的接线已逐个动作声明 kind 并开启了严格模式。
   */
  requireKind?: boolean;
  /** 拒绝条目的时间戳来源，默认 Date.now。 */
  now?: () => number;
  /**
   * 保留上限（条），默认 500。
   * 只从叶子开始裁，绝不裁掉游标所在路径上的记录；详见 core/timeline.ts 的 pruneTimeline。
   */
  limit?: number;
};

/** 被拒绝进入撤销栈的条目。外部效果不得进白板撤销栈（契约 I12）。 */
export type HistoryRefusal = {
  entry: HistoryEntry;
  reason: string;
  at: number;
};

/**
 * 面板与接口用的历史记录：不含补丁负载，只给人和 UI 看。
 *
 * v1 双栈模型里还有 kind: "edit" | "undo" | "redo"（靠它区分撤销栈与重做栈）。
 * 时间线模型没有这个概念：每条记录都是一次编辑，位置关系由 parentId 表达，
 * 所以 kind 退成可选的旧字段，面板改看 TimelineRecord。
 */
export type HistoryRecord = {
  id: string;
  label: string;
  at: number;
  author: string;
  authorKind: "human" | "agent";
  intentId: string;
  /** @deprecated v1 双栈模型用来区分撤销栈/重做栈；时间线模型不再使用。 */
  kind?: "edit" | "undo" | "redo";
};

/**
 * 时间线上的一条记录：在通用形状之外补上「它在树的哪里」。
 *
 * - current：板面正停在这条上。
 * - onPath：在游标的祖先路径上，也就是「可撤销的那条线」。
 * - ahead：在游标之后，还能前滚回去。
 * - branch：既不在路径上也不在游标之后——被分叉取代、但**仍然可达**的旧分支。
 */
export type TimelineRecord = HistoryRecord & {
  /** 父记录：这条是在哪条之上发生的。 */
  parentId?: string;
  /** 同一棵时间线上的序号（创建顺序）。 */
  seq: number;
  current: boolean;
  onPath: boolean;
  ahead: boolean;
  branch: boolean;
};

/** 面板与 MCP 工具 `sand_history` 的返回形状。 */
export type HistorySnapshot = {
  boardId: string;
  /** 全部记录，按 seq 升序：包含被分叉取代但仍可达的旧分支。 */
  records: TimelineRecord[];
  /** 当前游标：板面正停在哪条记录之后。 */
  cursorId?: string;
  canUndo: boolean;
  canRedo: boolean;
  /** 这套历史能做什么、不能做什么。UI 直接展示，不要另写一份说明。 */
  note: string;
};

const patchTargets: Patch["target"][] = [
  "object",
  "presentation",
  "relation",
  "batch",
];

/** batch 补丁里允许出现的实体目标（与 objects.ts 的 EntitySnapshot 一致）。 */
const snapshotTargets: UnitSnapshot["target"][] = [
  "object",
  "presentation",
  "relation",
  "board",
];

/** 记录与拒绝列表的容量上限，避免长时间运行后无限增长。 */
const refusalLimit = 50;

/** 时间线的默认保留上限。 */
const defaultLimit = 500;

const entityKey = (target: string, id: string): string => `${target}:${id}`;

/** 撤销单位内的一个实体：变更前后的值。 */
type UnitEntity = {
  target: UnitSnapshot["target"];
  id: string;
  before: unknown;
  after: unknown;
};

/** 一个撤销单位覆盖的实体集合。 */
type Unit = {
  entities: UnitEntity[];
  /** 输入补丁是否是 batch。batch 形态的输出才能被 core/store.ts 的 applyPatch 应用。 */
  batch: boolean;
};

/** 校验一条历史条目。形状不对立刻报错，不让坏数据进撤销栈。 */
const assertEntry = (entry: HistoryEntry): void => {
  if (!entry || typeof entry !== "object")
    throw new TypeError("历史条目必须是对象。");
  if (typeof entry.id !== "string" || !entry.id)
    throw new TypeError("历史条目必须有非空 id。");
  if (typeof entry.intentId !== "string" || !entry.intentId)
    throw new TypeError("历史条目必须有非空 intentId（撤销按意图分组）。");
  if (typeof entry.label !== "string")
    throw new TypeError("历史条目的 label 必须是字符串。");
  if (typeof entry.at !== "number" || !Number.isFinite(entry.at))
    throw new TypeError("历史条目的 at 必须是有限数字。");
  if (typeof entry.author !== "string" || !entry.author)
    throw new TypeError("历史条目必须有非空 author。");
  if (
    entry.kind !== undefined &&
    (typeof entry.kind !== "string" || !entry.kind)
  )
    throw new TypeError("历史条目的 kind 必须是非空字符串。");
  const patch = entry.patch;
  if (!patch || typeof patch !== "object")
    throw new TypeError("历史条目必须有 patch（目标 + 变更前后的值）。");
  if (!patchTargets.includes(patch.target))
    throw new TypeError(
      `patch.target 必须是 ${patchTargets.join(" / ")} 之一。`,
    );
  if (typeof patch.id !== "string" || !patch.id)
    throw new TypeError("patch.id 必须是非空字符串。");
  if (patch.target === "batch") {
    assertSnapshots(patch.before, "before");
    assertSnapshots(patch.after, "after");
  }
};

const assertSnapshots = (raw: unknown, side: string): void => {
  if (!Array.isArray(raw))
    throw new TypeError(`batch 补丁的 ${side} 必须是实体快照数组。`);
  for (const snap of raw) {
    if (!snap || typeof snap !== "object")
      throw new TypeError(`batch 补丁的 ${side} 里只能放实体快照对象。`);
    const s = snap as Partial<UnitSnapshot>;
    if (!snapshotTargets.includes(s.target as UnitSnapshot["target"]))
      throw new TypeError(
        `batch 补丁的 ${side} 里的 target 必须是 ${snapshotTargets.join(" / ")} 之一。`,
      );
    if (typeof s.id !== "string" || !s.id)
      throw new TypeError(`batch 补丁的 ${side} 里的快照必须有非空 id。`);
  }
};

const readSnapshots = (raw: unknown): UnitSnapshot[] => {
  if (!Array.isArray(raw)) return [];
  const out: UnitSnapshot[] = [];
  for (const snap of raw) {
    const s = snap as Partial<UnitSnapshot>;
    out.push({
      target: s.target as UnitSnapshot["target"],
      id: String(s.id ?? ""),
      value: "value" in s ? s.value : null,
    });
  }
  return out;
};

/**
 * 把一个补丁拆成实体集合。
 * batch 补丁的 before/after 是快照数组；单目标补丁的 before/after 是该目标的值。
 * 只在一侧出现的实体，另一侧按 null（不存在）处理。
 */
const unitFromPatch = (patch: Patch): Unit => {
  if (patch.target === "batch") {
    const entities: UnitEntity[] = [];
    const index = new Map<string, UnitEntity>();
    for (const snap of readSnapshots(patch.before)) {
      const key = entityKey(snap.target, snap.id);
      if (index.has(key)) continue;
      const entity: UnitEntity = {
        target: snap.target,
        id: snap.id,
        before: snap.value,
        after: null,
      };
      index.set(key, entity);
      entities.push(entity);
    }
    for (const snap of readSnapshots(patch.after)) {
      const key = entityKey(snap.target, snap.id);
      const existing = index.get(key);
      if (existing) {
        existing.after = snap.value;
        continue;
      }
      const entity: UnitEntity = {
        target: snap.target,
        id: snap.id,
        before: null,
        after: snap.value,
      };
      index.set(key, entity);
      entities.push(entity);
    }
    return { entities, batch: true };
  }
  return {
    entities: [
      {
        target: patch.target,
        id: patch.id,
        before: patch.before,
        after: patch.after,
      },
    ],
    batch: false,
  };
};

/**
 * 合并两个撤销单位：按实体取并集。
 * 每个实体的 before 取最早值（撤销一次即回到该意图的最初状态），
 * after 取最新值（重做能回到该意图的最终结果）。
 */
const mergeUnits = (first: Unit, latest: Unit): Unit => {
  const entities = first.entities.map((entity) => ({ ...entity }));
  const index = new Map(
    entities.map((entity) => [entityKey(entity.target, entity.id), entity]),
  );
  for (const entity of latest.entities) {
    const key = entityKey(entity.target, entity.id);
    const existing = index.get(key);
    if (existing) {
      existing.after = entity.after;
      continue;
    }
    const added = { ...entity };
    entities.push(added);
    index.set(key, added);
  }
  return { entities, batch: first.batch || latest.batch };
};

/**
 * 把撤销单位还原成补丁。
 * 一律用 batch 形状：core/store.ts 的 applyPatch 只认快照数组，
 * 单目标形状会被静默忽略——那会造成「撤销报成功、实际什么都没回退」。
 */
const unitToPatch = (unit: Unit, intentId: string): Patch => {
  const id = unit.entities.length === 1 ? unit.entities[0].id : intentId;
  return {
    target: "batch",
    id,
    before: unit.entities.map((entity) => ({
      target: entity.target,
      id: entity.id,
      value: entity.before,
    })),
    after: unit.entities.map((entity) => ({
      target: entity.target,
      id: entity.id,
      value: entity.after,
    })),
  };
};

/** 同一意图内是否可以合并。 */
const canMerge = (top: HistoryEntry, entry: HistoryEntry): boolean =>
  top.intentId === entry.intentId;

/** 深拷贝一个值。无法结构化克隆时退回原引用。 */
const copyValue = (value: unknown): unknown => {
  if (value === null || typeof value !== "object") return value;
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
};

/** 复制一条历史条目：结构与快照值都复制，外部改动不影响撤销栈。 */
const copyEntry = (entry: HistoryEntry): HistoryEntry => {
  const patch = entry.patch;
  const copied: HistoryEntry = {
    id: entry.id,
    intentId: entry.intentId,
    label: entry.label,
    at: entry.at,
    author: entry.author,
    patch: {
      target: patch.target,
      id: patch.id,
      before: copyValue(patch.before),
      after: copyValue(patch.after),
    },
  };
  if (entry.kind !== undefined) copied.kind = entry.kind;
  // authorKind 决定面板上这条是人做的还是 Agent 做的：复制时不能丢。
  if (entry.authorKind !== undefined) copied.authorKind = entry.authorKind;
  return copied;
};

/** 只复制结构、快照值按引用共享：用于高频读取的 state 快照。 */
const copyEntryStructure = (entry: HistoryEntry): HistoryEntry => {
  const patch = entry.patch;
  const copied: HistoryEntry = {
    id: entry.id,
    intentId: entry.intentId,
    label: entry.label,
    at: entry.at,
    author: entry.author,
    patch: {
      target: patch.target,
      id: patch.id,
      before: Array.isArray(patch.before)
        ? patch.before.map((snap) => ({ ...(snap as object) }))
        : patch.before,
      after: Array.isArray(patch.after)
        ? patch.after.map((snap) => ({ ...(snap as object) }))
        : patch.after,
    },
  };
  if (entry.kind !== undefined) copied.kind = entry.kind;
  if (entry.authorKind !== undefined) copied.authorKind = entry.authorKind;
  return copied;
};

/** 复制一条时间线条目：结构与快照值都复制。 */
const copyTimelineEntry = (entry: TimelineEntry): TimelineEntry => {
  const copied: TimelineEntry = {
    ...copyEntry(entry),
    seq: entry.seq,
  };
  if (entry.parentId !== undefined) copied.parentId = entry.parentId;
  return copied;
};

/** 只复制结构、快照值按引用共享：用于 state 快照。 */
const copyTimelineEntryStructure = (entry: TimelineEntry): TimelineEntry => {
  const copied: TimelineEntry = {
    ...copyEntryStructure(entry),
    seq: entry.seq,
  };
  if (entry.parentId !== undefined) copied.parentId = entry.parentId;
  return copied;
};

/** 判断一份状态是不是 v2 时间线。 */
const isTimelineState = (
  state: TimelineState | LegacyHistoryState,
): state is TimelineState =>
  (state as TimelineState).version === 2 &&
  Array.isArray((state as TimelineState).entries);

/** 一批记录里的最大序号 + 1：下一条记录该用的 seq。 */
const nextSeqOf = (entries: TimelineEntry[]): number =>
  entries.reduce((max, entry) => Math.max(max, entry.seq), -1) + 1;

/**
 * 把 v1 双栈状态迁移成 v2 时间线。
 *
 * 迁移**不得丢记录**（契约第 6 节）：
 *   - undo 栈按顺序串成一条链（后一条的 parentId 指向前一条），游标落在最后一条——
 *     这正是 v1 撤销栈的语义：栈里的记录就是当前生效的那些。
 *   - redo 栈里的记录也保留：v1 的重做栈顶是「下一个要重做的记录」，
 *     所以从栈顶往回串成一条链，挂在游标之下——重做顺序与 v1 一致。
 *
 * 供 core/workspace.ts 的迁移链使用（负责人维护那条链）。
 */
export function migrateHistoryState(state: LegacyHistoryState): TimelineState {
  if (!state || typeof state !== "object")
    throw new TypeError("历史状态必须是对象。");
  const undo = Array.isArray(state.undo) ? state.undo : [];
  const redo = Array.isArray(state.redo) ? state.redo : [];
  const entries: TimelineEntry[] = [];
  let seq = 0;
  let parentId: string | undefined;
  for (const raw of undo) {
    const entry: TimelineEntry = {
      ...copyEntry(raw),
      seq: seq++,
    };
    if (parentId !== undefined) entry.parentId = parentId;
    entries.push(entry);
    parentId = entry.id;
  }
  const cursorId = parentId;
  // 重做栈：数组末尾是下一个要重做的记录（v1 的 redo() 从末尾弹）。
  let branchParent = cursorId;
  for (let i = redo.length - 1; i >= 0; i--) {
    const entry: TimelineEntry = {
      ...copyEntry(redo[i]),
      seq: seq++,
    };
    if (branchParent !== undefined) entry.parentId = branchParent;
    entries.push(entry);
    branchParent = entry.id;
  }
  return {
    version: 2,
    entries,
    ...(cursorId === undefined ? {} : { cursorId }),
  };
}

/**
 * 读回一份 v2 状态。
 *
 * 落盘的文件可能来自旧版本或被手工改过：这里只做**排序键**的归一化
 * （补齐缺失的 seq、丢掉没有 id 的记录），其余字段原样保留——
 * 归一化器最常见的失败是静默丢字段，所以这里不碰补丁负载。
 */
const restoreTimelineState = (state: TimelineState): TimelineState => {
  const entries: TimelineEntry[] = [];
  const seen = new Set<string>();
  for (const raw of state.entries) {
    if (!raw || typeof raw.id !== "string" || !raw.id) continue;
    if (seen.has(raw.id)) continue;
    seen.add(raw.id);
    const entry: TimelineEntry = {
      ...copyTimelineEntry(raw),
      seq: Number.isFinite(raw.seq) ? raw.seq : entries.length,
    };
    entries.push(entry);
  }
  const cursorId =
    state.cursorId && seen.has(state.cursorId) ? state.cursorId : undefined;
  return {
    version: 2,
    entries,
    ...(cursorId === undefined ? {} : { cursorId }),
  };
};

/**
 * 游标路径上的记录（从根到游标，旧的在前）——v1「撤销栈」的等价物。
 *
 * 过渡期接线用：core/store.ts 的 history() 应当改用 records()（完整的时间线视图）；
 * 旧断言 `state.undo` 可以换成这个函数。
 */
export function undoPath(state: TimelineState): TimelineEntry[] {
  const index = indexTimeline(state.entries);
  return chainUp(index, state.cursorId).reverse();
}

/**
 * 游标之后的记录（还能前滚回去的那些）——v1「重做栈」的等价物。
 *
 * 过渡期接线用：旧断言 `state.redo` 可以换成这个函数。
 * 注意与 v1 的差别：v1 的重做栈只装「被撤销的那几条」，
 * 这里给的是游标之后的整棵子树（分叉后可能有几条）。
 */
export function redoPath(state: TimelineState): TimelineEntry[] {
  const index = indexTimeline(state.entries);
  return descendantsOf(index, state.cursorId);
}

/**
 * 分支时间线。
 *
 * 状态机（游标 cursor，entries 是全部记录）：
 *   record(e)   → 从游标分叉出一条新记录（parentId = 游标），游标移到它；
 *                 若与游标处的记录满足合并条件（同 intentId、连续、且上一次动作不是
 *                 undo/redo/jump），则**合并进游标那条**而不是新增。
 *                 旧分支原样保留——这是与 v1 最大的不同：v1 会清空重做栈。
 *   undo()      → 游标移到当前记录的父节点，返回被撤销的条目；没有父节点时返回 undefined。
 *   redo()      → 游标移到游标的某个子节点（有多个时取最近创建的），返回被重做的条目。
 *   jumpTo(id)  → 游标移动到任意记录：先沿父链回退到最近公共祖先，再沿子链前滚到目标。
 *
 * 连续 Cmd+Z 不会震荡：undo 之后游标往回走，再 undo 一定取到更早的条目；
 * redo 之后游标往前走，再 undo 能再次撤销它。
 */
export class History {
  /** 全部记录（含被分叉取代但仍可达的旧分支），按创建顺序追加。 */
  private entries: TimelineEntry[];
  /** 游标：板面当前停在哪条记录之后。缺省表示还没开始。 */
  private cursorId?: string;
  /** 上一次动作之后是否允许与游标处的记录合并。撤销/重做/跳转都会打断意图分组。 */
  private mergeable: boolean;
  private options: HistoryOptions;
  private now: () => number;
  private refusals: HistoryRefusal[];
  private unclassifiedEntries: HistoryEntry[];
  /** 下一条记录的序号。落盘读回时取已有记录的最大值 + 1。 */
  private nextSeq: number;

  constructor(
    state?: TimelineState | LegacyHistoryState,
    options?: HistoryOptions,
  ) {
    this.options = options ?? {};
    this.now = this.options.now ?? Date.now;
    this.refusals = [];
    this.unclassifiedEntries = [];
    this.mergeable = true;
    this.entries = [];
    this.nextSeq = 0;
    if (state !== undefined) {
      const restored = isTimelineState(state)
        ? restoreTimelineState(state)
        : migrateHistoryState(state);
      this.entries = restored.entries;
      this.cursorId = restored.cursorId;
      this.nextSeq = nextSeqOf(restored.entries);
    }
  }

  /** Isolated transaction history, including refusal and grouping metadata. */
  fork(): History {
    const fork = new History(structuredClone(this.state), this.options);
    fork.refusals = structuredClone(this.refusals);
    fork.unclassifiedEntries = structuredClone(this.unclassifiedEntries);
    fork.mergeable = this.mergeable;
    fork.nextSeq = this.nextSeq;
    return fork;
  }

  /** 当前状态快照（v2）。数组与条目是副本，改动它不会影响内部状态。 */
  get state(): TimelineState {
    return {
      version: 2,
      entries: this.entries.map(copyTimelineEntryStructure),
      ...(this.cursorId === undefined ? {} : { cursorId: this.cursorId }),
    };
  }

  /** 是否还有可撤销的意图：游标停在某条记录上就能再往回退一步。 */
  get canUndo(): boolean {
    return this.cursorId !== undefined;
  }

  /** 是否还有可重做的意图：游标后面还有子节点。 */
  get canRedo(): boolean {
    return Boolean(latestChild(this.index(), this.cursorId));
  }

  /**
   * 被拒绝进入撤销栈的条目（外部效果等）。
   * 调用方应把它们写进审计日志，而不是假装它们可以撤销。
   */
  get refused(): HistoryRefusal[] {
    return [...this.refusals];
  }

  /**
   * 没有声明动作种类（kind）的条目。
   * 严格模式下它们已被拒绝、不会出现在撤销栈里；这里记录的是被拒绝的条目，便于排查。
   */
  get unclassified(): HistoryEntry[] {
    return [...this.unclassifiedEntries];
  }

  /**
   * 全部记录（含被分叉取代但仍可达的旧分支），按 seq 升序。
   * 面板用这个视图渲染单条时间线：每条记录带上「它在树的哪里」。
   */
  records(): TimelineRecord[] {
    const index = this.index();
    const pathIds = new Set(
      chainUp(index, this.cursorId).map((entry) => entry.id),
    );
    const aheadIds = new Set(
      descendantsOf(index, this.cursorId).map((entry) => entry.id),
    );
    return sortBySeq(this.entries).map((entry) => {
      const onPath = pathIds.has(entry.id);
      const ahead = aheadIds.has(entry.id);
      return {
        id: entry.id,
        label: entry.label,
        at: entry.at,
        author: entry.author,
        // 缺这一项时按人处理：读回旧文件不因为少一个字段就崩。
        authorKind: entry.authorKind === "agent" ? "agent" : "human",
        intentId: entry.intentId,
        ...(entry.parentId === undefined ? {} : { parentId: entry.parentId }),
        seq: entry.seq,
        current: entry.id === this.cursorId,
        onPath,
        ahead,
        // 既不在当前路径上、也不在游标之后：被分叉取代的旧分支，仍然可达。
        branch: !onPath && !ahead,
      };
    });
  }

  /**
   * 记录一次变更。
   * 同一 intentId 的连续变更合并为一个撤销单位：按实体取并集，
   * 每个实体的 before 取最早值、after 取最新值。
   * 新记录从游标分叉出去，**旧分支原样保留**（v1 在这里会清空重做栈）。
   * 外部效果（kind 命中 externalEffectKinds）被拒绝，不进时间线（契约 I12）。
   *
   * 返回落库后的那条记录（合并时是合并后的那条）；被拒绝时返回 undefined。
   */
  record(entry: HistoryEntry): TimelineEntry | undefined {
    assertEntry(entry);
    const copy = copyEntry(entry);
    // 统一成 batch 形状：core/store.ts 的 applyPatch 只认快照数组，
    // 单目标形状会被静默忽略——「撤销报成功、实际什么都没回退」。
    copy.patch = unitToPatch(unitFromPatch(copy.patch), copy.intentId);
    const kind = copy.kind;
    if (kind !== undefined && isExternalEffect(kind)) {
      this.refuse(
        copy,
        `外部效果「${kind}」不进入白板撤销栈（契约 I12）；回滚属于补偿操作，请写审计日志。`,
      );
      return undefined;
    }
    if (kind === undefined) {
      this.unclassifiedEntries.push(copy);
      if (this.unclassifiedEntries.length > refusalLimit)
        this.unclassifiedEntries.splice(
          0,
          this.unclassifiedEntries.length - refusalLimit,
        );
      if (this.options.requireKind) {
        this.refuse(
          copy,
          "动作种类未声明，严格模式下不进入白板撤销栈（core/objects.ts 的 HistoryEntry.kind）。",
        );
        return undefined;
      }
    }
    const current = this.cursorId
      ? this.entries.find((e) => e.id === this.cursorId)
      : undefined;
    if (this.mergeable && current && canMerge(current, copy)) {
      const merged = mergeUnits(
        unitFromPatch(current.patch),
        unitFromPatch(copy.patch),
      );
      const next: TimelineEntry = {
        ...current,
        kind: current.kind ?? copy.kind,
        patch: unitToPatch(merged, current.intentId),
      };
      this.replaceEntry(next);
      this.mergeable = true;
      return copyTimelineEntry(next);
    }
    const next: TimelineEntry = {
      ...copy,
      seq: this.nextSeq++,
    };
    if (this.cursorId !== undefined) next.parentId = this.cursorId;
    this.entries.push(next);
    this.cursorId = next.id;
    this.mergeable = true;
    this.prune();
    return copyTimelineEntry(next);
  }

  /** 撤销：游标退到当前记录的父节点。返回被撤销的条目；没有可撤销项时返回 undefined。 */
  undo(): HistoryEntry | undefined {
    const current = this.cursorId
      ? this.entries.find((e) => e.id === this.cursorId)
      : undefined;
    if (!current) return undefined;
    this.cursorId = current.parentId;
    this.mergeable = false;
    return copyEntry(current);
  }

  /**
   * 重做：游标前进到某个子节点。
   * 分叉后同一个父节点下可能有多个子，取**最近创建**的那个——
   * 重做回到你上次走的那条路。
   */
  redo(): HistoryEntry | undefined {
    const child = latestChild(this.index(), this.cursorId);
    if (!child) return undefined;
    this.cursorId = child.id;
    this.mergeable = false;
    return copyEntry(child);
  }

  /**
   * 显式丢弃游标之后的分支。
   *
   * v1 的同名方法会清空重做栈；时间线模型**不会自动**丢弃任何分支，
   * 所以这里是一次明确的破坏性操作：只删游标之后、且不在游标路径上的那些分支。
   * 正常流程不会调用它。
   */
  clearRedo(): void {
    const index = this.index();
    const ahead = new Set(
      descendantsOf(index, this.cursorId).map((entry) => entry.id),
    );
    if (!ahead.size) return;
    this.entries = this.entries.filter((entry) => !ahead.has(entry.id));
    this.mergeable = false;
  }

  /**
   * 跳到某条记录：板面回到「这条记录刚发生时的样子」。
   *
   * 跳转要跨分支，所以是**路径重放**：先沿父链回退到最近公共祖先，再沿子链前滚到目标。
   * undone（新→旧）与 redone（旧→新）的顺序必须与 core/store.ts 的接法一致：
   * 先应用 undone 的 before 快照，再应用 redone 的 after 快照。
   * 顺序错一次，板面就会串。
   *
   * 找不到该记录时返回 undefined——调用方要报错，不静默什么都不做。
   */
  jumpTo(
    entryId: string,
  ): { undone: TimelineEntry[]; redone: TimelineEntry[] } | undefined {
    const index = this.index();
    const path = pathBetween(index, this.cursorId, entryId);
    if (!path) return undefined;
    this.cursorId = entryId;
    this.mergeable = false;
    return { undone: path.undone, redone: path.redone };
  }

  /** 当前树的索引。条数不大（上限 500），按需重建即可。 */
  private index(): TimelineIndex {
    return indexTimeline(this.entries);
  }

  /** 替换一条记录（合并时用）。 */
  private replaceEntry(next: TimelineEntry): void {
    const at = this.entries.findIndex((entry) => entry.id === next.id);
    if (at < 0) return;
    this.entries[at] = next;
  }

  /** 容量裁剪：只从叶子开始，绝不裁掉游标所在路径上的记录。 */
  private prune(): void {
    const limit = this.options.limit ?? defaultLimit;
    const result = pruneTimeline(this.entries, limit, this.cursorId);
    this.entries = result.entries;
    this.cursorId = result.cursorId;
  }

  private refuse(entry: HistoryEntry, reason: string): void {
    this.refusals.push({ entry, reason, at: this.now() });
    if (this.refusals.length > refusalLimit)
      this.refusals.splice(0, this.refusals.length - refusalLimit);
  }
}

/**
 * 追加一条审计记录。审计日志只追加，不删除、不改写（I11）。
 * 原地追加并返回同一个数组：`log = appendAudit(log, e)` 与 `appendAudit(log, e)` 两种用法都成立。
 * 撤销/重做不会写审计日志，调用方自己追加一条 via: "undo" / via: "redo" 的记录。
 */
export function appendAudit(
  log: AuditEntry[],
  entry: AuditEntry,
): AuditEntry[] {
  if (!Array.isArray(log)) throw new TypeError("审计日志必须是数组。");
  if (!entry || typeof entry !== "object")
    throw new TypeError("审计条目必须是对象。");
  log.push(entry);
  return log;
}

/**
 * 已知会产生外部效果的动作类型。
 * 一旦发生，白板撤销就不能冒充回滚（I12）：外部效果的回滚属于补偿操作，不进白板撤销栈。
 */
export const externalEffectKinds: string[] = [
  "publish",
  "publish-pr",
  "create-pr",
  "merge-pr",
  "run-experiment",
  "run-job",
  "execute",
  "send",
  "send-message",
  "post",
  "email",
  "share",
  "notify",
  "webhook",
  "push",
  "deploy",
  "commit-external",
  "write-external",
  "delete-external",
  "upload",
];

/**
 * 已知属于白板内部的动作类型。这些可以进入撤销栈。
 * 新增白板内动作时登记到这里，否则会被当成外部效果而无法撤销。
 */
export const internalEffectKinds: string[] = [
  "edit",
  "update",
  "create",
  "delete",
  "add",
  "remove",
  "change",
  "modify",
  "rename",
  "drag",
  "drop",
  "type",
  "input",
  "paste",
  "cut",
  "duplicate",
  "align",
  "order",
  "position",
  "size",
  "style",
  "theme",
  "layout",
  "color",
  "font",
  "camera",
  "zoom",
  "focus",
  "toggle",
  "attach",
  "detach",
  "batch",
  "bulk",
  "bulk-edit",
  "multi-edit",
  "agent-edit",
  "agent-batch",
  "edit-object",
  "edit-presentation",
  /* 板级内容与资源引用：都是白板内编辑，可撤销。
     未知种类按外部效果处理（宁可漏撤销），所以新加的种类必须在这里登记，
     否则会被静默拒绝——撤销栈看起来是空的。 */
  "edit-board",
  "edit-resource",
  "create-object",
  "delete-object",
  "create-presentation",
  "delete-presentation",
  "duplicate-presentation",
  "move",
  "resize",
  "fold",
  "unfold",
  "reorder",
  "group",
  "ungroup",
  "link",
  "unlink",
  "add-note",
  "update-note",
  "delete-note",
  "create-relation",
  "update-relation",
  "delete-relation",
  "create-board",
  "delete-board",
  "set-view",
  "select",
  "import",
];

/**
 * 判断一次动作是否属于白板撤销范围之外。
 * 明确登记的外部效果（已发布 PR、已运行实验、已发送内容……）→ true。
 * 明确登记的白板内编辑 → false。
 * 未登记的 kind 一律按外部处理：白板撤销宁可漏撤销，也不得冒充外部回滚（I12）。
 */
export function isExternalEffect(kind: string): boolean {
  if (typeof kind !== "string" || !kind) return true;
  if (externalEffectKinds.includes(kind)) return true;
  return !internalEffectKinds.includes(kind);
}
