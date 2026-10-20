// 撤销/重做栈与审计日志的纯逻辑实现。
// 契约见 docs/architecture/workspace-kernel.zh-CN.md 第 6 节（I10、I11、I12）。
// 共享类型来自 ./objects.ts（本文件只读引用，不修改它）。
//
// 三个概念必须分开：
//   1. 撤销单位 = 用户意图。一次拖动、一次连续输入、一批同意图的 Agent 修改算一个单位。
//      一个单位可以覆盖多个实体，因此合并按实体做并集：每个实体的 before 取最早值、
//      after 取最新值；涉及多个实体时补丁升级为 target: "batch"。
//   2. 撤销栈 / 重做栈：可回退的状态。Undo 弹撤销栈压重做栈，Redo 反之。
//   3. 审计日志：只追加。撤销本身也进审计，但审计与撤销栈游标互不影响。
//
// 外部效果（已发布的 PR、已运行的实验、已发送的内容）不进入白板撤销栈（I12）：
// 它们的回滚属于补偿操作。record() 会拒绝这类条目，并把它们留在 refused 列表里。
//
// 本模块不含存储与 UI：调用方负责把 patch 应用到对象，并把 undo/redo 追加进审计日志。

import type {
  AuditEntry,
  HistoryEntry,
  HistoryState as SharedHistoryState,
  Patch,
} from "./objects.ts";

/** 撤销栈与重做栈的完整状态。持久化层按此结构保存（workspace.json 的 history 字段）。 */
export type HistoryState = {
  /** 撤销栈，栈顶是最近一次可撤销的意图。 */
  undo: HistoryEntry[];
  /** 重做栈，栈顶是最近一次被撤销的意图。 */
  redo: HistoryEntry[];
};

/**
 * 本文件的 HistoryState 与 core/objects.ts 的共享 HistoryState 必须结构一致，
 * 否则负责人接线时 board.history 与 history.state 互相赋值会编译失败。
 * 下面是纯类型守卫：两边不再互相可赋值时直接报类型错，不产生任何运行时代码。
 */
type AssertTrue<T extends true> = T;
type HistoryStateMatchesShared = AssertTrue<
  HistoryState extends SharedHistoryState
    ? SharedHistoryState extends HistoryState
      ? true
      : false
    : false
>;

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
};

/** 被拒绝进入撤销栈的条目。外部效果不得进白板撤销栈（契约 I12）。 */
export type HistoryRefusal = {
  entry: HistoryEntry;
  reason: string;
  at: number;
};

/**
 * 面板与接口用的历史记录：不含补丁负载，只给人和 UI 看。
 * kind 区分「这是一次编辑」还是「这是一次撤销/重做」——
 * 撤销本身也进审计日志，但它不占用撤销栈的位置。
 */
export type HistoryRecord = {
  id: string;
  label: string;
  at: number;
  author: string;
  authorKind: "human" | "agent";
  kind: "edit" | "undo" | "redo";
  intentId: string;
};

/** 面板与 MCP 工具 `sand_history` 的返回形状。 */
export type HistorySnapshot = {
  boardId: string;
  /** 新到旧。撤销栈在前，重做栈（已撤销、待重做）在后。 */
  records: HistoryRecord[];
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

/**
 * 撤销/重做栈。
 *
 * 状态机（undo 栈顶 U、redo 栈顶 R）：
 *   record(e)   → e 与栈顶合并（同一 intentId、连续、且上一次动作不是 undo/redo），
 *                 否则作为新单位压入 U；R 清空。外部效果被拒绝，不进任何栈。
 *   undo()      → 弹出 U 压入 R，返回被撤销的条目；U 为空时返回 undefined。
 *   redo()      → 弹出 R 压回 U，返回被重做的条目；R 为空时返回 undefined。
 *   clearRedo() → R 清空。
 *
 * 连续 Cmd+Z 不会震荡：undo 之后该条目只在 redo 栈里，再 undo 一定取到更早的条目；
 * redo 之后它回到 undo 栈，再 undo 能再次撤销它。
 */
export class History {
  private undoStack: HistoryEntry[];
  private redoStack: HistoryEntry[];
  /** 上一次动作之后是否允许与栈顶合并。撤销/重做会打断意图分组。 */
  private mergeable: boolean;
  private options: HistoryOptions;
  private now: () => number;
  private refusals: HistoryRefusal[];
  private unclassifiedEntries: HistoryEntry[];

  constructor(state?: HistoryState, options?: HistoryOptions) {
    if (state !== undefined) {
      if (!Array.isArray(state.undo) || !Array.isArray(state.redo))
        throw new TypeError("历史状态必须包含 undo 与 redo 两个数组。");
    }
    this.undoStack = state ? [...state.undo] : [];
    this.redoStack = state ? [...state.redo] : [];
    this.mergeable = true;
    this.options = options ?? {};
    this.now = this.options.now ?? Date.now;
    this.refusals = [];
    this.unclassifiedEntries = [];
  }

  /** 当前状态快照。数组与条目是副本，改动它不会影响内部栈。 */
  get state(): HistoryState {
    return {
      undo: this.undoStack.map(copyEntryStructure),
      redo: this.redoStack.map(copyEntryStructure),
    };
  }

  /** 是否还有可撤销的意图。 */
  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  /** 是否还有可重做的意图。 */
  get canRedo(): boolean {
    return this.redoStack.length > 0;
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
   * 记录一次变更。
   * 同一 intentId 的连续变更合并为一个撤销单位：按实体取并集，
   * 每个实体的 before 取最早值、after 取最新值。
   * 新记录会清空重做栈（撤销过之后产生新编辑，重做不再有意义）。
   * 外部效果（kind 命中 externalEffectKinds）被拒绝，不进撤销栈（契约 I12）。
   */
  record(entry: HistoryEntry): void {
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
      return;
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
        return;
      }
    }
    this.redoStack = [];
    const top = this.undoStack[this.undoStack.length - 1];
    if (this.mergeable && top && canMerge(top, copy)) {
      const merged = mergeUnits(
        unitFromPatch(top.patch),
        unitFromPatch(copy.patch),
      );
      this.undoStack[this.undoStack.length - 1] = {
        ...top,
        kind: top.kind ?? copy.kind,
        patch: unitToPatch(merged, top.intentId),
      };
    } else {
      this.undoStack.push(copy);
    }
    this.mergeable = true;
  }

  /** 撤销：弹撤销栈并压入重做栈。返回被撤销的条目；没有可撤销项时返回 undefined。 */
  undo(): HistoryEntry | undefined {
    const entry = this.undoStack.pop();
    if (!entry) return undefined;
    this.redoStack.push(entry);
    this.mergeable = false;
    return copyEntry(entry);
  }

  /** 重做：弹重做栈并压回撤销栈。返回被重做的条目；没有可重做项时返回 undefined。 */
  redo(): HistoryEntry | undefined {
    const entry = this.redoStack.pop();
    if (!entry) return undefined;
    this.undoStack.push(entry);
    this.mergeable = false;
    return copyEntry(entry);
  }

  /** 丢弃重做栈（新的编辑会调用）。 */
  clearRedo(): void {
    this.redoStack = [];
  }

  /**
   * 跳到某条记录：板面回到「这条记录刚发生时的样子」。
   *
   * 双栈是有序的：撤销栈栈顶最新，重做栈栈顶最旧（重做时按时间正序弹出）。
   * 跳转会同时动两个栈，因此插入位置必须按时间序算，不能随手 push——
   * 否则重做时会把新的改动先应用出去，板面状态会串。
   */
  jumpTo(entryId: string):
    | {
        undone: HistoryEntry[];
        redone: HistoryEntry[];
      }
    | undefined {
    const at = this.undoStack.findIndex((e) => e.id === entryId);
    if (at >= 0) {
      const undone: HistoryEntry[] = [];
      const moved: HistoryEntry[] = [];
      // 撤销栈栈顶是最新的：先撤掉它上面（更新）的，撤到目标为止，
      // 但**不撤目标本身**——目标是「回到它刚发生的状态」。
      while (this.undoStack.length - 1 > at) {
        const entry = this.undoStack.pop();
        if (!entry) break;
        moved.push(entry);
        undone.push(copyEntry(entry));
      }
      // 被撤掉的这些比重做栈里现有的都新，要放到重做栈**栈底**（栈底最新）。
      // moved 是新→旧，unshift 的参数要旧→新，最后一个参数落在最底。
      if (moved.length) this.redoStack.unshift(...moved.reverse());
      this.mergeable = false;
      return { undone, redone: [] };
    }
    const redoAt = this.redoStack.findIndex((e) => e.id === entryId);
    if (redoAt >= 0) {
      const redone: HistoryEntry[] = [];
      /* 目标已经被撤销过：把它重做回来。
         注意**不要**先把撤销栈全部撤掉——那会把这条记录之前的内容也一起撤掉，
         「跳到这条记录刚发生时的样子」就变成了「回到起点」。
         重做栈栈顶是最旧的，依次弹出直到目标为止（含目标）。 */
      while (this.redoStack.length) {
        const entry = this.redoStack.pop();
        if (!entry) break;
        this.undoStack.push(entry);
        redone.push(copyEntry(entry));
        if (entry.id === entryId) break;
      }
      this.mergeable = false;
      return { undone: [], redone };
    }
    return undefined;
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
