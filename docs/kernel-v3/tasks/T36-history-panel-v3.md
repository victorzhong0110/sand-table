# T36 历史面板 v3

| 项 | 内容 |
|---|---|
| 执行 | minimax |
| 依赖 | T37 |
| 分支 | `task/T36-history-panel-v3` |
| 关联 issue | #26、#27 |

## 目标

历史成为左侧导航的一级入口；主路径平铺不缩进，分支只在分叉处标出并可展开；点任意一条就跳到那一步。

## 先读

- `AGENTS.md`
- `docs/kernel-v3/04-canvas.md` §5
- `docs/kernel-v3/02-commands-and-tools.md` §3.2（`sand_history` 的输出：`current`、`onCurrentPath`、`parentId`）
- `workbench/board/HistoryPanel.tsx`、`history-layout.ts`、`history.css`（现有面板）
- 外壳的面板容器（T37 产物）

## 开工前核对

确认 T37 已合并，左侧导航里预留了“历史”入口；`app_history list` 的输出与 `02` 一致。不一致先停下来问。

## 可改文件

- `workbench/board/HistoryPanel.tsx`、`workbench/board/history-layout.ts`、`workbench/board/history.css`
- 外壳里挂载历史面板的那一处（T37 的导航配置文件）
- `workbench/tests/history-layout.test.ts`、`workbench/tests/blank.ts`

## 不要做

- 不改历史的数据和撤销规则。

## 做法

1. **`history-layout.ts`** 改成：输入 `sand_history list` 的条目，输出要显示的行：

   ```ts
   type Row =
     | { kind: "entry"; id: string; indent: 0 | 1; state: "current" | "past" | "redo" | "branch" }
     | { kind: "branches"; atId: string; count: number; expanded: boolean };
   ```

   - 当前路径（`onCurrentPath` 为真）的条目 `indent = 0`，按 `seq` 排列。
   - 某条当前路径上的记录有不在当前路径上的子记录时，在它后面插一行 `branches`；展开后列出各分支起点及其后续，`indent = 1`，分支内部不再缩进。
   - 绝不按 `parentId` 链长累计缩进。
2. 面板顶部：撤销、重做按钮（不可用时置灰并说明原因）。
3. 每条显示：标签（过长省略，悬停显示全文）、人 / Agent 标记、时间、状态标签（当前、可重做、旧分支）。
4. 点击条目 → `app_history jump`；跳转失败（`HISTORY_CONFLICT`）时在面板顶部显示原因。
5. 键盘：上下移动、回车跳转、`→` / `←` 展开 / 收起分支。

## 验收

- `workbench/tests/history-layout.test.ts`：40 条直线历史全部 `indent = 0`；撤销 3 步后新编辑，分叉处出现 `branches` 行且计数为 1；展开后分支条目 `indent = 1`。
- `workbench/tests/blank.ts`：从左侧导航打开历史；连续拖动 30 次后无横向滚动；撤销 2 步再新编辑后，点“1 个分支”展开，点旧分支最后一条，画布恢复成那时的样子。
- `npm run format:check`、`npm run typecheck`、`npm test`、`npm run test:blank` 全部通过。
