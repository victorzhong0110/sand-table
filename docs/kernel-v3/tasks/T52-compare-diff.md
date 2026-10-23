# T52 并排比较与差异

| 项 | 内容 |
|---|---|
| 执行 | minimax |
| 依赖 | T40 |
| 分支 | `task/T52-compare-diff` |
| 关联 issue | #41 第二阶段 |

## 目标

一个“比较”组件引用两个对象（或同一对象的两个版本），并排显示；文字、代码、Markdown 显示差异；表格按单元格标出不同；图片只并排。比较**永远不修改**两份原内容，结果标明比较的是哪两个版本。

## 先读

- `AGENTS.md`
- issue #41
- `docs/kernel-v3/03-types-and-extensions.md` §4、§9
- `workbench/board/views/bindings.ts`（T40：`read`、`readVersion`）
- `workbench/packs/base/index.ts` 里现有的 `base.comparison`

## 开工前核对

确认 T40 已合并，`readVersion` 可用。不一致先停下来问。

## 可改文件

- `workbench/packs/base/index.ts`（`base.comparison` 升版本：新增关系槽 `left`（关系类型 `base.compare_left`）和 `right`（关系类型 `base.compare_right`），都是 `many: false`；两侧必须用不同的关系类型，否则分不清哪边是左和 `pinnedVersions?: { left?: number; right?: number }`；旧的内联 `left` / `right` 文字保留在 `legacy` 字段并照常显示；提供迁移）
- 新建 `workbench/board/compare/`（`CompareView.tsx`、`diff.ts`）
- `workbench/board/views/registry.ts`
- `workbench/package.json`、`workbench/package-lock.json`（`diff` 包，BSD-3 许可，版本写死）
- 新建 `workbench/tests/compare.test.ts`，修改 `workbench/tests/blank.ts`

## 不要做

- 不提供“合并”或“用左边覆盖右边”之类的写操作。

## 做法

1. **选择比较对象**：在两个选中的组件上右键“比较这两个” → 新建比较组件并连好 `left`、`right`。也可以在一个组件的历史里选两个版本比较（两侧槽指向同一对象，`pinnedVersions` 分别填版本号）。
2. **读取**：没固定版本就读当前版本并订阅变化；固定了版本就用 `readVersion`，读不到时显示原因。
3. **差异**（`diff.ts`）：
   - 文字、Markdown：按行比较，行内按词比较，增删着色。
   - 代码片段：按行比较，带行号。
   - 表格：按列 key 和行 key 对齐，标出新增行、删除行、改变的单元格。
   - 其他类型：只并排显示两边的卡片，并逐字段列出不同的字段。
4. **标注**：顶部写明“左：《标题》 版本 3　右：《标题》 版本 5（当前）”。任一侧被删除时显示原因。

## 验收

- `workbench/tests/compare.test.ts`：文字、代码、表格三种差异的计算结果。
- `workbench/tests/blank.ts`：
  1. 比较两个便签，差异正确；修改其中一个，差异更新；两份原文在服务端没有被改动。
  2. 固定版本 1 与当前版本比较，之后修改对象，左侧仍显示版本 1。
  3. 打开含旧版内联比较的工作空间，旧比较照常显示。
- `npm run format:check`、`npm run typecheck`、`npm test`、`npm run test:blank` 全部通过。
