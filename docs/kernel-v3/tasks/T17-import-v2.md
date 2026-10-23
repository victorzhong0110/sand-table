# T17 v2 工作空间导入器

| 项 | 内容 |
|---|---|
| 执行 | grok |
| 依赖 | T12、T13 |
| 分支 | `task/T17-import-v2` |

## 目标

打开工作空间时，如果只有 v2 的 `workspace.json`，就把它一次性导入成 `workspace.db`。用户现有的作品一个不丢地出现在 v3 里。

## 先读

- `AGENTS.md`
- `docs/kernel-v3/01-data-model.md` §1（v2→v3 对照）、§2、§10（全部映射规则）
- `docs/kernel-v3/03-types-and-extensions.md` §6.1（v1 组件包转换）
- v2 文件格式（只读）：`workbench/core/objects.ts` 的 `WorkspaceSnapshot`、`PersistedBoard`、`Presentation`；`workbench/core/workspace.ts` 的读取与迁移链（v0→v1→v2）

## 可改文件

- 新建 `workbench/kernel/legacy/import-v2.ts`、`workbench/kernel/legacy/v2-migrate.ts`、`workbench/kernel/workspace.ts`
- `workbench/tests/architecture.test.ts`（若 T16 已合并：只确认 `kernel/legacy/` 已被规则 4、5 排除，不做其他修改）
- `workbench/kernel/index.ts`
- 新建 `workbench/tests/kernel-import.test.ts`
- 新建 `workbench/tests/fixtures/v2/*.json`

## 不要做

- 不修改、不重命名、不删除 `workspace.json`。
- 不导入 v2 的撤销历史。
- 不在仓库里提交任何真实用户的工作空间文件。
- 不 import `workbench/core/` 的任何代码。T24 会删除 v2 目录，导入器必须独立存活。

## 做法

### 1. `kernel/workspace.ts`：打开工作空间的统一入口

```ts
export function openWorkspace(root: string, workspaceId: string, registry: Registry, options?: { title?: string; now?: () => number }): {
  db: Db;
  imported: null | { from: string; objects: number; presentations: number; relations: number; skipped: { what: string; reason: string }[] };
};
```

1. `workspace.db` 存在 → `openWorkspaceDb(..., { create: false })` → `syncPacks`。
2. 不存在但 `workspace.json` 存在 → 导入（§2）→ `syncPacks`。
3. 都不存在 → `openWorkspaceDb(..., { create: true })` → `syncPacks`。

### 2. `kernel/legacy/import-v2.ts`

导入器必然要写 v2 的旧名字（`placements`、`spaceLinks`）和旧类型名（`character` 等），所以它放在 `kernel/legacy/` 子目录里，T16 的规则 4、5 不检查这个目录。规则 1（内核只依赖自己）仍然适用。

```ts
export function importV2(jsonFile: string, dbFile: string, registry: Registry, now: () => number): ImportReport;
```

- `kernel/legacy/v2-migrate.ts`：把 `core/workspace.ts` 里“把 v0、v1 文件升到 v2 形状”的迁移逻辑**复制**过来（这是不会再变的旧代码，只保留读取需要的部分，类型用本文件内的局部类型，不 import `core/`）。
- 先读 JSON 并用上面的迁移逻辑升到 v2 形状；读失败就抛错，**不创建** `workspace.db`。
- 新建数据库（`openWorkspaceDb(..., { create: true, workspaceId, title })`，id 和标题取自 v2 文件），然后在**一个事务**里按 `01-data-model.md` §10 的表格逐行写入。保留原 id、`createdAt`、`updatedAt`、作者。
- 导入时把首页白板换成 v2 的根空间：新建库自带的首页白板对象删除（硬删除，这是全新库），把 `meta.home_board_id` 指向 v2 根空间对应的白板对象。
- 每一项无法映射的数据（例如展示指向的对象不存在）跳过，记进报告的 `skipped`，不让整个导入失败。
- 写 `meta.imported_from`；写一条审计 `action = 'import'`，`detail` 是报告摘要。
- 事务失败：关闭连接，删除 `workspace.db`、`-wal`、`-shm`，抛出原错误。
- 附件：`assets[].dataUrl` 解码后写入 `blobs/<sha256>`，同时写 `blobs` 表。

## 验收

`workbench/tests/kernel-import.test.ts`。在 `tests/fixtures/v2/` 下手写小型 v2 文件，至少覆盖：

1. 原生对象、绑定展示、本地内容展示、嵌套空间（`board` / `space-link` 展示）、空间链接（5 种 kind 各一条）、对象关系、分组、备注、附件、意图 / 提案 / 验证、导览、主题、组件包（v1）、审计。每种映射都断言导入后的结果（类型名、id 保留、关系方向、`parent_id`、blob 文件存在等）。
2. 无损迁移：真实 0、空字符串、空数组和未知字段均保留。重复同名、唯一同名及未知名单只报告/建议，不凭名字创建已确认关系；原始稳定 ID 关系保留。
3. 未知类型 `foo` → `legacy.foo`，数据原样保留。
4. 展示指向不存在的对象 → 被跳过并出现在报告里，其余正常导入。
5. 损坏的 JSON → 抛错，目录里没有 `workspace.db`，`workspace.json` 字节不变。
6. 导入成功后再次 `openWorkspace`：不再导入，直接打开。
7. 导入后可以正常 `applyCommands` 修改导入的对象、撤销、重做。

手工核对（写进 PR 描述，不提交数据）：若本机 `~/.sand-table/workspaces/` 下有真实工作空间，**复制**一份到临时目录后导入，报告对象、展示、关系数量和 `skipped` 条目。

命令：`npm run format:check`、`npm run typecheck`、`npm test` 全部通过。
