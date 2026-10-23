# T73 过程白板与观察范围

| 项 | 内容 |
|---|---|
| 执行 | minimax |
| 依赖 | T50、T71 |
| 分支 | `task/T73-process-range` |

## 先读

- `AGENTS.md`
- `docs/kernel-v3/05-delivery-contracts.md`
- 本卡依赖任务的交付接口和对应测试

## 目标

过程白板可以绑定一个时间轴，拖动时间范围筛选观察内容；与真正撤销/回滚清楚分开。

## 可改文件

- `workbench/packs/base/index.ts`（新增 base.process，container=true；timeline 槽 base.process_timeline → base.timeline 单值）
- 新建 `workbench/board/timeline/ProcessRange.tsx`、`process-filter.ts`；`board/canvas/FlowCanvas.tsx` 的只读过滤挂载点
- 新建 `workbench/tests/process-range.test.ts`、`tests/blank.ts`

## 做法

1. base.process 是普通可进入白板，data 只有 description；条目仍为原对象展示，不复制事实。
2. 进入后顶部显示已绑定时间轴和观察范围。范围、branch、observer 存界面会话（按 viewId+boardId），默认全部；拖范围只过滤已存在展示与相应关系，未排序条目保留独立区。
3. 状态叠层读取 T70 查询，标签写明时间维度/分支/观察者；历史面板游标保持不动。提供“显示全部”，避免过滤后看似内容丢失。
4. 点击条目定位来源并记录返回位置，返回恢复原范围。过滤不产生 object/presentation/relation 更新。

## 验收

浏览器拖范围前后内容表和历史数相同，观察结果改变；清除后全部恢复；缺值不落到零点；点击再返回恢复范围；关闭重开不丢内容。format:check、typecheck、npm test、test:blank、build 通过。

