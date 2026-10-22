# T15 读接口

| 项 | 内容 |
|---|---|
| 执行 | grok |
| 依赖 | T14 |
| 分支 | `task/T15-read-api` |

## 目标

实现 `kernel/read.ts`：工具层和界面需要的全部查询。返回结构直接对应 `02-commands-and-tools.md` §3 里各工具的输出，工具层只做薄包装。

## 先读

- `AGENTS.md`
- `docs/kernel-v3/02-commands-and-tools.md` §2、§3.2（每个工具的输出结构）、§3.4（`app_board`、`app_changes`）
- `docs/kernel-v3/01-data-model.md` §6（修订号与墓碑）
- `docs/kernel-v3/03-types-and-extensions.md` §2（`display.summary`）
- `workbench/kernel/` 下现有全部文件

## 可改文件

- 新建 `workbench/kernel/read.ts`、`workbench/kernel/text.ts`
- `workbench/kernel/index.ts`
- 新建 `workbench/tests/kernel-read.test.ts`

## 不要做

- 除 `context` 更新 `agent_reads`、`setActivity` 写 `activities` 外，读接口不写库。
- 不注册 MCP 工具（T20）。

## 做法

```ts
export function status(db: Db, registry: Registry): StatusResult;              // sand_status 的输出（host 字段由工具层补）
export function listTypes(db: Db, registry: Registry, filter?: { types?: string[]; pack?: string }): TypesResult;
export function query(db: Db, registry: Registry, filter: QueryFilter): { rows: QueryRow[]; nextCursor: string | null; total: number };
export function readObjects(db: Db, registry: Registry, ids: string[], options: ReadOptions): ReadResult;
export function boardContents(db: Db, boardId: string): { revision: number; board: ObjectRow; presentations: PresentationRow[]; objects: ObjectRow[]; relations: RelationRow[] };
export function changesSince(db: Db, rev: number): ChangesResult | { reset: true; revision: number };
export function context(db: Db, actor: Actor, viewId?: string): ContextResult;
export function setActivity(db: Db, actor: Actor, input: ActivityInput, now: number): void;
export function setView(db: Db, input: { viewId: string; boardId?: string; camera?: unknown; selection?: string[]; navStack?: unknown[] }, now: number): void;
```

结果类型（`StatusResult` 等）按 `02` §3.2 的 JSON 结构定义在 `read.ts` 里并导出。

要点：

- **只返回未删除的行**，`changesSince` 例外（它要返回墓碑，墓碑行带 `deleted: true`）。
- **`typeAvailable`**：类型不在注册表里，或所属包在 `packs` 表里 `enabled = 0` 时为假。
- **`query`**：
  - `boardId`：对象在这块白板上有未删除的展示。
  - `text`：`title` 或 `data` 文本 `LIKE '%…%'`（不区分大小写；对 `%`、`_` 转义）。
  - `relatedTo`：按方向在 `relations` 里找另一端。
  - `cursor` 是把偏移量编码后的字符串（`Buffer.from(String(offset)).toString("base64url")`），解码失败按 0 处理。
  - `summary`：`kernel/text.ts` 里实现 `summarize(spec, data, title)`：取 `display.summary` 中第一个有值的字段；字符串去掉 Markdown 标记（标题井号、强调符号、链接语法、代码围栏）后截取 160 字；数字和列表转成文字。
- **`readObjects`**：文字字段按 `textLimit` 截断并在 `truncated` 里报告原长度；`textOffset` 只对指定对象的指定字段生效。每个对象最多 50 条关系，`otherTitle` 一并查出。
- **`changesSince`**：`rev < tombstone_floor` 时返回 `{ reset: true }`；否则返回 `objects`、`presentations`、`relations`、`settings`、`packs` 里 `rev > since` 的全部行。
- **`context`**：`viewId` 缺省时取 `views` 里 `updated_at` 最大的一条；`recentHumanEdits` 取 `seq` 大于 `agent_reads.history_seq` 且 `actor_kind = 'human'` 的历史，最多 20 条，`objectIds` 从记录的 `changes` 里取 `objects` 表的 id（去重，最多 10 个）；读完把 `agent_reads` 更新为当前最大 `seq`。`otherAgents` 取 `activities` 里未过期且不是本 actor 的。
- **`setActivity`**：按 `02` §3.2 `sand_activity` 的过期规则写 `expires_at`；校验 `objectIds` 都存在，不存在的丢弃并不报错。

## 验收

`workbench/tests/kernel-read.test.ts`：

1. `status`：新库返回首页白板、包列表、修订号 0。
2. `query`：按白板、类型、文字（含中文、含 `%` 字符）、关系各一个用例；分页两页拼起来等于全集且不重复；已删除对象查不到。
3. `readObjects`：长文字被截断且 `truncated` 正确；`textOffset` 读到后续内容；不存在的 id 出现在 `missing`。
4. `boardContents`：只含这块白板上的展示、它们指向的对象、两端都在这块白板上的关系。
5. `changesSince`：做 3 批修改（含一次删除）后，从中间的修订号取增量，恰好包含之后改过的行和墓碑；把 `tombstone_floor` 设大后返回 `reset`。
6. `context`：人改了 2 次、Agent 改了 1 次后，Agent 第一次调用拿到 2 条人工修改，第二次调用拿到 0 条。
7. 停用某个包后，它类型的对象 `typeAvailable` 为假，但仍能查到和读到。

命令：`npm run format:check`、`npm run typecheck`、`npm test` 全部通过。
