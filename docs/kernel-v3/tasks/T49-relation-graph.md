# T49 关系图视图

| 项 | 内容 |
|---|---|
| 执行 | minimax |
| 依赖 | T40、T72、T33 |
| 分支 | `task/T49-relation-graph` |
| 关联 issue | #40 |

## 目标

一个“关系图”组件：选几个对象作为中心，自动画出它们之间、以及向外若干层的已声明关系；可以按关系类型筛选、展开、点击定位到原对象。它只是同一份关系事实的另一种呈现，**拖动图里的节点不会创建或改变任何关系**。

## 先读

- `AGENTS.md`
- `docs/kernel-v3/05-delivery-contracts.md`（本阶段公共契约与交接规则）
- issue #40
- `docs/kernel-v3/03-types-and-extensions.md` §4、§9
- `docs/adr/0002-bundle-loading.md`
- `workbench/board/views/bindings.ts`（T40）、`workbench/board/canvas/`（T30，图内可以复用 React Flow 做只读渲染）

## 开工前核对

确认 T40 已合并，`Bindings` 可用；`sand_query` 支持 `relatedTo`。依赖未完成则等待；机械差异按 05 §1 适配，语义冲突只暂停受影响部分。

## 可改文件

- `workbench/packs/base/index.ts`（新增类型 `base.relation_graph` 和关系类型 `base.graph_focus`）
- 新建 `workbench/board/graph/`（`GraphView.tsx`、`layout.ts`、`expand.ts`）
- `workbench/board/views/registry.ts`
- `workbench/kernel/bindings.ts`（如需按关系展开的有界查询，只能在这里加）
- `workbench/package.json`、`workbench/package-lock.json`（布局库，见下）
- 新建 `workbench/tests/relation-graph.test.ts`，修改 `workbench/tests/blank.ts`

## 不要做

- 不新建任何“图专用”的事实数据：节点和边全部来自 `relations` 表。
- 不用 EPL、GPL 等需要额外义务的许可证的布局库。

## 依赖

布局库优先 `dagre`（MIT）；若不满足，在 PR 里说明并改用其他 MIT / Apache 许可的库。版本写死。

## 做法

1. **`base.relation_graph`**：数据 `{ depth: 1 | 2 | 3（x-sand-default 1）, kinds?: string[], layout: "layered" | "radial" }`，关系槽 `focus`（`base.graph_focus`，`many: true`）指向中心对象。
2. **展开**（`expand.ts`）：从中心对象出发，沿 `relations` 向外 `depth` 层，只走 `kinds` 里的关系类型（不填就全部），最多 200 个节点；超过时停止并显示“还有更多，缩小范围或减少层数”。推测关系（`inferred`）用虚线并标注。
3. **渲染**：卡片里一个只读的小画布；节点显示对象标题和类型图标，边显示关系名。节点可拖动调整图内位置，位置只存在当前界面会话缓存中（按组件 id、节点 id 索引，不写对象数据；重新打开重新布局），与关系无关。
4. **交互**：点节点 → 在白板上定位到该对象的展示（没有展示就打开只读详情）；双击节点 → 把它加入中心；关系类型筛选在卡片的设置里。
5. **订阅**：中心对象或沿途关系变化时更新。

## 验收

- `workbench/tests/relation-graph.test.ts`：展开层数、类型过滤、200 上限、环路不重复。
- `workbench/tests/blank.ts`：
  1. 三个人物、两条关系，以其中一个为中心建关系图，显示正确的节点和边。
  2. 在图里拖动节点后，服务端关系数量不变。
  3. 在别处删除一条关系，图在 2 秒内更新。
  4. 点击图中节点，镜头定位到白板上的对应卡片。
- `npm run format:check`、`npm run typecheck`、`npm test`、`npm run test:blank` 全部通过。

## 交接与边界验收

按 05 §4 交付 expandBindings 工具和界面服务；追加服务侧范围测试，禁止从图视图随意调用 sand_query 遍历全库。布局只存会话，不在 data.positions 存对象 ID。
