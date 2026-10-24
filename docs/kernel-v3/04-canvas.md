# 内核 v3：画布与操作

依据：`00-decisions.md` 的 K7。对应 issue #25（外壳与导航）、#26（历史面板呈现）、#29（拖动闪烁）、#30（操作体系）。
本文属于 Phase 3。Phase 0 在 v2 画布上做的是最小修复，不按本文实现。

## 1. 结构

- 每块进入的白板渲染一个 `<ReactFlow>`（`@xyflow/react`）。进入子白板就换成子白板的内容，不在一张画布里嵌套渲染。
- 数据来源：`app_board` 首次加载，之后用 `app_changes` 增量合并（见 `01-data-model.md` §6）。React Flow 只是视图，不保存任何权威状态。
- 节点：每个未删除的展示一个节点。

```ts
{
  id: presentation.id,
  type: spec.display.view ?? "generic",   // 自定义视图名或通用视图
  position: { x: presentation.x, y: presentation.y },
  width: presentation.width,
  height: presentation.height,
  parentId: presentation.parentId ?? undefined,  // 框内的展示
  zIndex: presentation.z,
  draggable: !presentation.locked,
  data: { objectId: presentation.objectId },
}
```

- 连线：白板上两端对象都有展示的关系，各画一条边。设置里可以关闭关系显示。
- 折叠档位（`appearance.detail`）：`label` 和 `icon` 只改变节点的渲染尺寸和内容，**不修改**存储的 `width` / `height`；展开后恢复。
- 白板内展示超过 200 个时开启 `onlyRenderVisibleElements`。

## 2. 写回规则

| 交互 | React Flow 事件 | 写入 |
|---|---|---|
| 拖动中 | `onNodesChange`（position） | 只更新本地节点状态，不写库 |
| 拖动结束 | `onNodeDragStop` | 一次 `app_edit`：被拖动的全部展示的 `presentation.update`，一个新的 `intentId` |
| 调整尺寸结束 | `NodeResizer` 的 `onResizeEnd` | 一次 `app_edit` |
| 删除键 | `onNodesDelete` | 一次 `app_edit`：`presentation.delete`（只移除展示，不删对象） |
| 从节点把手拖到另一节点 | `onConnect` | 弹出关系类型选择（按两端类型过滤注册表），选中后 `relation.create` |
| 选择变化 | `onSelectionChange` | `app_view` `select`，300ms 防抖，不进历史 |
| 视角变化 | `onMoveEnd` | `app_view` `camera`，500ms 防抖，不进历史 |

- 选中即可拖动、调整尺寸、删除，不需要切换任何模式（取消 v2 的“编排模式”）。
- 锁定的展示不能拖动和调整尺寸；解锁在右键菜单和属性面板里。
- 节点内部的输入框、编辑器、媒体控件加 `nodrag nowheel nopan` 类名，避免和画布拖动、滚轮缩放冲突。

## 3. 双击与进入

- 类型声明了 `container`：双击进入它的内部白板。进入前把当前白板和视角压入 `views.nav_stack`。
- 其他类型：双击执行类型的主操作。通用视图的主操作是打开编辑表单；便签和标题是就地编辑；媒体是打开查看器。
- 返回：工具栏的返回按钮、面包屑、快捷键 `Alt+↑`（Mac 为 `⌘+↑`）。返回时恢复进入前的视角和选区。进入来源展示已删除或移走时，返回父白板并恢复栈内视角，过滤失效选区，不做收缩动画；父白板也已删除时逐级回退到最近存活祖先，最终回到首页白板。这是已确定的设计变更（见 `00-decisions.md`「来源消失后的返回」），替换原先的「把视角定位到中心」。实现按本句，不要改回，也不要再问。
- 动画：用 `setViewport(..., { duration })`，短距离 240ms，长距离最长 600ms；开启“减少动态效果”时 `duration = 0`。任何新的拖动、滚轮或导航立即打断正在进行的动画。

## 4. 快捷键

焦点在输入框、文本区域或可编辑区域内时，下列快捷键一律不响应（沿用 v2 `board/main.tsx` 的判断）。Windows 上把 ⌘ 换成 Ctrl。

| 快捷键 | 行为 |
|---|---|
| `Delete` / `Backspace` | 移除选中的展示 |
| `⌘Z` / `⇧⌘Z`（也接受 `⌘Y`） | 撤销 / 重做 |
| `⌘A` | 选中当前白板全部展示 |
| `⌘D` | 再放一份展示（同一对象，位置偏移 24px） |
| `⇧⌘D` | 复制出独立对象并放在旁边 |
| `⌘C` / `⌘V` | 复制 / 粘贴展示（粘贴 = 引用同一对象） |
| `⇧⌘V` | 粘贴为独立副本（右键菜单里也有） |
| `⌘↓` / `⌘↑`（Windows：`Alt+↓` / `Alt+↑`） | 进入选中的白板 / 返回上一级 |
| 方向键 / `⇧`+方向键 | 移动 1px / 10px；停止按键 500ms 后作为一步写入 |
| `Enter` | 编辑选中的组件 |
| `Escape` | 依次：退出编辑 → 取消选择 |
| `⌘0` / `⌘=` / `⌘-` | 缩放复位 / 放大 / 缩小 |
| `?` | 打开快捷键说明 |

## 5. 历史面板

- 历史是侧边栏的一级入口（#25、#27），不放在工具抽屉里。
- 呈现规则（#26）：
  - 当前路径（从最早记录到游标，再到可重做的记录）排成**一列，同一左边界，不缩进**。
  - 某条记录有不在当前路径上的子记录时，在它旁边显示“N 个分支”标记，点开后在下方缩进**一级**列出分支起点，分支内部同样不再逐级缩进。
  - 绝不按 `parentId` 链长累计缩进。
- 每条记录显示：标签、人 / Agent 标记、时间、“当前”“可重做”状态。点击跳转（`app_history` `jump`）。

## 6. 外壳

外壳与视觉按 #25 执行：左侧窄导航（白板、组件、历史、设置、帮助）、圆角浮动面板、画布占主导。删除本地宿主页顶部的“本地会话 / 连接我的 AI / 重新打开白板”栏，连接说明移到“帮助”，重新连接只在出错时出现。具体任务卡在 Phase 3 开始前编写。
