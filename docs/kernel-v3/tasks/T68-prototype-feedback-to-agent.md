# T68 原型元素批注交给宿主 Agent 修改

| 项 | 内容 |
|---|---|
| 执行 | minimax |
| 依赖 | T53、T55、T64、T65、T52 |
| 分支 | `task/T68-prototype-feedback-to-agent` |
| 关联 issue | #41 第三阶段、#42 |

## 目标

在运行中的交互原型上点选一个元素写批注（“这个按钮改成蓝色”），点“交给 AI 修改”，宿主 Agent 收到原型、版本、元素位置和批注，生成新的候选原型对象；白板自动打开原对象与候选的比较，人接受后才写回原对象。没有能执行任务的宿主时，不显示这个按钮。

## 先读

- `AGENTS.md`
- `docs/kernel-v3/05-delivery-contracts.md`（本阶段公共契约与交接规则）
- issue #41、#42
- `docs/kernel-v3/03-types-and-extensions.md` §10（锚点格式）
- `workbench/board/design/`（T55）、`workbench/board/anchors/`（T53）、`workbench/board/compare/`（T52）、`workbench/board/rules/client.ts`（T64 的任务提交）

## 开工前核对

确认 T64 已合并且真机可用；ADR 0005 的原型消息协议里能加“元素选取”消息。依赖未完成则等待；机械差异按 05 §1 适配，语义冲突只暂停受影响部分。

## 可改文件

- `docs/kernel-v3/03-types-and-extensions.md`（§10 加一行：原型元素锚点 `el=<CSS 选择器>;quote=<元素文字前 64 字>`）
- `workbench/board/anchors/fragment.ts`（支持新格式）
- `workbench/board/design/PrototypeView.tsx`、`sandbox.ts`（运行模式下按住 Alt 点击元素，原型回传选择器和文字）
- 新建 `workbench/board/design/feedback.ts`
- 新建 `workbench/tests/prototype-feedback.test.ts`，修改 `workbench/tests/host-browser.ts`

## 不要做

- 原型不直接调用任何 AI；修改只经由宿主任务。
- 不自动接受 Agent 的修改：候选出来后由人看比较决定是否接受；拒绝只移除候选展示，不使用全局撤销。

## 做法

1. **选元素**：运行模式下按住 Alt 点击原型里的元素，原型通过协议回传 CSS 选择器和文字；生成锚点 `{ fragment }`（`el=...;quote=...`，可加 fingerprint），打开批注输入（T51 的批注，锚点放在关系的 `attributes.anchor`）。锚点里不写 uri，不写对象 id。
2. **交给 AI**：批注旁的“交给 AI 修改” → 宿主任务（说明：批注正文；目标：原型对象 id 与版本，对象 id 只放在这个目标字段；附锚点）。没有 `taskSubmit` 时按钮不显示。
3. **候选**：Agent 用 `sand_edit` 创建新原型对象，保留原对象及版本不动，`intentId` 用 `feedback:<批注 id>`；接受时带原对象 expectedVersion 更新，冲突先重新比较。
4. **比较**：任务完成后自动在原型旁打开比较组件（T52），左侧绑定原对象并固定提交时版本，右侧绑定候选对象及其版本。
5. **锚点失效**：新版本里找不到该元素时，批注标失效（T53 的规则）。

## 验收

- `workbench/tests/prototype-feedback.test.ts`：新锚点格式往返；任务请求的组装。
- `workbench/tests/host-browser.ts`（夹具）：选元素 → 写批注 → 交给 AI → 夹具写回新版本 → 出现比较且左右版本正确；没有 `taskSubmit` 时按钮不出现。
- 在真实宿主上手动走一遍，步骤和截图写进 PR 描述。
- `npm run format:check`、`npm run typecheck`、`npm test`、`npm run test:host` 全部通过。

## 交接与边界验收

端到端测试：提交后人修改原对象→候选完成→接受被版本冲突拒绝；拒绝候选不撤销人的编辑。元素选择器只用于定位、不拼可执行代码，歧义/找不到标失效。
