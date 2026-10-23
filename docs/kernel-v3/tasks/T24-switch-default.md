# T24 默认切到 v3，删除 v2 内核

| 项 | 内容 |
|---|---|
| 执行 | grok |
| 依赖 | T74、T21、T22、T23、T25 全部合并；项目所有者用 `SAND_KERNEL=v3` 实际使用后明确同意 |
| 分支 | `task/T24-switch-default` |

## 目标

v3 成为唯一实现：默认启动 v3，删除 v2 内核、v2 工具和只为 v2 存在的测试，文档与实际一致。

## 开始前确认

在 PR 描述第一行写：项目所有者同意切换的 issue 评论或 PR 评论链接。没有这条链接，不要开始。

## 先读

- `AGENTS.md`
- `docs/kernel-v3/05-delivery-contracts.md`（本阶段公共契约与交接规则）
- `docs/kernel-v3/00-decisions.md` K10
- `docs/kernel-v3/tasks/README.md`

## 可改文件

本卡会改很多文件。范围限于：

- 删除：`workbench/core/` 中只被 v2 使用的文件（`store.ts`、`workspace.ts`、`workspace-lock.ts`、`workspace-manager.ts`、`persistence.ts`、`history.ts`、`timeline.ts`、`content.ts`、`objects.ts`、`model.ts`、`spaces.ts`、`space-state.ts`、`changes.ts`、`domains.ts`、`packs.ts`、`pack-fetch.ts`、`results.ts`）；`workbench/server/` 中 v2 的 `server.ts`、`spaces.ts`、`changes.ts`、`packs.ts`、`workspaces.ts`、`tool-types.ts`；`workbench/domains/`；`workbench/connectors/` 中已复制到新位置的文件；只测试上述代码的测试文件。
- 移动：`workbench/server/v3/*` → `workbench/server/*`，`board/v3/*` → `board/data-client/*`，并更新 import。
- 删除所有 `SAND_KERNEL` 判断和 v2 分支；`board/v3/adapter.ts` 里为 v2 结构做的适配，能删则删，删不了的在 PR 里列出（Phase 3 处理）。
- 删除 `.github/workflows/workbench.yml` 里重复的 `SAND_KERNEL=v3` 步骤。
- 文档：`README.md`、`workbench/README.md`、`workbench/docs/QUICKSTART.md` 改成 v3 的实际情况（存储位置、工具名、从旧版本升级会自动导入且旧撤销记录不保留）；`AGENTS.md` 的“目录速览”更新。

`core/host-bridge.ts` 保持原路径，`board/` 的界面组件、`local/`、`dsh-plugin/` 保留（只更新 import）。如果某个“删除”清单里的文件仍被保留代码使用，先停下来在 PR 里提“需要架构确认”。

## 不要做

- 不顺手重构界面。
- 不删除 `workspace.json` 导入器。

## 验收

- `grep -r "SAND_KERNEL" workbench/` 没有结果。
- `workbench/core/` 里不再有上面删除清单中的文件。
- CI 全部步骤通过（含浏览器测试）。
- 手工核对（写进 PR 描述）：用一份 v2 的 `workspace.json`（复制一份真实数据或用 `tests/fixtures/v2/` 里的）启动，自动导入成功，界面显示正常，能编辑、撤销、重启后内容仍在。

## 交接与边界验收

T17 坐标是否已实现以 main 代码及其测试为准；本 PR 合并后用框内导入回归验证，不要求为合并任务卡重跑导入用户原数据。保留宿主桥及其直接依赖；删除列表中仍用于宿主的文件可保留并记录，不为删目录破坏宿主。
