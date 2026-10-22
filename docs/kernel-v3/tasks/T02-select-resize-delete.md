# T02 选中即可调整尺寸、删除键移除、Esc 取消选择

| 项 | 内容 |
|---|---|
| 执行 | minimax |
| 依赖 | 无 |
| issue | #30（只做其中三项） |
| 分支 | `task/T02-select-resize-delete` |

## 目标

选中一张卡片后，不切换任何模式就能：拖右下角把手调整尺寸、按 Delete / Backspace 移除、按 Esc 取消选择。

## 现状

- `workbench/board/SpaceCanvas.tsx` 里缩放把手只在 `mode === "arrange" && detail 为 full` 时渲染（搜 `resize-handle`）。拖动早已不需要编排模式，缩放却仍需要，自相矛盾。
- 把手样式在 `workbench/board/style.css` 的 `.resize-handle`：2px 内边距、无描边，几乎看不见。
- 全局键盘处理在 `workbench/board/main.tsx` 的 `onKey`，只处理撤销重做；其中“焦点在输入框时不响应”的判断要沿用。
- 移除组件现在只能在右侧属性面板点“移除”，调用的是 `operate({ kind: "remove", instanceId })`（见 `workbench/board/ComponentPanel.tsx`）。

## 先读

- `AGENTS.md`
- `workbench/board/SpaceCanvas.tsx`（重点：`resize-handle`、`select(`、`operate(`、`onKeyDown`）
- `workbench/board/main.tsx` 的 `onKey`
- `workbench/board/ComponentPanel.tsx` 里“移除”按钮的实现
- `workbench/tests/blank.ts`（现有浏览器测试的写法）

## 可改文件

- `workbench/board/SpaceCanvas.tsx`
- `workbench/board/main.tsx`
- `workbench/board/style.css`
- `workbench/tests/blank.ts`

## 不要做

- 不做多选批量操作以外的新功能（复制粘贴、对齐、方向键移动都不在本卡）。
- 不改服务端和 `core/`。
- 不删除编排模式本身。

## 做法

1. 把手的渲染条件改为：`(mode === "arrange" || 该卡片在当前选区里) && detail 为 full`。
2. 把手样式：12×12 可点区域、1px 描边、悬停时放大到 16×16、`cursor: nwse-resize`。用现有的颜色变量，不写死颜色。
3. 键盘（加在 `main.tsx` 的全局处理或 `SpaceCanvas` 的画布级处理里，二选一，选你认为改动更小的）：
   - `Delete` / `Backspace`：焦点不在输入框、文本区域、可编辑区域，且选区非空时，对选中的每个组件调用 `operate({ kind: "remove", instanceId })`。多个组件共用同一个 `intentId`，撤销一次全部恢复。
   - `Escape`：不在就地编辑状态、且选区非空时，清空选区（用现有的选择接口，不要新造）。在就地编辑状态时保持原行为（取消编辑）。

## 验收

- `workbench/tests/blank.ts` 增加三段断言：
  1. 浏览模式下点击选中一张卡片，把手可见；拖动把手后，服务端返回的该组件宽高变大。
  2. 选中一张卡片按 Delete，该组件从服务端数据中消失；按 ⌘Z / Ctrl+Z 后恢复。
  3. 选中后按 Escape，选区为空。
- 在属性面板的输入框里按 Backspace 删除文字，组件**不会**被移除（断言组件仍在）。
- `npm run format:check`、`npm run typecheck`、`npm test`、`npm run test:blank` 全部通过。
