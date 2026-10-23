# T74 已合并内核与工具面的契约补齐

| 项 | 内容 |
|---|---|
| 执行 | minimax |
| 依赖 | T17、T20 |
| 分支 | `task/T74-existing-contract-backfill` |

## 先读

- `AGENTS.md`、`docs/kernel-v3/05-delivery-contracts.md` §1–4、§9
- T17/T20 卡片，main 的 kernel/legacy、kernel/read.ts、server/v3、tests/kernel-import.test.ts、tests/tools-v3.test.ts

## 目标

将本轮任务卡对早期接口新增的要求落到已经合并的实现，不要求重做已有成果，不让后续卡依赖不存在的接口。

## 可改文件

- `workbench/kernel/` 的相关读/视图/活动/工作空间接口及 index.ts（不改作品核心语义）
- `workbench/kernel/legacy/import-v2.ts`（仅框内坐标补齐）
- `workbench/server/v3/`（app_activity、类型元数据、跨进程工具刷新）
- 对应 kernel/tools/architecture 测试；`docs/kernel-v3/02-commands-and-tools.md`

## 做法

1. 逐项列出 main 已满足/缺失的接口与证据；已满足项只复用测试，不重写。
2. 核对 T17 框内相对坐标，导入嵌套框与展示保持屏幕位置；已有导入库不重导入。若存量 v3 数据仍为绝对坐标，不能盲目迁移，先用导入版本标记准确识别；无法识别的数据报告需人工确认，不能改坏用户作品。
3. app_activity list 提供所有未过期活动，单次至多 100 条，返回截断标记，不改 agent_reads；app_view get 返回 nav_stack。
4. sand_types 精简列表补 icon/capabilities/presets 元数据；完整声明仍按 types 过滤；不改变模型核心工具数。app 工具只注册 UI 可见性。
5. 跨进程包启停由 packs revision 变化驱动工具句柄刷新，每秒检查，服务退出释放计时器；不靠本进程写入回调。
6. 核实工具层不直接 SQL 写入，缺少状态接口时在 kernel 补齐；不把状态写混入作品历史。

## 验收

- 导入含嵌套框 fixture 后坐标往返正确，原 v2 文件不变。
- 两个进程打开同库，在 A 停包，B 的工具列表在 2 秒内变化；重新启用恢复。
- 活动读取不推进 agent_reads，过期活动消失；类型列表有工具箱需要的元数据。
- format:check、typecheck、npm test、SAND_KERNEL=v3 npm test 通过；PR 附逐项差距与补齐表。
