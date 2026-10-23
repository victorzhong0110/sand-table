# T33 进入与返回

| 项 | 内容 |
|---|---|
| 执行 | minimax |
| 依赖 | T30 |
| 分支 | `task/T33-enter-return-navigation` |
| 关联 issue | #25（§2 连续导航） |

## 目标

双击可进入的组件，从它所在的位置连续地进入内部白板；返回时连续地收回到进入时的那一处，恢复原来的视角和选择。动画随时可被打断，开启“减少动态效果”时直接切换。

## 先读

- `AGENTS.md`
- `docs/kernel-v3/05-delivery-contracts.md`（本阶段公共契约与交接规则）
- `docs/kernel-v3/04-canvas.md` §3
- `docs/kernel-v3/01-data-model.md` §4（`views.nav_stack`）
- issue #25 的 §2（动效原则）
- `workbench/board/canvas/`（T30 产物）、`workbench/board/camera-motion.ts`（现有镜头动画，可复用其中的缓动函数）

## 开工前核对

确认 T30 已合并，`app_view` 支持 `navigate` 并能读写 `nav_stack`。依赖未完成则等待；机械差异按 05 §1 适配，语义冲突只暂停受影响部分。

## 可改文件

- 新建 `workbench/board/canvas/navigation.ts`（纯函数：路径、返回目标、动画参数）、`workbench/board/canvas/Breadcrumbs.tsx`
- `workbench/board/canvas/FlowCanvas.tsx`、`workbench/board/camera-motion.ts`
- 新建 `workbench/tests/navigation.test.ts`，修改 `workbench/tests/blank.ts`

## 不要做

- 不在一张画布里嵌套渲染子白板。
- 不做搜索跳转（外壳的事，T37）。

## 做法

1. **进入**（双击可进入的组件，或选中后按 `⌘↓`）：
   - 把 `{ boardId, camera, selection, enteredFrom: presentationId }` 压入 `nav_stack`。
   - 动画：镜头在 240ms 内放大到该组件填满可用画布，然后切换到内部白板，内部白板从相同的屏幕矩形展开到 `fitView`（或上次视口）。
2. **返回**（工具栏返回按钮、面包屑、`⌘↑` / Windows `Alt+↑`）：
   - 弹出栈顶，切回父白板；内部视图收缩到 `enteredFrom` 那个展示的位置，然后恢复栈里记下的视角和选区。
   - `enteredFrom` 那个展示已被删除或移到别的白板：直接恢复栈里记下的视角，不做收缩动画。
   - 同一个对象在父白板上有多处展示时，回到**进入时的那一处**，不是任意一处。父白板也已删除时按 04 §3 回退到最近存活祖先，最终回首页。
3. **面包屑**：显示从首页到当前白板的路径（来自 `nav_stack`），点击任何一级直接返回到那一级。
4. **打断**：动画进行中用户拖动、滚轮、点击、再次导航，立即停止动画并从当前状态继续，不排队。
5. **减少动态效果**：时长为 0。
6. **遮挡感知定位**（选中视口边缘或被浮动面板挡住的组件时）：把它平移到“未被面板遮挡的可用区域”中央；已经完全可见的不移动；能平移解决就不缩放。面板占据的区域由外壳提供（先用固定数值，T37 接上真实值）。

## 验收

- `workbench/tests/navigation.test.ts`：路径计算；返回目标选择（多处展示、来源已删除两种情况）；可用区域中心计算。
- `workbench/tests/blank.ts`：
  1. 进入子白板再返回，视角和选区与进入前相同。
  2. 同一子白板在父白板上放两份，从第二份进入，返回时镜头停在第二份附近。
  3. 进入后在另一个窗口删掉来源展示，返回不报错，视角恢复。
  4. 动画进行中按 Escape 或拖动，动画停止，界面可用。
  5. 开启减少动态效果后，进入、返回没有过渡（断言过渡时长为 0）。
- `npm run format:check`、`npm run typecheck`、`npm test`、`npm run test:blank` 全部通过。

## 交接与边界验收

来源失效只过滤 selection；父白板失效按 04 §3 回退。提供 focusObject(objectId,{returnTo?}) 给搜索/关系图/链接；当前板多展示选最近可见者，其他板展示列表供人选择，无展示打开详情。测试导航→返回保持原位置。
