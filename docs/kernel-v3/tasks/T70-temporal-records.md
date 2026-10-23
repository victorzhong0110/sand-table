# T70 时间与关系状态：存储和查询

| 项 | 内容 |
|---|---|
| 执行 | grok |
| 依赖 | T61、T26、T60 |
| 分支 | `task/T70-temporal-records` |

## 先读

- `AGENTS.md`
- `docs/kernel-v3/05-delivery-contracts.md`
- 本卡依赖任务的交付接口和对应测试

## 目标

实现 05 §8 的状态、关系状态、分支和观察者模型及 UI/MCP 同源查询。时间查询不会修改共同资料，不依赖小说包。

## 可改文件

- `workbench/packs/base/index.ts`（类型、关系槽、校验声明），`workbench/kernel/read.ts`、新建 `kernel/temporal-query.ts`、`kernel/index.ts`（类型无关查询机制）
- `workbench/server/core-tools.ts`、`app-tools.ts`；`docs/kernel-v3/02-commands-and-tools.md`、`03-types-and-extensions.md`
- 新建 `workbench/tests/temporal-query.test.ts` 和自造 5 章 3 人 fixture

## 做法

1. 按 05 §8 注册全部类型/关系、Schema 与索引需求。通用字段/关系校验机制校验单值、目标类型、无环、推测依据，不让内核认识小说词汇。
2. 实现 stateAt/relationAt 的过滤、继承、冲突和分页；同一只读事务返回 revision、records、conflicts、nextCursor、truncated。
3. 扩展 sand_query 为互斥分支：普通查询或 stateAt 或 relationAt；每个结果返回状态记录对象 id，模型可用 sand_read 取完整记录。app_state_query 返回同源完整数据，不复制算法。
4. 大样例 10,000 条记录，记录 explain query plan 和查询耗时；索引通过版本化迁移添加，不全库反序列化扫描。确需受限扫描则硬限制候选数并返回 truncated，不给不完整结论。

## 不要做

不推导没有记录的状态，不将章节号当时间，不创建第二套历史系统，不自动确定冲突赢家。

## 验收

- 通用测试包和小说 fixture 都能查询；关闭 novel 后通用查询仍工作。
- 同一人主线/分支/观察者结果隔离；同层重叠返回两条 conflict；删除覆盖后恢复祖先结果。
- 故事顺序/叙述顺序/date 三维互不串用；空结果不写任何表；非法时间/环/无依据推测被拒。
- MCP 和 app 查询在同一 revision 得到同一组记录；分页无重复遗漏，超限有提示。
- format:check、typecheck、npm test、build 通过。

