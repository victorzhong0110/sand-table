# T50 时间轴视图

| 项 | 内容 |
|---|---|
| 执行 | grok |
| 依赖 | T40、T26 |
| 分支 | `task/T50-timeline` |
| 关联 issue | #40 |

## 目标

一个“时间轴”组件：把一组对象按用户**明确选择**的时间维度排开（故事时间顺序、叙述顺序或某个日期字段），支持时间点和区间、多条轨道，点击定位到原对象。时间维度永远不混用编辑历史；章节不被当成天然的时间刻度。

## 先读

- `AGENTS.md`
- issue #40、#35（时间与变化部分）
- `docs/kernel-v3/03-types-and-extensions.md` §8.2（小说包）、§9
- `workbench/board/views/bindings.ts`（T40）、`workbench/kernel/migrate.ts`（T26）

## 开工前核对

确认 T40、T26 已合并；`novel.event` 当前字段与 `03` §8.2 一致。不一致先停下来问。

## 可改文件

- `workbench/packs/base/index.ts`（新增类型 `base.timeline`、关系类型 `base.timeline_item`）
- `workbench/packs/novel/index.ts`（`novel.event` 升版本：新增可选 `storyOrder`（整数，“故事时间排序”）和 `storyOrderEnd`（整数，区间结束）；迁移不改已有数据）
- 新建 `workbench/board/timeline/`（`TimelineView.tsx`、`scale.ts`）
- `workbench/board/views/registry.ts`
- 新建 `workbench/tests/timeline-view.test.ts`，修改 `workbench/tests/blank.ts`

## 不要做

- 不解析自由文本的 `storyTime`（如“三年前的冬天”）；它只作为标签显示。
- 不做回放和日历视图（以后再开卡）。

## 做法

1. **`base.timeline`**：数据 `{ dimension: { field: string; endField?: string; label: string }, tracks: "type" | "none" }`，关系槽 `items`（`base.timeline_item`，`many: true`）。
2. **可选维度**：只列出条目类型里 `x-sand-widget` 为 `integer`、`number` 或 `date` 的字段（例如事件的 `narrativeOrder`、`storyOrder`），由用户在组件设置里选择，标签写清楚“叙述顺序”“故事时间排序”。
3. **渲染**：横向时间轴；有 `endField` 且有值的画成区间，否则画成点；`tracks = "type"` 时按对象类型分轨道。该维度没有值的条目放在轴下方“未排序”区，不猜位置。
4. **交互**：点条目定位到原对象；拖动轴平移、滚轮缩放（只是视图）；“从白板添加”把当前白板上符合类型的对象批量加入 `items`。
5. **订阅**：条目变化（含排序字段变化）时更新。

## 验收

- `workbench/tests/timeline-view.test.ts`：刻度计算；点与区间布局；缺值条目进入“未排序”。
- `workbench/tests/blank.ts`：
  1. 三个事件填叙述顺序 1、2、3，以叙述顺序建时间轴，顺序正确；切换到故事时间排序（填 3、1、2）后顺序变化。
  2. 一个事件不填排序值，出现在“未排序”区。
  3. 修改某个事件的叙述顺序，时间轴在 2 秒内更新。
  4. 旧的 `novel.event` 数据（没有新字段）正常显示。
- `npm run format:check`、`npm run typecheck`、`npm test`、`npm run test:blank` 全部通过。
