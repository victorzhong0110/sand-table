# 内核 v3 设计

本目录是 Sand Table 内核 v3 的唯一设计依据（2026-10-22 起）。与仓库里其他规划文档冲突时，以本目录为准。

2026-11-13 起，产品采用 DSH 插件组合方向。00–05 规定默认白板文档提供者的机制，06 规定插件组合与迁移边界；07 记录复用候选和验证证据，不把候选写成已实现。

| 文件 | 内容 | 谁需要读 |
|---|---|---|
| [00-decisions.md](00-decisions.md) | 为什么改、改成什么、否决了什么、怎么分工 | 所有人先读 |
| [01-data-model.md](01-data-model.md) | 术语、表结构、修订号、历史、删除语义、不变量、v2 导入映射 | 做内核的人 |
| [02-commands-and-tools.md](02-commands-and-tools.md) | 统一写入 `applyCommands`、读接口、MCP 工具、新旧工具对照 | 做内核和工具的人 |
| [03-types-and-extensions.md](03-types-and-extensions.md) | 类型声明、JSON Schema 规则、关系槽、视图、数据包、内置包清单 | 做包、组件、扩展的人 |
| [04-canvas.md](04-canvas.md) | React Flow 画布、写回规则、快捷键、历史面板（Phase 3） | 做界面的人 |
| [05-delivery-contracts.md](05-delivery-contracts.md) | 跨任务接口、验收、运行与导出边界 | 所有人 |
| [06-plugin-composition.md](06-plugin-composition.md) | 资源权威、宿主恢复、空间上下文与组合迁移 | 所有人 |
| [07-plugin-reuse.md](07-plugin-reuse.md) | 已有插件、复用决定、缺口与证据等级 | 做选型和集成的人 |
| [tasks/](tasks/README.md) | 任务卡、阶段、分工与流程 | 编码模型按卡执行 |

编码模型请从仓库根目录的 `AGENTS.md` 开始。
