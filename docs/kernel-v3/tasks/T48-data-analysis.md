# T48 数据：分析与联动

| 项 | 内容 |
|---|---|
| 执行 | minimax |
| 依赖 | T47 |
| 分支 | `task/T48-data-analysis` |
| 关联 issue | #39 第二阶段 |
| 说明 | 改动较大，可以按下面的 1–3 和 4–6 拆成两个 PR，都引用本卡 |

## 目标

表格可以排序、筛选、分组、加计算列、导入导出 CSV；图表可以选聚合方式、悬停、框选范围；筛选器组件明确作用于哪些表格和图表；图表之间可以配置高亮联动。排序、筛选、分组和联动不改原始 rows；CSV 导入经确认创建新表格，不覆盖现有表格。

## 先读

- `AGENTS.md`
- `docs/kernel-v3/05-delivery-contracts.md`（本阶段公共契约与交接规则）
- issue #39（第二阶段与“模型约束”）
- `docs/adr/0004-charts.md`
- `workbench/board/data/`（T47 产物）、`workbench/board/views/bindings.ts`（T40）

## 开工前核对

确认 T47 已合并，`base.table` v2、`base.chart` v2 与 T47 卡片一致。依赖未完成则等待；机械差异按 05 §1 适配，语义冲突只暂停受影响部分。

## 可改文件

- `workbench/board/data/` 下的文件，新建 `workbench/board/data/formula.ts`、`csv.ts`、`FilterView.tsx`
- `workbench/packs/base/index.ts`（表格、图表的视图配置字段；新增类型 `base.filter`；新增关系类型 `base.filters`、`base.highlights`）
- 新建 `workbench/board/data/MetricView.tsx`、`derive-table.ts`；`board/views/registry.ts`（登记指标/筛选视图）
- 新建 `workbench/tests/data-analysis.test.ts`，修改 `workbench/tests/blank.ts`

## 不要做

- 不用 `eval`、`new Function` 或任何执行任意代码的方式算公式。
- 筛选、排序、分组只是视图配置，不改表格的行数据。

## 做法

1. **视图配置**（存在表格对象的 `view` 字段里，不碰 `rows`）：排序（列 + 方向，可多级）、筛选（列 + 条件：等于、包含、大于、小于、介于、为空、不为空）、分组（按列，组内显示行数和数字列的合计）。界面上清楚显示“当前有 2 个筛选条件”并可一键清除。
2. **计算列**（`formula.ts`）：自己写一个小解析器，只支持数字、列引用 `[列名]`、`+ - * /`、括号，以及 `SUM AVG MIN MAX COUNT ROUND IF`，比较与空值/列 key 规则按 `05` §5。除以 0、引用不存在的列、类型不对时，该单元格显示错误原因，不显示 0。计算列存公式，不存结果。
3. **CSV**（`csv.ts`）：导入（识别 UTF-8 与带 BOM、逗号和制表符分隔、引号转义），导入前预览前 20 行和推断的列类型；导出当前视图或全部数据。
4. **图表**：聚合方式（无、合计、平均、计数、最大、最小）；悬停提示；图例开关；框选 x 范围后可以“只看这一段”。
5. **筛选器组件 `base.filter`**：一个下拉、范围滑块或文本框；通过关系 `base.filters` **明确连接**到一个或多个表格（以及经由表格的图表）；不连接就什么都不影响。卡片上显示“作用于：表格 A、图表 B”。
6. **高亮联动**：两个图表之间建 `base.highlights` 关系后，在一个图表上悬停或框选，另一个图表高亮对应的行。

## 验收

- `workbench/tests/data-analysis.test.ts`：公式解析与求值（含错误情况）；CSV 往返（含引号、逗号、换行、中文）；筛选与分组结果。
- `workbench/tests/blank.ts`：
  1. 筛选后图表随之变化，表格的 `rows` 在服务端没有变化；清除筛选后恢复。
  2. 加一个计算列 `[单价]*[数量]`，结果正确；把某行数量清空，该单元格显示错误原因。
  3. 导入一个 CSV，预览后确认，表格出现对应数据。
  4. 筛选器只连接表格 A 时，表格 B 不受影响。
  5. 两个图表建立高亮联动后，在一个上悬停，另一个出现高亮。
- `npm run format:check`、`npm run typecheck`、`npm test`、`npm run test:blank` 全部通过。

## 交接与边界验收

必须交付 05 §5 的 base.metric、同源 deriveTable、显式过滤联动。测同一表驱动图表与指标同步、保存重开配置仍在；CSV 只建新表。指标变更升版本并提供无损迁移。
