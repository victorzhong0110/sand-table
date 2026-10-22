# T14 撤销、重做、跳转与容量裁剪

| 项 | 内容 |
|---|---|
| 执行 | grok |
| 依赖 | T13 |
| 分支 | `task/T14-history-ops` |
| 关联 issue | #26（产品语义：连续撤销一直往回走，回退后新编辑产生分支，旧路径保留可找回） |

## 目标

在 v3 内核里实现撤销、重做、跳转到任意记录、历史列表，以及历史和审计的容量裁剪。

## 先读

- `AGENTS.md`
- `docs/kernel-v3/01-data-model.md` §7（全部）
- `docs/kernel-v3/02-commands-and-tools.md` §2（`historyList`）、§3.2 `sand_history` 的输出
- `workbench/kernel/` 下现有全部文件，特别是 `history-record.ts`

## 可改文件

- 新建 `workbench/kernel/history.ts`
- `workbench/kernel/history-record.ts`（加入裁剪调用）
- `workbench/kernel/index.ts`
- 新建 `workbench/tests/kernel-history.test.ts`

## 不要做

- 不改 v2 的 `core/history.ts`。
- 撤销、重做、跳转不新建历史记录（只写数据、修订号和审计）。

## 做法

```ts
export function undo(db: Db, actor: Actor): { revision: number; cursorId: string | null };
export function redo(db: Db, actor: Actor): { revision: number; cursorId: string | null };
export function jump(db: Db, actor: Actor, entryId: string): { revision: number; cursorId: string | null };
export function historyList(db: Db, limit: number): {
  cursorId: string | null;
  entries: { id: string; parentId: string | null; seq: number; label: string; actorKind: "human" | "agent"; at: number; current: boolean; onCurrentPath: boolean }[];
};
export function pruneHistory(db: Db): void; // 01 §7.5，记录和审计都裁
```

- 每个函数自己开事务（用 `transaction`）。
- 应用快照、冲突检查按 `01-data-model.md` §7.3。冲突时抛 `CommandError("HISTORY_CONFLICT", ..., null, { ids })`。
- 没有可撤销的（游标为空）或没有可重做的：返回当前状态，不报错，不改修订号，不写审计。
- `jump`：一路撤销到公共祖先再一路重做到目标，全部在**一个**事务里；任何一步冲突，整体回滚。
- 每次实际改动：修订号加 1，受影响行的 `version + 1`、`rev` 写新修订号；审计 `action` 为 `undo` / `redo` / `jump`，`history_id` 为涉及的记录。
- `historyList` 按 `seq` 升序返回最近 `limit` 条。`onCurrentPath` 为真表示：它是游标或游标的祖先，或者从游标沿“`seq` 最大的子记录”一路往下能到达它（可重做）。
- `recordHistory` 写完新记录后调用 `pruneHistory`。

## 验收

`workbench/tests/kernel-history.test.ts`（测试包自造，同 T13 的做法）：

1. 连续 30 次修改同一对象（每次不同 `intentId`），连续撤销 30 次回到初始内容，再连续重做 30 次回到最终内容。撤销过程中每一步内容都与对应历史的 `before` 一致，不会在两步之间来回跳。
2. 撤销 2 步后做一次新修改：新记录的父记录是撤销后的游标；原来那 2 条仍在 `historyList` 里，`onCurrentPath` 为假；`jump` 到原来的最后一条，内容恢复成分叉前的最终内容。
3. 撤销一次 `object.delete`：对象、它的全部展示和关系都恢复；再重做，又全部删除。
4. 冲突：用 `applyCommands(..., record: false)` 改动游标记录涉及的实体，再撤销，抛 `HISTORY_CONFLICT`，数据库没有任何变化。
5. 撤销、重做、跳转不增加历史记录数，但各写一条审计。
6. 容量：插入 2,050 条记录（可以直接调 `applyCommands` 循环），记录数不超过 2,000，游标记录还在，最早的记录被删除；审计超过 20,000 条时被裁剪到 20,000 条（造审计数据时可以在一个事务里直接用 SQL 批量插入，不必循环调用 `applyCommands`）。
7. 游标为空时撤销、没有子记录时重做：不报错，修订号不变。

命令：`npm run format:check`、`npm run typecheck`、`npm test` 全部通过。
