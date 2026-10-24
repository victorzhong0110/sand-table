# T25 工作空间导出与导入

| 项 | 内容 |
|---|---|
| 执行 | minimax |
| 依赖 | T20、T17、T21 |
| 分支 | `task/T25-export-import` |
| 关联 issue | #11 |

## 目标

v3 能把整个工作空间导出成一个文件，再导入成新的工作空间，附件一起带走。v2 已经有导出功能，切到 v3 之前必须补上，否则是功能倒退（T24 依赖本卡）。

## 先读

- `AGENTS.md`
- `docs/kernel-v3/05-delivery-contracts.md`（本阶段公共契约与交接规则）
- `docs/kernel-v3/01-data-model.md` §2、§4、§10
- `docs/kernel-v3/02-commands-and-tools.md` §3.4（`app_workspace`）
- `workbench/kernel/` 全部文件（重点 `workspace.ts`、`legacy/import-v2.ts`）
- `workbench/server/v3/workspaces.ts`（T20 产物）
- v2 的导出做法（只读）：`workbench/core/workspace.ts` 里的导出包、`workbench/board/main.tsx` 的 `exportWorkspace`

## 开工前核对

确认 `main` 上已有：`openWorkspace`、`importV2`、`app_workspace` 的 `list` / `create` / `switch`。缺任何一项，先停下来在 PR 里写“需要架构确认”。

## 可改文件

- 新建 `workbench/kernel/bundle.ts`（隔离报告使用工作空间目录独立 JSON 文件，不新增内容表）
- `workbench/kernel/index.ts`
- `workbench/server/v3/workspaces.ts`、`workbench/server/v3/app-tools.ts`
- `workbench/board/WorkspacePanel.tsx`、`workbench/board/main.tsx`（只改导出、导入入口）
- 新建 `workbench/tests/kernel-bundle.test.ts`

## 不要做

- 不导出撤销历史和审计（导出的是作品现状）。
- 导入**永远不覆盖**已有工作空间。
- 不引入压缩库。

## 做法

1. **导出格式**（一个 JSON 文件）：

   ```json
   {
     "format": "sand-table-workspace",
     "formatVersion": 3,
     "exportedAt": 1761100000000,
     "workspace": { "id": "…", "title": "…", "homeBoardId": "…" },
     "objects": [], "presentations": [], "relations": [], "settings": [],
     "packs": [ { "id": "reading-kit", "kind": "data", "version": 1, "enabled": true, "manifest": {} } ],
     "blobs": [ { "sha256": "…", "mime": "image/png", "bytes": 1234, "base64": "…" } ],
     "external": [ { "kind": "git", "uri": "…" } ]
   }
   ```

   - 只导出未删除的行；内置包只导出 `id`、`enabled`，不导出清单。
   - `external` 列出所有对象 `source.external` 和关系 `evidence` 里出现过的外部定位（去重），导入时提示“这些外部资源没有随包带走”。
   - 附件总大小超过 200 MB 时拒绝导出，并在错误里列出最大的 5 个附件。

2. **导入**：
   - 识别格式：`format = "sand-table-workspace"` 走 v3 导入；顶层有 `schemaVersion` 和 `boards` 的按 v2 工作空间文件交给 `importV2`。
   - 新工作空间 id：用文件里的 id；目录已存在就加后缀 `-2`、`-3`……，标题后加“（导入）”。
   - 先在临时目录建库、写入全部行（保留 id、版本、时间戳）、写 blobs，再整体改名到目标目录。任何一步失败就删除临时目录，原有工作空间不受影响。
   - 数据包清单按注册表重新校验；不合格的包不注册，但原清单及其对象完整保存在导入隔离报告中，原对象照常导入为未知类型；不得无声丢弃清单。
   - 缺端点、缺附件或结构损坏：整份失败，删除临时目录，不创建工作空间，报告里也不出现「跳过」。
   - 成功时的报告只列三项：导入数量（对象、展示、关系、附件），降级条目及原因（未知类型、无效包），未随包带走的外部资源。

3. **工具**：`app_workspace` 增加 `export`（返回文件名和 JSON 文本，界面用宿主的下载能力保存）和 `import`（参数为 JSON 文本，返回报告）。
4. **界面**：工作空间面板里加“导出”“导入”。导入完成后显示报告，并提供“切换到导入的工作空间”。

## 验收

`workbench/tests/kernel-bundle.test.ts`：

1. 往返：建一个含对象、展示（含框内展示）、关系、设置、数据包、附件的工作空间，导出再导入，两边按 id 逐行比较内容一致，附件字节一致。
2. 导入同一个文件两次，得到两个不同 id 的工作空间，第一个不受影响。
3. 中途失败（构造一个缺少对象但有展示指向它的文件，或缺少被引用附件的文件）：整份导入失败、无目标目录和临时目录残留，不能导入成功并在报告里写「跳过」；构造一个根本不是 JSON 的文件：抛错，没有新目录残留。
4. 未知类型的对象导入成功，出现在降级条目里并写明原因；无效包不注册，原对象和原清单仍在。
5. v2 工作空间文件经同一入口导入，走 `importV2`。
6. 超过附件大小上限时导出失败，错误里列出附件。

浏览器测试：在 `tests/blank.ts` 里（`SAND_KERNEL=v3`）点“导出”能得到文件内容，点“导入”后能切换过去并看到原来的组件。

命令：`npm run format:check`、`npm run typecheck`、`npm test`、`SAND_KERNEL=v3 npm test`、`SAND_KERNEL=v3 npm run test:blank`。

## 交接与边界验收

按 05 §3 完成快照一致性、坏行整体失败、附件校验、目录碰撞和隔离清单往返测试。允许修改 tests/blank.ts。未知包仍保留原对象与原清单，不能丢弃无法理解的内容。
