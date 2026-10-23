# T13 统一写入 `applyCommands` 与历史记录

| 项 | 内容 |
|---|---|
| 执行 | grok |
| 依赖 | T11（T12 不是前提：测试里自己造包） |
| 分支 | `task/T13-apply-commands` |

## 目标

实现 v3 唯一的写入口 `applyCommands(db, registry, batch)`：校验、写入、软删除级联、修订号、历史记录（新建与合并）、审计，全部在一个事务里。

## 先读

- `AGENTS.md`
- `docs/kernel-v3/01-data-model.md` §4、§6、§7.1、§7.2、§7.4、§8、§9
- `docs/kernel-v3/02-commands-and-tools.md` §1（全部）
- `docs/kernel-v3/03-types-and-extensions.md` §2（`TemplateSpec`）、§6（数据包规则）
- `workbench/kernel/` 下 T10、T11 的全部文件

## 可改文件

- 新建 `workbench/kernel/commands.ts`、`workbench/kernel/history-record.ts`、`workbench/kernel/packs-state.ts`、`workbench/kernel/labels.ts`
- `workbench/kernel/index.ts`（加导出）
- `workbench/kernel/types.ts`（声明 SystemCommand/SystemCommandBatch，与02 §1.5一致）
- 新建 `workbench/tests/kernel-commands.test.ts`

## 不要做

- 不实现撤销、重做、跳转、容量裁剪、历史列表（T14）。
- 不实现读接口（T15）。
- 不 import `kernel/` 以外的代码。

## 做法

### 1. `kernel/packs-state.ts`

```ts
// 打开工作空间后调用：把注册表里的内置包同步进 packs 表（不存在就插入：base、novel、research 为 enabled = 1，code 为 0；已存在则保留原 enabled），
// 再把 packs 表里 kind = 'data' 的清单注册进注册表。用 02 §1.5 的 applySystemCommands/pack.sync_builtin 写入。
export function syncPacks(db: Db, registry: Registry, actor: Actor): void;
export function isPackEnabled(db: Db, packId: string): boolean;
```

### 2. `kernel/commands.ts`

`export function applyCommands(db: Db, registry: Registry, batch: CommandBatch): CommandResult`

按 `02-commands-and-tools.md` §1.2 的顺序。要点：

- **引用解析**：仅实体引用槽的字段值是 `"@名字"` 的字符串时，替换成本批次前面 `ref: "名字"` 创建出的 id；找不到就抛 `NOT_FOUND`。`template.apply` 展开时还要把 `"$board"` 换成目标白板 id，并把坐标整体平移到 `x`、`y`。
- **版本**：每次修改一行，`version + 1`；新建时为 1。
- **修订号**：整批共用一个新修订号 R + 1，写进每个改动行的 `rev` 和 `meta.revision`。
- **`presentation.create` 缺省位置**：`x` = 该白板上现有未删除展示的最大 `x + width` 再加 40（没有展示时为 0），`y` = 现有展示的最小 `y`（没有时为 0）。缺省尺寸取类型的 `display.defaultSize`。
- **校验**：逐条实现 §1.3 的表格。包是否启用用 `isPackEnabled`。`object.update` 的“只对本次改动的键报错”规则：Ajv 错误路径的第一段（如 `/age/0` 的 `age`）属于 `set` 或 `unset` 的键时算错误，否则放进 `warnings`。
- **循环检查**：`presentation.create` / `update` 涉及白板对象时，用递归 CTE 查“目标白板是否出现在被放入白板的内部（含间接）”。
- **删除级联**：按 `01-data-model.md` §8。
- **`object.clone`**：新 id，`type` / `title` / `data` / `source` 原样复制，不复制展示和关系。
- **`pack.import`**：清单先按 `03-types-and-extensions.md` §6.1 判断是不是 v1 格式并转换；再 `registry.registerPack(..., "data")`；写入 `packs` 表。事务回滚时要把注册表也恢复（先在临时注册表里校验，提交成功后再注册到真实注册表）。
- **`setting.set` / `pack.*`** 也产生 `Change`，进历史。
- **`record: false`**：不写历史，但照常写修订号和审计。
- **derived 对象**：`source.origin === "derived"` 的对象，以及展示、关系的两端都是 derived 对象的情况，不产生 `Change`（不进历史），见 `01-data-model.md` §7.4。

### 3. `kernel/history-record.ts`

```ts
// 在 applyCommands 的事务内调用。按 01-data-model.md §7.2 新建或合并记录，更新 meta.history_cursor。
export function recordHistory(db: Db, batch: CommandBatch, changes: Change[], label: string, kind: string, now: number): string | null;
```

快照（`Snapshot`）的字段：该行除 `rev`、`deleted_rev` 以外的全部列（用 `types.ts` 里的驼峰字段名），外加 `alive: boolean`。`bytes` 是 `JSON.stringify(changes)` 的 UTF-8 字节数。

`kind` 取值：批次里只有创建 → `create`；只有删除 → `delete`；只有展示位置或尺寸变化 → `move`；只有 `pack.*` → `pack`；只有 `setting.set` → `setting`；其他 → `edit`。

### 4. `kernel/labels.ts`

按 `02-commands-and-tools.md` §1.4 生成标签。标题从命令或数据库里取当前标题。

### 5. 审计

每次成功提交写一条：`action = 'apply'`，`history_id` 为本次历史 id（可能为空），`detail = { commands: 命令数, revision }`。

## 验收

`workbench/tests/kernel-commands.test.ts`。测试里用一个自造的测试包（含一个 container 类型、一个普通类型带数字和文字字段、一个要求依据的关系类型），不要依赖 T12。

1. 每种 `op` 至少一个成功用例，并读库核对结果。
2. 引用：同一批次里创建对象再用 `"@ref"` 放到白板上并建关系，成功；引用不存在的 ref 抛 `NOT_FOUND`。
3. 原子性：第 3 条命令失败时，前 2 条的写入不存在，修订号不变，没有新历史和审计。
4. §1.3 表格里每个错误码至少一个用例，且 `commandIndex` 正确。
5. `object.update` 旧数据遗留问题：先用直接 SQL 塞一条不合 Schema 的数据（模拟导入），再改另一个字段，成功且 `warnings` 非空；改那个不合法的字段本身则失败。
6. 删除对象后，它的展示和关系都被软删除；修订号加 1；三者在同一条历史的 `changes` 里。
7. 循环：A 白板里放 B，再把 A 放进 B，抛 `CYCLE`。
8. 合并：同一 `intentId`、同一 actor、连续两次修改同一对象 → 只有一条历史，`before` 是最早的，`after` 是最新的；换 actor、换 intentId、或中间被别的记录隔开 → 各自一条。两次修改后内容回到原样 → 该记录被删除，游标回到父记录。
9. `record: false` 不产生历史；derived 对象的创建不产生历史。
10. 自动标签：新建、移动 3 个、修改、删除各一个用例。
11. `pack.import` 一个 v1 格式清单，被转换后成功写入；导入一个不合格清单，抛错且注册表里没有残留。

命令：`npm run format:check`、`npm run typecheck`、`npm test` 全部通过。


## T07 补充验收
实现 02 §1.5 内部命令并复用统一事务。公共解析器拒绝内部 op；内置包首次初始化成功、重新打开保留启停；固定 derived ID 可更新但不得覆盖人工对象；正文 @alice 不被替换。allowsInferred=false 在创建/更新时都拦截。设置/包移除及撤销创建生成墓碑。注册表只在事务成功后切换，回滚不残留。

内部upsert的packId、derivedIdPrefix和旧ID定位校验按03派生身份策略；不要猜测未声明的namespace API。
