# T04 重新打开白板不再沉默白屏

| 项 | 内容 |
|---|---|
| 执行 | grok |
| 依赖 | 无 |
| issue | #28 |
| 分支 | `task/T04-reopen-blank-screen` |

## 目标

点“重新打开白板”（改名为“重新连接”）时，界面始终有可解释的状态：加载中有提示，失败或超时有原因和重试按钮，绝不出现长时间纯空白。

## 现状与线索

`workbench/local/client.ts` 的 `mount()`：

1. `const frame = old.cloneNode()`，`old.replaceWith(frame)`；
2. 建 `AppBridge`，`bridge.connect(new PostMessageTransport(frame.contentWindow, ...))`；
3. 最后 `frame.srcdoc = resource...`。

已知：数据没丢，按 F5 能恢复；无头浏览器复现不了。

架构负责人的推测（**需要你验证，不要直接当结论**）：`cloneNode()` 会把旧 iframe 的 `srcdoc` 属性一起复制，新 iframe 插入文档的瞬间就开始加载**旧文档**，旧文档在桥接还没连上时发出初始化消息；随后第 3 步再次赋值 `srcdoc`，若字符串与原值相同，部分浏览器可能不重新加载，导致界面停在一个没有完成握手的文档上。

另外，“iframe 加载了但 React 没渲染出来”不是异常路径，`showError` 不会被调用，所以失败时什么提示都没有。

## 先读

- `AGENTS.md`
- `workbench/local/client.ts`（`mount`、`connect`、`showError`、`new-board` 按钮）
- `workbench/local/service.ts`（顶栏 HTML、`#error`、`#retry`）
- `workbench/tests/local.ts`、`workbench/tests/recovery-browser.ts`

## 可改文件

- `workbench/local/client.ts`
- `workbench/local/service.ts`
- `workbench/tests/local.ts` 或 `workbench/tests/recovery-browser.ts`（选一个，或新建 `workbench/tests/reopen-browser.ts` 并在 `workbench/package.json` 加一个 `test:reopen` 脚本、在 `.github/workflows/workbench.yml` 里加一步运行它）

## 不要做

- 不改白板应用本身（`board/`）。
- 不把整页改成局部刷新（那是更大的改动，不在本卡）。
- 不加只在测试环境生效的后门开关；失败场景用 Playwright 的 `page.route` 拦截请求来模拟。

## 做法

1. 先验证上面的推测：在 Chromium 和你能用的另一个浏览器里，连续点“重新打开白板”，记录是否出现白屏。把观察写进 PR 描述。
2. `mount()` 不再 `cloneNode()`，改为 `document.createElement("iframe")`，只设置 `title` 和 `sandbox="allow-scripts"`，保证新 iframe 不带旧 `srcdoc`。
3. 加载状态：`mount()` 开始时显示一层覆盖在白板区域上的提示“正在打开白板…”；收到桥接的 `oninitialized` 并发出工具结果后隐藏。
4. 超时：15 秒内没有完成第 3 步，隐藏加载提示，用现有 `#error` 显示“白板没有加载出来。数据已保存在本机，可以点「重新连接」再试。”，并显示 `#retry`。
5. 顶栏按钮 `#new-board` 的文字改为“重新连接”。
6. 同时只允许一次 `mount()` 在进行：进行中再点按钮，忽略这次点击。

## 验收

- 浏览器测试：
  1. 连续点击“重新连接”5 次（每次间隔 200ms），最终白板内容正常显示（断言 iframe 内能找到白板的某个固定元素）。
  2. 用 `page.route` 让 `resources/read` 的响应返回一段不含白板应用的 HTML，15 秒内出现 `#error` 且文字包含“白板没有加载出来”，`#retry` 可见。
  3. 加载期间能看到“正在打开白板…”。
- `npm run format:check`、`npm run typecheck`、`npm test`，以及你修改或新增的浏览器测试全部通过。
- PR 描述写明：推测是否成立；若不成立，你找到的真实原因或仍未定位的部分。
