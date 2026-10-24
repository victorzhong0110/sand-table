# T51 评论与局部批注

| 项 | 内容 |
|---|---|
| 执行 | minimax |
| 依赖 | T34 |
| 分支 | `task/T51-comments` |
| 关联 issue | #41 第一阶段 |

## 目标

可以对任何组件写评论。评论有两种范围，界面上分得清：**共享评论**跟着对象走，对象在哪块白板上都能看到；**局部批注**只属于这一处展示，换一块白板就看不到。删除一处展示不会误删共享评论。

## 先读

- `AGENTS.md`
- `docs/kernel-v3/05-delivery-contracts.md`（本阶段公共契约与交接规则）
- issue #41
- `docs/kernel-v3/03-types-and-extensions.md` §4、§8.1
- `docs/kernel-v3/01-data-model.md` §8（删除语义）
- `workbench/board/views/`（T34 产物）

## 开工前核对

确认 T34 已合并；本卡负责新增 `base.comments_on` 和 `base.reply_to`。依赖未完成则等待；机械差异按 05 §1 适配，语义冲突只暂停受影响部分。

## 可改文件

- `workbench/packs/base/index.ts`（新增关系 `base.comments_on`、`base.reply_to`，属性和端点按 `05` §2；新增类型 `base.comment`：`body`（markdown）、`resolved`（布尔））
- 新建 `workbench/board/comments/`（`CommentBadge.tsx`、`CommentThread.tsx`、`scope.ts`）
- `workbench/board/views/GenericCard.tsx`（显示评论数标记）
- `workbench/board/style.css`
- 新建 `workbench/tests/comments.test.ts`，修改 `workbench/tests/blank.ts`

## 不要做

- 不做文字片段、PDF 区域、时间点上的批注（锚点是 T53）。
- 不做多人实时评论和通知。
- 校验实现允许修改 `kernel/commands.ts`、`kernel/types.ts`、注册表元 Schema 和对应测试；范围仅 `05` §2 的评论关系契约。

## 做法

1. **存储**：评论是 `base.comment` 对象，通过 `base.comments_on` 关系（评论 → 目标对象）挂上去。
   - 共享评论：`attributes.scope = "object"`。
   - 局部批注：`attributes.scope = "presentation"`，`attributes.presentationId` 写当前展示 id。
   评论对象本身不需要展示在白板上。
2. **显示**（`scope.ts` 是纯函数：给定一个展示，算出要显示的评论）：共享评论在该对象的所有展示上都显示；局部批注只在 `presentationId` 匹配的展示上显示。卡片右上角显示未解决评论数。
3. **评论面板**：点数字打开，按时间列出，每条标明“共享”或“仅此处”、作者（人 / Agent）、时间；可回复（回复也是评论，`base.reply_to` 指向父评论，范围继承根评论）、标记已解决、删除。
4. **新建**：评论面板底部输入框，旁边一个开关“仅此处”，默认共享。
5. **删除展示**：只删展示，它的局部批注保留（关系还在），在对象的“其他位置的批注”里仍可找到，不静默丢失。

## 验收

- `workbench/tests/comments.test.ts`：`scope.ts` 在共享、局部、回复几种情况下的结果。
- `workbench/tests/blank.ts`：
  1. 同一对象放在两块白板上；在 A 处写共享评论、在 A 处写局部批注；在 B 处只看到共享评论。
  2. 删除 A 处的展示后，局部批注对象仍在服务端，可以在对象详情里找到。
  3. 标记已解决后数字减少；撤销后恢复。
- `npm run format:check`、`npm run typecheck`、`npm test`、`npm run test:blank` 全部通过。

## 交接与边界验收

根/回复唯一关系与 scope 继承由内核校验，迁移/工具/手工 relation.create 均不能绕过。测回复环、目标不匹配、共享评论跨展示一致、局部批注展示移除后仍能访问。

## 交接与边界验收

详情查询允许读取关联墓碑以定位已删除目标，但不恢复关系、不扩大授权；回复根评论不可用时显示失效根，不能自动提升为共享评论。
