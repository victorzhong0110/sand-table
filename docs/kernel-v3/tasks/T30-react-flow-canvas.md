# T30 React Flow 画布接入

| 项 | 内容 |
|---|---|
| 执行 | grok |
| 依赖 | T24 |
| 分支 | `task/T30-react-flow-canvas` |
| 关联 issue | #29、#30 |

## 目标

用 React Flow 替换自写画布 `SpaceCanvas`：渲染、选中、拖动、调整尺寸、删除、连线、视口都交给它，数据仍以内核为准。完成后删除 `SpaceCanvas.tsx`。

## 先读

- `AGENTS.md`
- `docs/kernel-v3/05-delivery-contracts.md`（本阶段公共契约与交接规则）
- `docs/kernel-v3/04-canvas.md` §1、§2
- `docs/kernel-v3/02-commands-and-tools.md` §3.4（`app_board`、`app_changes`、`app_edit`、`app_view`）
- `docs/kernel-v3/01-data-model.md` §4（`presentations`，注意 `parent_id` 非空时坐标是相对父框的）
- 界面数据缓存（T21 的 `store.ts`；T24 之后的位置以 `main` 为准）
- `workbench/board/SpaceCanvas.tsx`、`workbench/board/main.tsx`

## 开工前核对

确认：T24 已合并（`main` 上没有 `SAND_KERNEL`）；界面已通过 `app_board` / `app_changes` 取数据、通过 `app_edit` / `app_view` 写入。任何一项不成立，先停下来在 PR 里写“需要架构确认”。

## 可改文件

- 新建 `workbench/board/canvas/`（`FlowCanvas.tsx`、`nodes.tsx`、`edges.tsx`、`mapping.ts`）
- `workbench/board/main.tsx`、`workbench/board/CanvasShell.tsx`（换掉画布组件的引用）
- 删除 `workbench/board/SpaceCanvas.tsx` 及只被它使用的代码
- `workbench/board/style.css`（只删画布旧样式、加新画布样式）
- `workbench/package.json`、`workbench/package-lock.json`（加依赖）
- `workbench/tests/blank.ts`、新建 `workbench/tests/canvas-mapping.test.ts`

## 不要做

- 不做多选以外的快捷键、复制粘贴、对齐、右键菜单（T31、T32）。
- 不做进入、返回动画（T33）。
- 节点内容先沿用现有组件渲染（通过 T21 的适配层），通用视图是 T34 的事。
- 不在 React Flow 的状态里保存任何权威数据。

## 依赖

`@xyflow/react`：用 `npm view @xyflow/react version` 查当前版本，写死。MIT 许可，在 PR 里写明版本和许可。

## 做法

1. **`mapping.ts`**（纯函数，便于单测）：展示 → 节点、关系 → 连线，规则照 `04-canvas.md` §1。框内展示设置 `parentId`，坐标直接用存储的相对坐标。折叠档位 `label` / `icon` 只改渲染尺寸，不改存储的宽高。
2. **写回**：照 `04-canvas.md` §2 的表格。拖动中只改本地节点；`onNodeDragStop` 时一次 `app_edit`，一个新 `intentId`，包含所有被拖动的展示。尺寸用 `NodeResizer`，结束时写回。删除键走 `onNodesDelete` → `presentation.delete`。连线走 `onConnect` → 弹出关系类型选择（用 `sand_types` 返回的关系类型，按两端类型过滤）→ `relation.create`。
3. **选择与视口**：`onSelectionChange` 防抖 300ms 后 `app_view select`；`onMoveEnd` 防抖 500ms 后 `app_view camera`。打开白板时恢复上次视口，没有就 `fitView`。
4. 展示超过 200 个时开启 `onlyRenderVisibleElements`。
5. 节点内的输入框、可编辑区域加 `nodrag nowheel nopan`。
6. 服务端数据变化（增量同步）时更新节点；正在拖动的节点不被服务端旧位置拉回。

## 验收

- `workbench/tests/canvas-mapping.test.ts`：展示与关系映射成节点和连线；框内坐标；折叠档位不改存储尺寸；被删除的展示不出现；两端不都在本白板的关系不画。
- `workbench/tests/blank.ts`：
  1. 拖动一张卡片后历史只多一条记录，位置与松手处一致；撤销回到原处。
  2. 拖动过程中卡片 DOM 节点不被卸载（沿用 T05 的 `dataset.probe` 做法）。
  3. 拉右下角把手改变尺寸后，服务端尺寸变化。
  4. 选中按 Delete：展示消失，对象仍能用 `sand_read` 读到。
  5. 从一张卡片拖线到另一张，选“相关”，服务端多一条 `base.related` 关系。
  6. 关闭再打开白板，视口与关闭前一致。
  7. 在卡片里的输入框打字、用中文输入法，不会拖动卡片。
- 在 PR 描述里写：构建后 `board.html` 的体积变化。
- `npm run format:check`、`npm run typecheck`、`npm test`、`npm run test:blank` 全部通过。

## 交接与边界验收

空白新工作空间的首页不 fitView 到示例对象；主画布禁止页面整体滚动。拖动冲突不吞错误，恢复权威位置并提示。关系有多份展示时每个端点取当前选择优先、否则 id 排序第一份，避免笛卡尔积连线；确定规则写入 mapping 单测。
