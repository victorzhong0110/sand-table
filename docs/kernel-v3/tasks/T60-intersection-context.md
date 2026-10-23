# T60 交叉情境

| 项 | 内容 |
|---|---|
| 执行 | minimax |
| 依赖 | T34、T49 |
| 分支 | `task/T60-intersection-context` |
| 关联 issue | #35 第一阶段 |

## 目标

“林舟 × 第五章”“林舟 × 老师 × 第五章”这样的多方交叉，成为一个可以保存、可以进入的白板：它明确引用这几个参与对象，各自保持独立身份；在里面能看到“同时和这几方都有关的内容”作为**建议**；在里面新建的内容默认关联到这几方，但关联是可见、可去掉的。查询永远不凭空创造事实。

## 先读

- `AGENTS.md`
- `docs/kernel-v3/05-delivery-contracts.md`（本阶段公共契约与交接规则）
- issue #35
- `docs/kernel-v3/03-types-and-extensions.md` §4（关系槽）
- `docs/kernel-v3/02-commands-and-tools.md` §3.2（`sand_query`）
- `workbench/kernel/read.ts`（`query`）

## 开工前核对

确认 `query` 支持 `relatedTo`，通用视图支持关系槽（T34）。依赖未完成则等待；机械差异按 05 §1 适配，语义冲突只暂停受影响部分。

## 可改文件

- `workbench/packs/base/index.ts`（新增类型 `base.context`，`container: true`；新增关系类型 `base.involves`）
- `workbench/kernel/read.ts`（`query` 加 `relatedToAll`）、`workbench/server/core-tools.ts`（`sand_query` 加同名参数）
- `docs/kernel-v3/02-commands-and-tools.md`（§3.2 `sand_query` 参数里加 `relatedToAll`）
- 新建 `workbench/board/context/`（`ContextPanel.tsx`、`defaults.ts`）
- 新建 `workbench/tests/context.test.ts`，修改 `workbench/tests/blank.ts`

## 不要做

- 不自动建立任何关系；建议列表里的内容只有用户拖进来时才新增**展示**，不新增关系。
- 不做时间、分支、观察者情境（T61）。

## 做法

1. **`base.context`**：标题如“林舟 × 第五章”；关系槽 `participants`（`base.involves`，`out`，`many: true`，至少 2 个才有意义，少于 2 个时卡片提示）。新建时如果用户选中了几个对象，自动把它们作为参与者，标题按“A × B × C”生成（可改）。
2. **`relatedToAll`**：`query` 的新过滤条件，返回与列表中**每一个**对象都有直接关系（任一方向、任一类型）的对象，排除参与者自身和交叉情境对象。
3. **进入交叉情境**（它是一块白板）：
   - 白板上是用户放进来的内容（普通展示）。
   - 侧边“符合这次交叉的内容”面板：`relatedToAll(参与者)` 的结果；每条显示它和每个参与者的关系；可拖进白板（只新增展示）。结果为空时显示“没有同时关联这几方的内容”，不显示任何推测。
4. **默认关联**（`defaults.ts`）：在交叉情境白板里新建对象时，表单顶部显示“将关联到：林舟、第五章”标签，可逐个去掉；保存时在同一次 `app_edit` 里建 `base.related` 关系（新对象 → 每个保留的参与者；仅表示“相关”，不冒充参与或因果）。拖入已有对象**不**自动建关系。
5. **从参与者出发找交叉**：人物或章节的详情里列出“它参与的交叉情境”。

## 验收

- `workbench/tests/context.test.ts`：`relatedToAll` 在 2 方、3 方、无结果、含推测关系几种情况下的结果。
- `workbench/tests/blank.ts`：
  1. 选中林舟和第五章建交叉情境，标题为“林舟 × 第五章”，两个对象仍是原来的 id。
  2. 一个事件同时关联林舟和第五章，它出现在建议面板；只关联林舟的事件不出现。
  3. 把建议拖进白板后，关系数量不变。
  4. 在交叉情境里新建便签，默认关联两方；去掉“第五章”后保存，只建一条关系。
  5. 在第五章的详情里能找到这个交叉情境。
- `npm run format:check`、`npm run typecheck`、`npm test`、`npm run test:blank` 全部通过。

## 交接与边界验收

base.context/base.involves 及 relatedToAll 参数同步 03/02；结果按稳定 id 分页，默认 50 最大 200。使用 base.related 的默认关联只表示相关，不能让新建图表/人物误变成“讲解者”；建议须显示推测标签。
