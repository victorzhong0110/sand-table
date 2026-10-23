# T42 技术验证：富文本编辑器

| 项 | 内容 |
|---|---|
| 执行 | minimax |
| 依赖 | T41 |
| 分支 | `task/T42-text-spike` |
| 类型 | 技术验证。产出决策记录，不改产品代码 |
| 关联 issue | #37 |

## 要回答的问题

在 TipTap 和 Milkdown 之间选一个做便签、章节、笔记的编辑器（也可以提出第三个候选，但要说明理由）。存储格式已定为 Markdown（GFM 加 `$行内公式$`、`$$块公式$$`），见 `00-decisions.md` K8。

逐项实测：

1. **Markdown 往返**：用 `workbench/spikes/text/corpus/` 里你准备的样例（标题、列表、嵌套列表、任务列表、表格、链接、`sand://object/<id>` 链接、行内代码、代码块、引用、行内公式、块公式、中文长段落），加载后不做任何编辑直接导出，与原文逐字比较。列出每个差异。
2. **中文输入法**：Chrome、Safari 下用拼音输入法连续输入、选词、删除，是否丢字、跳光标、提前提交。
3. **撤销**：编辑器自己的撤销在编辑期间可用；离开编辑后整段修改作为白板历史里的一步（与 `board/edit-session.ts` 的意图分组配合），说明怎么接。
4. **体积**：gzip 后多少；按 T41 的规则能否按需加载。
5. **公式**：KaTeX 渲染行内和块公式，写错时如何显示错误。
6. **代码块高亮**：用哪个库（候选：lowlight、Prism、Shiki），体积多少。
7. **许可**：每个依赖的许可证。

## 先读

- `AGENTS.md`
- `docs/kernel-v3/05-delivery-contracts.md`（本阶段公共契约与交接规则）
- `docs/kernel-v3/00-decisions.md` K8、`03-types-and-extensions.md` §3.1 第 3 条（`sand://object/<id>` 链接）
- `docs/adr/0002-bundle-loading.md`（T41 产物）
- issue #37

## 可改文件

- 新建 `docs/adr/0003-rich-text.md`
- 新建 `workbench/spikes/text/`（不参与构建和测试）

## 不要做

- 不修改产品代码，不往 `workbench/package.json` 加依赖。

## 交付

`docs/adr/0003-rich-text.md`：上面 7 项的实测结果表、选定方案、Markdown 中**不支持**的语法清单（遇到时原样保留为纯文本）、给 T43 的接入要点。架构负责人审过合并后，T43 才开工。
