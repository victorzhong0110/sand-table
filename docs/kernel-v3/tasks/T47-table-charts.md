# T47 数据：可编辑表格与基础图表

| 项 | 内容 |
|---|---|
| 执行 | minimax |
| 依赖 | T46、T40、T26、T32、T72 |
| 分支 | `task/T47-table-charts` |
| 关联 issue | #39 第一阶段 |

## 目标

表格可以直接编辑（增删行列、粘贴数据），每列有类型和单位，空值就是空值。柱状图、折线图、散点图绑定一个表格，表格一改，图表跟着变。复制图表的展示仍共享同一份数据。

## 先读

- `AGENTS.md`
- `docs/kernel-v3/05-delivery-contracts.md`（本阶段公共契约与交接规则）
- `docs/adr/0004-charts.md`（**图表库和配置格式以它为准**）、`docs/adr/0002-bundle-loading.md`
- `docs/kernel-v3/03-types-and-extensions.md` §2（`migrations`）、§4、§9
- `workbench/kernel/migrate.ts`（T26）、`workbench/board/views/bindings.ts`（T40）
- `workbench/packs/base/index.ts`（现有 `base.table`、`base.chart`）

## 开工前核对

确认 ADR 0004 已合并；`Bindings.read` / `subscribe` 可用；`migrateData` 可用。依赖未完成则等待；机械差异按 05 §1 适配，语义冲突只暂停受影响部分。

## 可改文件

- `workbench/packs/base/index.ts`（`base.table` 升到 v2、`base.chart` 升到 v2，各带迁移；新增关系类型 `base.data_source`）
- 新建 `workbench/board/data/`（`TableView.tsx`、`ChartView.tsx`、`table-model.ts`、`chart-config.ts`、`paste.ts`）
- `workbench/board/views/registry.ts`
- `workbench/package.json`、`workbench/package-lock.json`（只加 ADR 选定的图表库，版本写死）
- 构建配置（按 ADR 0002）
- 新建 `workbench/tests/table-chart.test.ts`，修改 `workbench/tests/blank.ts`

## 不要做

- 不做排序、筛选、分组、计算列、CSV、联动（T48）。
- 不把图表库的配置存进数据。

## 做法

1. **`base.table` v2**：

   ```ts
   { columns: { key: string; label: string; type: "text" | "number" | "date" | "boolean"; unit?: string }[];
     rows: { key: string; cells: Record<string, string | number | boolean | null> }[] }
   ```

   v1 → v2 迁移：字符串列名变成 `{ key: "c1"…, label: 原名, type: "text" }`；行变成带 `key` 的对象；能全部解析成数字的列改成 `number`。
2. **`base.chart` v2**：`{ kind: "bar" | "line" | "scatter", mapping: { x: 列 key, y: 列 key[] }, title?: string }` 加关系槽 `source`（`base.data_source`，指向一个 `base.table`，`many: false`）。没有绑定表格时，沿用 v1 的内联 `points`（迁移时保留在 `legacyPoints` 里，照常显示）。
3. **表格视图**：单元格就地编辑；增删行列；表头里改列名、类型、单位；粘贴制表符分隔的文本（从表格软件复制来的）会按位置填入，必要时自动加行；空单元格存 `null`，显示为空白。每次编辑停止 600ms 后作为一步写入。
4. **图表视图**：通过 `Bindings.read("source")` 读表格，`subscribe` 监听变化；按 ADR 的转换函数生成图表；`null` 不画成 0；表格被删除或列不存在时显示原因（“绑定的表格已删除”“列「销量」不存在”）。
5. **新建图表**：在表格上右键“生成图表” → 新建图表对象、建 `base.data_source` 关系、默认选第一列做 x、第一个数字列做 y，放在表格旁边。
6. 图表配置面板：图表种类、x 列、y 列（可多选）、标题。

## 验收

- `workbench/tests/table-chart.test.ts`：v1→v2 迁移（含数字列识别）；粘贴解析；图表配置转换（`null` 被保留）。
- `workbench/tests/blank.ts`：
  1. 建表格、填数据、生成柱状图；改一个单元格，图表在 2 秒内更新。
  2. 把图表“再放一份”到另一块白板，改表格后两处图表都变。
  3. 清空一个单元格，图表在该处断开或跳过，不显示 0。
  4. 删除表格后图表显示“绑定的表格已删除”；撤销后恢复。
  5. 打开一个含 v1 表格的旧工作空间，表格正常显示和编辑。
- 构建后体积符合 ADR 0002。
- `npm run format:check`、`npm run typecheck`、`npm test`、`npm run test:blank` 全部通过。

## 交接与边界验收

按 05 §5 的 key、缺值、无数字列和无损迁移契约实现；测试旧值含布尔/空串/日期/混合数字时不丢内容。
