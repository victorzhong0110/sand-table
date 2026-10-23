# T23 科研包工具、文件夹连接器、DSH 插件迁移

| 项 | 内容 |
|---|---|
| 执行 | minimax |
| 依赖 | T20 |
| 分支 | `task/T23-research-folder-dsh` |

## 目标

把三处剩余的 v2 工具搬到 v3：科研包的 PDF 工具、文件夹连接器、DSH 插件调用的工具。

## 先读

- `AGENTS.md`
- `docs/kernel-v3/05-delivery-contracts.md`（本阶段公共契约与交接规则）
- `docs/kernel-v3/02-commands-and-tools.md` §3.3、§4 最后一段（DSH）
- v2 实现（只读）：`workbench/domains/research/tools.ts`、`workbench/connectors/pdf.ts`、`workbench/connectors/folder.ts`、`workbench/connectors/tools.ts`、`workbench/dsh-plugin/index.js`
- v2 测试：`workbench/tests/pdf.test.ts`、`connectors.test.ts`、`dsh-plugin.test.ts`
- `workbench/server/v3/server.ts`（T20 产物，看包工具怎么注册）

## 可改文件

- `workbench/packs/research/`（加 `tools.ts`，给 `PackSpec` 加 `registerTools`）
- 新建 `workbench/server/v3/folder-tools.ts`，并在 `workbench/server/v3/server.ts` 里绑定了文件夹时注册
- `workbench/dsh-plugin/index.js`
- 新建 `workbench/tests/research-v3.test.ts`；修改 `workbench/tests/dsh-plugin.test.ts`

## 不要做

- 不修改 v2 的 `domains/`、`connectors/`。需要的逻辑**复制**到新位置（T24 会删除 v2 目录）。
- 不改 PDF 读取的规则（页码、指纹、不做 OCR）。

## 做法

1. **`research_pdf`**：一个工具，`action` 为 `read`、`import_evidence`、`verify_citation`，参数和行为分别对应 v2 的 `sand_read_pdf`、`sand_import_pdf_evidence`、`sand_verify_pdf_citation`。`import_evidence` 建 `research.evidence` 对象（用 `applyCommands`，进历史），引用信息写进 `citation` 字段（`locator` 格式）。
2. **`folder_read`**：对应 v2 `sand_read_folder`，只在启动参数绑定了文件夹时注册。
3. **DSH 插件**：4 个工具改为转调 v3 工具（`sand_table_list_boards` → `sand_status`，`sand_table_read_board` → `sand_query { boardId }`，`sand_table_read_object` → `sand_read`，`sand_table_edit_space` → `sand_edit`），参数在插件里做转换。插件对外的工具名不变。

## 验收

- `workbench/tests/research-v3.test.ts`：把 `pdf.test.ts` 的核心用例在 v3 上重写：读页、导入证据后能 `sand_query { types: ["research.evidence"] }` 查到、引用指纹变化后 `verify_citation` 报告失效；导入证据可以撤销。
- 停用 research 包后模型可见工具少 1 个（`research_pdf` 消失），重新启用后恢复。
- `dsh-plugin.test.ts` 在 `SAND_KERNEL=v3` 下通过。
- `npm run format:check`、`npm run typecheck`、`npm test`、`SAND_KERNEL=v3 npm test` 全部通过。
