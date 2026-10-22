# T10 数据库层与全部共享类型

| 项 | 内容 |
|---|---|
| 执行 | grok |
| 依赖 | 无 |
| 分支 | `task/T10-kernel-db` |

## 目标

在新目录 `workbench/kernel/` 里建好 v3 的地基：全部共享类型、建表语句、打开数据库与迁移、事务工具、行映射。后面的卡都在这上面做。

## 先读

- `AGENTS.md`
- `docs/kernel-v3/00-decisions.md`
- `docs/kernel-v3/01-data-model.md`（全文，本卡实现 §2–§5）
- `docs/kernel-v3/02-commands-and-tools.md` §1.1（只抄类型，不实现）
- `docs/kernel-v3/03-types-and-extensions.md` §2、§4（只抄类型，不实现）

## 可改文件

- 新建 `workbench/kernel/types.ts`、`schema.ts`、`db.ts`、`rows.ts`、`ids.ts`、`index.ts`
- 新建 `workbench/tests/kernel-db.test.ts`
- `workbench/package.json`（只改 `scripts`）

## 不要做

- 不 import `workbench/core/`、`server/`、`board/`、`domains/` 里的任何东西。`kernel/` 只能 import `node:*` 和 `kernel/` 自己的文件。
- 不实现注册表、写入、历史、读接口（T11–T15 的事）。
- 不引入任何 npm 依赖。

## 做法

### 1. `kernel/types.ts`

把下列类型**原样**写进来并导出（字段名、可选性、联合类型都按文档，不要改）：

- `01-data-model.md` §5：`Actor`、`ExternalLocator`、`ObjectSource`、`ObjectRow`、`Appearance`、`PresentationRow`、`RelationRow`。
- `01-data-model.md` §7.1：`Snapshot`、`Change`。
- `02-commands-and-tools.md` §1.1：`CommandBatch`、`Command`、`CommandResult`；另外导出 `ErrorCode`（§1.3 的错误码字符串联合）。`CommandError` 类放在 `kernel/errors.ts` 里，也在本卡新建（构造参数：`code, message, commandIndex = null, details?`）。
- `03-types-and-extensions.md` §2、§4：`TypeSpec`、`RelationKindSpec`、`TemplateSpec`、`PackSpec`、`RelationSlot`；另外定义 `PresetSpec = { key: string; type: string; title: string; data?: Record<string, unknown>; width?: number; height?: number }`、`JsonSchema = Record<string, unknown>`、`ToolRegistrar = unknown`（T20 会替换成具体类型）。

（`kernel/errors.ts` 也算在“可改文件”里。）

### 2. `kernel/schema.ts`

```ts
export const SCHEMA_VERSION = 1;
// MIGRATIONS[i] 把库从版本 i 升到 i + 1；MIGRATIONS[0] 是 01-data-model.md §4 的完整建表语句
export const MIGRATIONS: string[] = [ /* ... */ ];
```

建表语句逐字照抄 `01-data-model.md` §4（不含 `--` 注释也可以）。

### 3. `kernel/db.ts`

```ts
import { DatabaseSync } from "node:sqlite";
export type Db = DatabaseSync;

export class WorkspaceOpenError extends Error {
  code: "MISSING" | "NOT_SQLITE" | "TOO_NEW" | "MIGRATION_FAILED";
}

export function openWorkspaceDb(
  file: string,
  options: { create: boolean; workspaceId?: string; title?: string; now?: () => number },
): Db;

export function transaction<T>(db: Db, fn: () => T): T;
export function getMeta(db: Db, key: string): string | undefined;
export function setMeta(db: Db, key: string, value: string): void;
```

`openWorkspaceDb` 的行为：

1. 文件不存在：`create` 为假 → 抛 `MISSING`；为真 → 必须给 `workspaceId`（否则抛普通 `Error`），新建库：执行 PRAGMA（§3）→ 在一个事务里执行 `MIGRATIONS[0]`，写入 `meta`（`schema_version`、`workspace_id`、`title`（缺省“未命名工作空间”）、`created_at`、`revision = '0'`、`history_cursor = ''`、`tombstone_floor = '0'`），插入首页白板对象行（`type = 'base.board'`、`title = '首页'`、`data = '{}'`、`created_by = updated_by = 'system'`、`rev = 0`），写 `meta.home_board_id`。
2. 文件存在：先读前 16 个字节，不等于 `"SQLite format 3\0"` → 抛 `NOT_SQLITE`，**不得修改该文件**。然后打开、执行 PRAGMA、读 `schema_version`：大于 `SCHEMA_VERSION` → 抛 `TOO_NEW`；小于 → 在一个事务里依次执行缺的迁移并更新 `schema_version`，任何一步失败就回滚并抛 `MIGRATION_FAILED`（`cause` 带原错误）。
3. 时间一律用 `options.now ?? Date.now`，便于测试。

`transaction`：`BEGIN IMMEDIATE` → 执行 `fn` → `COMMIT`；`fn` 抛错时 `ROLLBACK` 后原样抛出。在事务里再次调用 `transaction` 直接抛错（不支持嵌套）。

### 4. `kernel/rows.ts`

数据库行（蛇形命名、JSON 文本、0/1）与 `types.ts` 里的行类型互相转换：

```ts
export function toObjectRow(r: Record<string, unknown>): ObjectRow;
export function toPresentationRow(r: Record<string, unknown>): PresentationRow;
export function toRelationRow(r: Record<string, unknown>): RelationRow;
```

`deleted` 由 `deleted_rev !== null` 得出。JSON 列解析失败时抛 `CommandError("INTERNAL", ...)`，信息里带表名和 id。

### 5. `kernel/ids.ts`

`export const newId = () => crypto.randomUUID();`（用 `node:crypto`）

### 6. `kernel/index.ts`

导出 `types.ts` 的全部类型、`errors.ts`、`db.ts` 的公开函数、`rows.ts`、`ids.ts`。以后其他目录只能从 `kernel/index.ts` import。

### 7. `workbench/package.json`

- 所有以 `node ` 开头的脚本，在 `node` 后面加 `--disable-warning=ExperimentalWarning`。
- `format:check` 的路径列表 `{board,core,...}` 里加上 `kernel` 和 `packs`，让新目录也受格式检查。

## 验收

`workbench/tests/kernel-db.test.ts`（用 `node:test`，每个用例在 `mkdtempSync(join(tmpdir(), ...))` 建的临时目录里跑，结束后删除）：

1. 新建库后：`meta` 里有 §3 列出的全部键，`schema_version = '1'`，首页白板对象存在且 `type = 'base.board'`。
2. 关闭后重新打开：首页白板 id 不变，`revision` 不变。
3. 打开一个内容是 `"hello"` 的文件：抛 `WorkspaceOpenError` 且 `code = 'NOT_SQLITE'`，文件内容仍是 `"hello"`。
4. 把 `schema_version` 改成 `'99'` 后打开：抛 `TOO_NEW`。
5. `create: false` 打开不存在的文件：抛 `MISSING`，且没有创建文件。
6. 外键生效：插入一条 `object_id` 不存在的展示，抛错。
7. `CHECK` 生效：插入 `data = 'not json'` 的对象，抛错。
8. `transaction` 里抛错后，事务内的插入不存在；嵌套调用 `transaction` 抛错。
9. 两个连接打开同一个文件：一个提交写入后，另一个能读到。
10. `toObjectRow` / `toPresentationRow` / `toRelationRow`：JSON 列解析、布尔转换、`deleted` 推导正确。

命令：在 `workbench/` 下 `npm run format:check`、`npm run typecheck`、`npm test` 全部通过，输出里没有 `ExperimentalWarning`。
