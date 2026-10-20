// 撤销/重做栈与审计日志的纯逻辑实现。
// 契约见 docs/architecture/workspace-kernel.zh-CN.md 第 6 节（I10、I11、I12）。
// 共享类型来自 ./objects.ts（本文件只读引用，不修改它）。
//
// 三个概念必须分开：
//   1. 撤销单位 = 用户意图。一次拖动、一次连续输入、一批同意图的 Agent 修改算一个单位。
//   2. 撤销栈 / 重做栈：可回退的状态。Undo 弹撤销栈压重做栈，Redo 反之。
//   3. 审计日志：只追加。撤销本身也进审计，但审计与撤销栈游标互不影响。
//
// 本模块不含存储与 UI：调用方负责把 patch 应用到对象，并把 undo/redo 追加进审计日志。

import type {
  AuditEntry,
  HistoryEntry,
  HistoryState as SharedHistoryState,
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
 * 合并同一意图的连续变更。
 * 保留最早的 before（撤销一次即回到该意图的最初状态），覆盖最新的 after（意图的最终结果）。
 * 其余字段沿用最早那条：id 标识「这个撤销单位由哪次编辑创建」，at 是意图开始的时间。
 * patch.target / patch.id 也沿用最早那条：before 属于该目标，撤销就是把它写回去。
 */
const mergeEntries = (
  first: HistoryEntry,
  latest: HistoryEntry,
): HistoryEntry => ({
  ...first,
  patch: { ...first.patch, after: latest.patch.after },
});

/** 记录前的形状检查：接线出错时立刻报错，而不是把坏数据写进撤销栈。 */
const assertEntry = (entry: HistoryEntry): void => {
  if (!entry || typeof entry !== "object")
    throw new TypeError("历史条目必须是对象。");
  if (typeof entry.intentId !== "string" || !entry.intentId)
    throw new TypeError("历史条目必须有非空 intentId（撤销按意图分组）。");
  if (!entry.patch || typeof entry.patch !== "object")
    throw new TypeError("历史条目必须有 patch（目标 + 变更前后的值）。");
};

/**
 * 撤销/重做栈。
 *
 * 状态机（undo 栈顶 U、redo 栈顶 R）：
 *   record(e)   → e 合并进 U（仅当 e.intentId === U.intentId 且上一次动作不是 undo/redo），
 *                 否则作为新单位压入 U；R 清空。
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

  constructor(state?: HistoryState) {
    if (state !== undefined) {
      if (!Array.isArray(state.undo) || !Array.isArray(state.redo))
        throw new TypeError("历史状态必须包含 undo 与 redo 两个数组。");
    }
    this.undoStack = state ? [...state.undo] : [];
    this.redoStack = state ? [...state.redo] : [];
    this.mergeable = true;
  }

  /** 当前状态快照。数组是副本，条目本身按引用共享。 */
  get state(): HistoryState {
    return { undo: [...this.undoStack], redo: [...this.redoStack] };
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
   * 记录一次变更。
   * 同一 intentId 的连续变更合并为一个撤销单位：保留最早的 before，覆盖最新的 after。
   * 新记录会清空重做栈（撤销过之后产生新编辑，重做不再有意义）。
   * 条目按引用保存（undo 返回的就是同一个对象），调用方不应在 record 之后改写它。
   */
  record(entry: HistoryEntry): void {
    assertEntry(entry);
    this.redoStack = [];
    const top = this.undoStack[this.undoStack.length - 1];
    if (this.mergeable && top && top.intentId === entry.intentId) {
      this.undoStack[this.undoStack.length - 1] = mergeEntries(top, entry);
    } else {
      this.undoStack.push(entry);
    }
    this.mergeable = true;
  }

  /** 撤销：弹撤销栈并压入重做栈。返回被撤销的条目；没有可撤销项时返回 undefined。 */
  undo(): HistoryEntry | undefined {
    const entry = this.undoStack.pop();
    if (!entry) return undefined;
    this.redoStack.push(entry);
    this.mergeable = false;
    return entry;
  }

  /** 重做：弹重做栈并压回撤销栈。返回被重做的条目；没有可重做项时返回 undefined。 */
  redo(): HistoryEntry | undefined {
    const entry = this.redoStack.pop();
    if (!entry) return undefined;
    this.undoStack.push(entry);
    this.mergeable = false;
    return entry;
  }

  /** 丢弃重做栈（新的编辑会调用）。 */
  clearRedo(): void {
    this.redoStack = [];
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
  if (!Array.isArray(log))
    throw new TypeError("审计日志必须是数组。");
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
  "rename",
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
