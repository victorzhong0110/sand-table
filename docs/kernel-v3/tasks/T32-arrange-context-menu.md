# T32 排列：对齐、层级、锁定、成框与右键菜单

| 项 | 内容 |
|---|---|
| 执行 | minimax |
| 依赖 | T30 |
| 分支 | `task/T32-arrange-context-menu` |
| 关联 issue | #30 |

## 目标

选中组件后能对齐、分布、调整前后层级、锁定和解锁、放进一个框或从框里拿出来；这些操作和“移除展示”“彻底删除对象”都能在右键菜单里找到。

## 先读

- `AGENTS.md`
- `docs/kernel-v3/04-canvas.md` §2
- `docs/kernel-v3/01-data-model.md` §4（`presentations` 的 `z`、`locked`、`parent_id`，以及框内坐标是相对坐标）、§8（删除语义）
- `docs/kernel-v3/02-commands-and-tools.md` §1.1
- `workbench/board/canvas/`（T30 产物）

## 开工前核对

确认 T30 已合并；`base.frame` 类型在内置包里存在。不一致先停下来问。

## 可改文件

- 新建 `workbench/board/canvas/arrange.ts`（纯函数）、`workbench/board/canvas/ContextMenu.tsx`
- `workbench/board/canvas/FlowCanvas.tsx`（接入菜单）
- `workbench/board/style.css`
- 新建 `workbench/tests/arrange.test.ts`，修改 `workbench/tests/blank.ts`

## 不要做

- 不做吸附、辅助线、精确坐标输入（后续再开卡）。
- 不改快捷键表（T31 负责）；本卡新增的操作只放在菜单里。

## 做法

1. **`arrange.ts`**：输入若干展示的矩形，输出每个展示的新 `x`、`y`。
   - 对齐：左、水平居中、右、上、垂直居中、下，以选区外框为基准。
   - 分布：水平、垂直等间距，至少 3 个才可用，首尾不动。
   - 框内展示参与计算前先换算成白板坐标，算完再换算回相对坐标。
2. **层级**：置顶（z = 当前白板最大 z + 1）、置底（最小 z − 1）、上移一层、下移一层。
3. **锁定**：`locked = true` 后不能拖动和调整尺寸（React Flow 的 `draggable` 为假），菜单里显示“解锁”。
4. **成框**：建一个 `base.frame` 对象和一个框展示，框的矩形是选区外框四周各留 24px；选中的展示 `parent_id` 指向框，坐标换算成相对坐标。**解除框**：子展示 `parent_id` 置空、坐标换回白板坐标，再移除框展示，框对象保留。全部在一次 `app_edit` 里。
5. **右键菜单**：
   - 在组件上：编辑、再放一份、复制为独立对象、对齐与分布（多选时）、层级、锁定 / 解锁、成框 / 解除框、移除展示、彻底删除对象。
   - 在空白处：粘贴、粘贴为独立副本、全选。
   - “彻底删除对象”先弹确认，写明“这个对象还出现在 N 块白板上，删除后都会消失；可以撤销”。N 用 `sand_read` 返回的展示数。
   - 菜单可用键盘上下移动、回车执行、Escape 关闭；关闭后焦点回到原组件。

## 验收

- `workbench/tests/arrange.test.ts`：六种对齐、两种分布（含 2 个时不可用）、框内坐标换算往返不变、层级计算。
- `workbench/tests/blank.ts`：
  1. 选 3 张卡片左对齐后 `x` 相同，撤销一次全部回去。
  2. 锁定后拖不动；解锁后能拖。
  3. 成框后三张卡片的 `parent_id` 指向框，屏幕位置不变；解除框后屏幕位置不变。
  4. 右键“移除展示”只删展示；“彻底删除对象”确认后对象被删除，撤销后对象和它在其他白板上的展示都回来。
  5. 菜单键盘操作可用。
- `npm run format:check`、`npm run typecheck`、`npm test`、`npm run test:blank` 全部通过。
