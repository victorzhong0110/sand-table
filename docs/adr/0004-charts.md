# ADR 0004 数据表图表库

状态：拟采用 ECharts 6.0.0，由 T47 接入三种基础图，T48 接入筛选及联动。对应 [T46](../kernel-v3/tasks/T46-charts-spike.md)、[T47](../kernel-v3/tasks/T47-table-charts.md)、[T48](../kernel-v3/tasks/T48-data-analysis.md) 和 [issue #39](https://github.com/victorzhong0110/sand-table/issues/39)。

## 测量

Linux，Chromium Headless 153.0.8010.0，Node 24.22.3。每种图用 300 × 200 视口，在黑白和暖纸主题下渲染 24 行样例。耗时单列为两条数据系列各 2,000 行，从创建图表直到下一帧的时间。首轮预热后取三次中位数。表中的 gzip 是 esbuild 生成的完整 IIFE，采用 node:zlib 默认级别。页面 CSP 沿用 [ADR 0002](0002-bundle-loading.md) 的本地策略。

| 候选 | 原始字节 / gzip | 柱、线、散点中位耗时 | 交互 |
| --- | ---: | --- | --- |
| ECharts 6.0.0 | 571978 / 192572 | 116.8 / 27.4 / 152.3 ms | tooltip 和图例动作触发回执，框选返回 7 个数据索引，按行 ID 外部高亮正确描边 |
| Vega-Lite 6.4.2、Vega 6.2.0、Vega Interpreter 2.3.2 | 1085661 / 378837 | 430.2 / 127.4 / 178.0 ms | SVG 提供悬停标记和图例，框选生成信号，修改外部行 ID 后标记透明度变更 |
| Observable Plot 0.6.17 | 265553 / 91586 | 234.5 / 29.8 / 97.1 ms | 配置 pointer 和 tip，图例是静态输出，框选与跨图高亮需要应用维护交互 |

三组均能在两套主题里生成绘图区。样例标签使用短字段名，连续数据使用轴刻度，详细值放入悬停提示。点密集时，300 像素画布会发生重叠。ECharts 的首次柱图、散点图超过一帧，后续批量更新时应合并重绘，并对稠密分类图保留范围筛选入口。

三组输入映射保留了 `null`。ECharts 折线实测含两个缺值位置，画布路径留下两个空点且 `connectNulls: false`。柱图和散点以空坐标表达缺值，缺值不进入聚合。Vega 与 Plot 的本次输出只确认输入转换保留空值。ECharts 使用 Apache-2.0，Vega 系列使用 BSD-3-Clause，Observable Plot 使用 ISC。第三方的转依赖许可沿安装清单保留。

ECharts 按需块使用 `echarts/core` 与明确导入的三种图、CanvasRenderer、坐标轴、图例、提示和框选。采用 `renderMode: "richText"` 的提示，使用产品主题变量转换成色值。三套候选均在严格 CSP 下运行，ECharts 的预估按需块小于 450 KB gzip，接入主包会超过 50 KB 的单依赖增量。T47 应通过 T72 加载，发布时由正式构建重新量体积。

## 持久配置

```ts
type ChartConfigV2 = {
  kind: "bar" | "line" | "scatter";
  mapping: { x: string; y: string[] };
  aggregation?: "none" | "sum" | "mean" | "count" | "max" | "min";
  title?: string;
  legacyPoints?: unknown;
};
```

字段使用表格列的稳定 key，来源由 `base.data_source` 持久关系绑定。显示名字和单位从表格列读取。`legacyPoints` 在 v1 的旧图没有绑定来源时保留原数据，迁移保持无损。

`aggregation` 缺省为 `none`。其余操作按 `mapping.x` 的有类型值分组，对 `mapping.y` 的每个数字列分别计算。空的 x 不进分组，空的 y 不进入计算，`count` 只计非空数字，无有效值的组结果仍为 `null`。T47 输出原始逐行图。T48 先从受控来源派生聚合视图，转换层用对应结果绘图，并保留成员行 key 用于联动。当前原型在 [echarts.mjs](../../workbench/spikes/charts/echarts.mjs)。主题和行高亮由调用方作为运行时状态传入。

T47 订阅 `source`，删除表格或字段时显示具体原因。基础图默认选第一列和首个数字列，缺数字列时提示选择，禁止偷偷按 0 补齐。T48 把框选索引映射回行 key 后再发筛选或高亮，多个图表各自订阅显式关系，撤销筛选应恢复显示。用户或数据来源提供的值当作文本使用。

## 复现

```bash
cd workbench
npm ci
npm --prefix spikes/charts ci --ignore-scripts
CHROMIUM_PATH=/path/to/chromium node spikes/charts/run.mjs
```
