# T01 历史面板主链不缩进

| 项 | 内容 |
|---|---|
| 执行 | minimax |
| 依赖 | 无 |
| issue | #26 |
| 分支 | `task/T01-history-flat` |

## 目标

连续操作几十次后，历史面板里的记录仍在同一左边界，不出现横向滚动；被分叉取代的旧分支仍能一眼看出来。

## 现状

`workbench/board/HistoryPanel.tsx` 的 `depthOf()` 沿 `parentId` 链数出深度，渲染时 `paddingLeft: depth * 14px`，没有上限。`parentId` 的含义是“发生在哪条之上”，所以连续操作会串成一条链，第 37 步就缩进 518px，超出 332px 宽的面板。

每条记录（`TimelineRecord`，定义在 `workbench/core/history.ts`）已经带有 `current`、`branch`、`ahead` 三个标记：`branch` 为真表示它在被分叉取代的旧分支上。

## 先读

- `AGENTS.md`
- `workbench/board/HistoryPanel.tsx`
- `workbench/board/history.css`
- `workbench/core/history.ts` 中 `TimelineRecord` 的定义

## 可改文件

- `workbench/board/HistoryPanel.tsx`
- `workbench/board/history.css`
- 新建 `workbench/board/history-layout.ts`
- 新建 `workbench/tests/history-layout.test.ts`

## 不要做

- 不改历史的数据模型、`core/history.ts` 或任何服务端代码。
- 不改记录的排列顺序。
- 不把历史从工具抽屉里挪出来（那是 Phase 3 的事）。

## 做法

1. 新建 `board/history-layout.ts`，导出纯函数：

   ```ts
   export function indentOf(record: { branch?: boolean }): 0 | 1 {
     return record.branch ? 1 : 0;
   }
   ```

2. `HistoryPanel.tsx` 删除 `depthOf()`，渲染时改用 `indentOf(record)`，缩进 `indentOf(record) * 16px`。
3. 检查 `history.css`：`.history-timeline` 不应再出现横向滚动条，加 `overflow-x: hidden`；长标签用省略号截断（`text-overflow: ellipsis; white-space: nowrap; overflow: hidden`），完整标签放进 `title` 属性。
4. `history.css` 里描述“每层一条竖线”的注释和实现不符，改成描述现在的实际做法。

## 验收

- `workbench/tests/history-layout.test.ts`：
  - 40 条 `branch` 为假的记录，`indentOf` 全部为 0；
  - `branch` 为真的记录为 1。
- 在 `workbench/` 下：`npm run format:check`、`npm run typecheck`、`npm test` 全部通过。
- `npm run test:blank` 通过（需要 Chromium，可设 `CHROMIUM_PATH`）。
- 手工核对：本地启动，连续拖动一个组件 30 次，打开历史面板并展开全部，所有记录左对齐，没有横向滚动条。在 PR 描述里写明核对结果，最好附截图。
