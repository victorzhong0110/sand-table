# T21 界面数据层切到 v3

| 项 | 内容 |
|---|---|
| 执行 | minimax |
| 依赖 | T20、T74 |
| 分支 | `task/T21-ui-switch` |
| 说明 | 改动大，可以拆成两个 PR：先读路径（显示），再写路径（编辑）。两个 PR 都引用本卡 |

## 目标

`SAND_KERNEL=v3` 时，现有界面（外观和交互不变）改用 v3 的工具读写：首次用 `app_board` 加载，之后每秒用 `app_changes` 增量同步；所有写入走 `app_edit` / `app_history` / `app_view`。

## 先读

- `AGENTS.md`
- `docs/kernel-v3/05-delivery-contracts.md`（本阶段公共契约与交接规则）
- `docs/kernel-v3/02-commands-and-tools.md` §3.4、§4（旧工具对照）
- `docs/kernel-v3/01-data-model.md` §1（对照表）、§6（增量同步）、§10.1（类型改名表）
- `workbench/board/main.tsx`（`call`、`action`、轮询 `setInterval`、`absorb`）
- `workbench/board/SpaceCanvas.tsx`、`ComponentPanel.tsx`、`ComponentRenderer.tsx`、`Toolbox.tsx`、`HistoryPanel.tsx`、`WorkspacePanel.tsx` 里所有调用工具的地方

## 可改文件

- 新建 `workbench/board/v3/store.ts`（界面侧数据缓存与增量合并）、`workbench/board/v3/adapter.ts`（v3 行 → 现有组件需要的形状）
- `workbench/board/main.tsx`、`SpaceCanvas.tsx`、`ComponentPanel.tsx`、`ComponentRenderer.tsx`、`Toolbox.tsx`、`HistoryPanel.tsx`、`WorkspacePanel.tsx`（只改数据来源和写入调用）
- `workbench/tests/blank.ts`（让它在 v2 和 v3 下都能跑）
- `.github/workflows/workbench.yml`（加一步 `SAND_KERNEL=v3 npm run test:blank`）

## 不要做

- 不改界面的外观和交互（那是 Phase 3）。
- 不在界面里实现业务规则（校验、级联删除、历史合并都在内核）。
- 不删除 v2 路径；不设环境变量时一切照旧。

## 做法

1. **判断版本**：优先由 bootstrap 明确提供 kernelVersion；否则尝试 sand_status，仅明确的未知工具/方法不存在错误才回退 v2 既有 sand_workspace_status/启动路径。鉴权、断线、内部错误应正常报错，不能误判 v2。覆盖两条启动路径。
2. **`board/v3/store.ts`**：保存 `revision` 和按 id 索引的对象、展示、关系、设置。`load(boardId)` 调 `app_board`；`sync()` 调 `app_changes { since: revision }`，合并行、删除墓碑；收到 `reset` 清空缓存并重新 `load`（含 settings/packs），拒绝低于当前 revision 的过期响应。每秒 `sync` 一次（页面不可见时暂停）；自己写入成功后立即 `sync` 一次。
3. **`board/v3/adapter.ts`**：把 v3 数据转成现有组件期待的结构，让现有组件少改。关键映射：
   - v3 对象类型 → 现有渲染分支：按 `01` §10.1 反查（`base.note` → `text`，并把 `body` 映射为 `text`，等等）；`novel.*`、`research.*` 走现有领域兜底分支；未知类型走现有“未知组件”占位。
   - 展示 → 现有“实例”结构：`spaceId` 用 `boardId`，`data` 用对象的数据，`binding = { kind: "object", objectId }`。
   - 白板对象 → 现有“空间”列表；放在白板上的白板对象展示 → 现有 `board` 类型实例。
   - 关系 → 现有连线（v3 关系类型 → 现有 5 种连线：`base.related` → `related` 等，其余类型显示为 `related`）。
4. **写入**：把现有的 `sand_edit_space` 各种 `operation` 翻译成 `app_edit` 命令（对照 `02` §4 的 `sand_edit_space` 一行）：`create` → `object.create` + `presentation.create`；`update` → `object.update`（带 `expectedVersion`）；`place` → `presentation.update`；`remove` → `presentation.delete`；`link` → `relation.create`；`theme` → `setting.set`；`select` / `camera` / `navigate` → `app_view`。撤销重做跳转 → `app_history`。翻译函数集中写在 `adapter.ts`，组件里只调用它。
5. **`intentId`**：沿用现有 `board/edit-session.ts` 的意图分组，原样传给 `app_edit`。

## 验收

- `npm run test:blank` 在不设环境变量和 `SAND_KERNEL=v3` 两种情况下都通过（测试只能通过界面操作和断言界面结果，必要时把读服务端数据的辅助函数改成同时支持两种工具面）。
- 新增断言（只在 v3 下跑）：界面上新建便签、改正文、拖动、删除、撤销、重做后，用 `sand_query` / `sand_read` 读到的结果与界面一致。
- 打开浏览器 DevTools 网络面板（或在测试里计数），空闲时每秒只有一次很小的 `app_changes` 请求，不再每 5 秒拉整块白板。在 PR 描述里写明观察结果。
- `npm run format:check`、`npm run typecheck`、`npm test`、`SAND_KERNEL=v3 npm test` 全部通过。

## 交接与边界验收

版本冲突保留草稿；工作空间切换使用 workspaceId+加载代号隔离旧响应，不能把旧板增量合入新库。store 同时维护 packs，未知类型不丢内容。提供 app_activity 读取供 T37，界面不借 sand_context 改 Agent 读取游标。
