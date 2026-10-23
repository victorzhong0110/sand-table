# T26 类型版本迁移运行时

| 项 | 内容 |
|---|---|
| 执行 | minimax |
| 依赖 | T15 |
| 分支 | `task/T26-type-migrations` |

## 目标

内置包升级某个类型的数据结构时（`TypeSpec.version` 加 1 并提供 `migrations`），旧对象读出来就是新结构，下次写入时落盘成新结构。迁移失败不丢数据。Phase 4 的表格、图表、事件类型都要用到。

## 先读

- `AGENTS.md`
- `docs/kernel-v3/05-delivery-contracts.md`（本阶段公共契约与交接规则）
- `docs/kernel-v3/03-types-and-extensions.md` §2（`version`、`migrations`）、§6（数据包不能带迁移，升级必须兼容旧数据）
- `workbench/kernel/` 全部文件（重点 `commands.ts`、`read.ts`、`registry.ts`）

## 开工前核对

确认 `TypeSpec.migrations` 的类型在 `main` 上仍是 `{ from: number; migrate(data) }[]`，`applyCommands` 和 `readObjects` 存在。依赖未完成则等待；机械差异按 05 §1 适配，语义冲突只暂停受影响部分。

## 可改文件

- 新建 `workbench/kernel/migrate.ts`
- `workbench/kernel/commands.ts`、`workbench/kernel/read.ts`、`workbench/kernel/index.ts`
- 新建 `workbench/tests/kernel-migrate.test.ts`

## 不要做

- 不在打开工作空间时批量改写全部对象（只在读时转换、写时落盘）。
- 不为数据包加迁移能力。

## 做法

```ts
export function migrateData(
  registry: Registry,
  row: ObjectRow,
): { data: Record<string, unknown>; typeVersion: number; error?: string };
```

1. 类型不存在、或 `row.typeVersion >= spec.version`：原样返回。
2. 否则从 `row.typeVersion` 开始，依次找 `from` 等于当前版本的迁移函数执行，直到等于 `spec.version`。缺某一步、函数抛错、或结果不是对象：返回原数据、原版本，并带 `error`（中文，说明卡在哪一步）。
3. 迁移函数拿到的是数据的深拷贝，改坏了也不影响原数据。
4. **读**：`readObjects`、`boardContents`、`changesSince`、`query` 的摘要，都用迁移后的数据，并返回迁移后的 `typeVersion`。迁移失败的对象加 `migrationError` 字段，`typeAvailable` 照常，界面按只读显示并展示原因。
5. **写**：`applyCommands` 的 `object.update` 先迁移再合并 `set` / `unset`，写入新数据和新 `type_version`。迁移失败时拒绝修改数据（可以改标题），错误码 `INVALID_DATA`，信息里带迁移失败原因。历史快照里 `before` 记的是迁移前的原样，撤销时完整恢复旧版本数据。

## 验收

`workbench/tests/kernel-migrate.test.ts`（测试包自造，一个类型 v1→v2→v3 两步迁移）：

1. v1 对象读出来是 v3 结构，数据库里仍是 v1。
2. 修改它的一个字段后，数据库里是 v3 结构且 `type_version = 3`；撤销后数据库回到 v1 原样。
3. 缺 v2→v3 的迁移：读出原数据并带 `migrationError`；修改数据被拒绝；改标题成功。
4. 迁移函数抛错、或返回非对象：同上处理，原数据不变。
5. 迁移函数修改了入参对象：数据库里的原数据不受影响。

命令：`npm run format:check`、`npm run typecheck`、`npm test`。

## 交接与边界验收

增加未来版本不降级、迁移后 Schema 不合法、仅改标题、撤销/重做后读迁移、跨进程增量读等回归；工具契约按 05 §3 同步。
