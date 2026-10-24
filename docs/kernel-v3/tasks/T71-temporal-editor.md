# T71 时间、分支与观察者编辑和建议

| 项 | 内容 |
|---|---|
| 执行 | minimax |
| 依赖 | T70、T50、T51 |
| 分支 | `task/T71-temporal-editor` |

## 先读

- `AGENTS.md`
- `docs/kernel-v3/05-delivery-contracts.md`
- 本卡依赖任务的交付接口和对应测试

## 目标

人能创建/查看某时状态、关系变化、备选分支和观察者认知；AI 的矛盾分析作为待处理建议。

## 可改文件

- 新建 `workbench/board/context/TemporalPanel.tsx`、`StateRecordForm.tsx`、`SuggestionView.tsx`
- `board/context/ContextPanel.tsx`、`board/views/registry.ts`、`board/timeline/TimelineView.tsx`
- 新建 `workbench/tests/temporal-editor.test.ts`，`tests/blank.ts`

## 做法

1. 在对象详情和交叉情境提供状态面板，显式选择 dimension、at、branch、observer；默认主线事实层，标签持续可见。
2. 创建状态记录必须选择主体/字段/时间范围，关系状态还选目标/关系类型；章节只作可选 anchors。继承项标来源分支，只读显示；“在此分支覆盖”建新记录，不改祖先。
3. 观察者认知与事实并列显示但分栏；冲突显示全部候选及依据，不渲染单一赢家。所有入口点回同一记录对象。
4. AI 用 sand_edit 创建 base.suggestion；人接受进入表单确认差异，在同批命令中改记录和建议状态，带 expectedVersion；拒绝只改状态。
5. 分支创建/重命名/删除与状态编辑均可撤销；删除分支不删除主线内容，关联的记录保留失效提示。

## 验收

- 浏览器完成“第三章学生→第七章对手”，人物共同资料不变；从人物/章节/交叉入口看到同一记录 id。
- 创建备选分支覆盖，回主线结果不变；删除覆盖后恢复继承。
- 老师认知与客观事实有不同标签；无记录显示未知，不自动补齐。
- 接受建议发生版本冲突时草稿保留，无半批写入；拒绝不改变原内容。
- format:check、typecheck、npm test、test:blank、build 通过，PR 附操作截图。

