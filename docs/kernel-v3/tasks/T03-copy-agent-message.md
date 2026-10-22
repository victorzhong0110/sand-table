# T03 Agent 消息有独立复制按钮，不被覆盖

| 项 | 内容 |
|---|---|
| 执行 | minimax |
| 依赖 | 无 |
| issue | #31 |
| 分支 | `task/T03-copy-agent-message` |

## 目标

Agent 通过界面发来一条编排消息后，用户点一下就能原样复制；“复制当前选区提问”不会冲掉这条消息。

## 现状

- 本地宿主页的 HTML 在 `workbench/local/service.ts` 里（一个长模板字符串）。接入面板有 `#prompt`（只读文本框）和 `#ask`（“复制当前选区提问”）按钮；复制按钮只有 `data-copy="codex" | "json" | "toml"` 三个。
- `workbench/local/client.ts`：
  - `bridge.onmessage` 把 Agent 消息写进 `#prompt` 并打开面板，但没有复制入口。
  - `element("ask").onclick` 先用 `makePrompt(...)` **覆盖** `#prompt`，再复制。
  - `copy(id)` 是现成的复制函数，`[data-copy]` 按钮都用它。

## 先读

- `AGENTS.md`
- `workbench/local/service.ts` 中接入面板的 HTML
- `workbench/local/client.ts` 中 `bridge.onmessage`、`copy`、`element("ask").onclick`
- `workbench/tests/local.ts`（现有本地浏览器测试的写法）

## 可改文件

- `workbench/local/service.ts`
- `workbench/local/client.ts`
- `workbench/tests/local.ts`

## 不要做

- 不自动写入剪贴板（不在收到消息时自动复制）。
- 不改接入面板以外的界面。

## 做法

1. 在 `#prompt` 下方加按钮 `<button data-copy="prompt">复制这条消息</button>`，复用现有 `[data-copy]` 机制。
2. 新增一个只读文本框 `<textarea id="ask-text" readonly></textarea>`，放在 `#ask` 按钮上方，标签“选区提问”。
3. `element("ask").onclick` 改为把生成的提问写进 `#ask-text` 并复制 `#ask-text`，**不再修改 `#prompt`**。
4. `bridge.onmessage` 的提示文案改为：“AI 发来一条编排消息。点「复制这条消息」，再到你的 AI 客户端发送。”

## 验收

- `workbench/tests/local.ts` 增加断言：
  1. 模拟一次 `bridge.onmessage`（或用现有测试里触发 Agent 消息的方法），`#prompt` 内容等于消息原文。
  2. 点击“复制当前选区提问”后，`#prompt` 内容**不变**，`#ask-text` 有内容。
  3. 页面上存在 `data-copy="prompt"` 的按钮。
  （无头浏览器读不到剪贴板时，断言文本框内容即可，不要为此跳过测试。）
- `npm run format:check`、`npm run typecheck`、`npm test`、`npm run test:local` 全部通过。
