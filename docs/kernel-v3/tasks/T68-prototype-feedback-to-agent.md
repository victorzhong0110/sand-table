# T68 原型元素批注交给宿主 Agent 修改

| 项 | 内容 |
|---|---|
| 执行 | grok |
| 依赖 | T53、T55、T64 |
| 分支 | `task/T68-prototype-feedback-to-agent` |
| 关联 issue | #41 第三阶段、#42 |

## 目标

在运行中的交互原型上点选一个元素写批注（“这个按钮改成蓝色”），点“交给 AI 修改”，宿主 Agent 收到原型、版本、元素位置和批注，改完写回原型的新版本；白板自动打开新旧两版的比较。没有能执行任务的宿主时，不显示这个按钮。

## 先读

- `AGENTS.md`
- issue #41、#42
- `docs/kernel-v3/03-types-and-extensions.md` §10（锚点格式）
- `workbench/board/design/`（T55）、`workbench/board/anchors/`（T53）、`workbench/board/compare/`（T52）、`workbench/board/rules/execute.ts`（T64 的任务提交）

## 开工前核对

确认 T64 已合并且真机可用；ADR 0005 的原型消息协议里能加“元素选取”消息。不一致先停下来问。

## 可改文件

- `docs/kernel-v3/03-types-and-extensions.md`（§10 加一行：原型元素锚点 `el=<CSS 选择器>;quote=<元素文字前 64 字>`）
- `workbench/board/anchors/fragment.ts`（支持新格式）
- `workbench/board/design/PrototypeView.tsx`、`sandbox.ts`（运行模式下按住 Alt 点击元素，原型回传选择器和文字）
- 新建 `workbench/board/design/feedback.ts`
- 新建 `workbench/tests/prototype-feedback.test.ts`，修改 `workbench/tests/host-browser.ts`

## 不要做

- 原型不直接调用任何 AI；修改只经由宿主任务。
- 不自动接受 Agent 的修改：新版本出来后由人看比较决定是否保留（不保留就撤销那一步）。

## 做法

1. **选元素**：运行模式下按住 Alt 点击原型里的元素，原型通过协议回传 CSS 选择器和文字；生成锚点，打开批注输入（T51 的批注，锚点放在关系的 `attributes.anchor`）。
2. **交给 AI**：批注旁的“交给 AI 修改” → 宿主任务（说明：批注正文；目标：原型对象 id 与版本；附锚点）。没有 `taskSubmit` 时按钮不显示。
3. **写回**：Agent 用 `sand_edit` 更新原型对象，`intentId` 用 `feedback:<批注 id>`。
4. **比较**：任务完成后自动在原型旁打开比较组件（T52），固定左侧为提交时的版本、右侧为新版本。
5. **锚点失效**：新版本里找不到该元素时，批注标失效（T53 的规则）。

## 验收

- `workbench/tests/prototype-feedback.test.ts`：新锚点格式往返；任务请求的组装。
- `workbench/tests/host-browser.ts`（夹具）：选元素 → 写批注 → 交给 AI → 夹具写回新版本 → 出现比较且左右版本正确；没有 `taskSubmit` 时按钮不出现。
- 在真实宿主上手动走一遍，步骤和截图写进 PR 描述。
- `npm run format:check`、`npm run typecheck`、`npm test`、`npm run test:host` 全部通过。
