# ADR 0002：界面体积预算与按需加载

状态：已决定。T72 按本记录实现资源加载和 pdf.js worker。本记录不改产品构建、不改 CSP。

## 结论

按需加载用做法 B：大组件打成独立的经典 IIFE 脚本文本，界面通过宿主的 `resources/read` 取回文本，再用内联 `<script>` 注入。不使用 `script.src`，不使用网络、`blob:`、`data:` 或 `unsafe-eval`。

当前本地宿主还没有这条链路：服务端没有 chunk 资源，iframe 里的 `resources/read` 得到 JSON-RPC `-32601 Method not found`。做法 A（整份 `board.html` 内联）在本地宿主上能打开白板。Claude 桌面版、VS Code、Goose、ChatGPT、Postman 未测。未测宿主不算通过。超过主包上限的组件不能为了迁就未测宿主塞进主包，要等 T72 在该宿主验证 B 之后再接。

体积上限（Node `zlib.gzipSync` 默认级别 6）：

| 产物 | 原始字节 | gzip 字节 |
|---|---:|---:|
| 主包 `board.html` | ≤ 1100000 | ≤ 320000 |
| 每一个按需块 | ≤ 1600000 | ≤ 450000 |

从 T42 起，一个新依赖打进主包后带来的 gzip 增量超过 50000 字节，就必须走按需块，不能从白板入口 import。T30 的 React Flow 增量是 62186 字节 gzip，发生在加载器存在之前，主包上限已经把这份增量算进去。

pdf.js 6.4.299 不创建 `Worker`。先注入 worker 块，让 `globalThis.pdfjsWorker.WorkerMessageHandler` 就位，再注入 API 块，在主线程走 pdf.js 自己的假 worker。

## 环境

测量时产品代码是 main `34462b471bf7dbb733eb0cf2ba8e15df48a36ab7`。当时 `task/T30-react-flow-canvas` 锁定的 `@xyflow/react` 也是 12.12.0，但本测量没有构建那条分支。下表「接入 React Flow 后」是在当前白板入口上额外引用这些符号，再用与 `workbench/vite.config.ts` 相同的 `vite` 7.3.6、`@vitejs/plugin-react` 和 `vite-plugin-singlefile` 2.3.0 打出来的：

`ReactFlow`、`ReactFlowProvider`、`Handle`、`NodeResizer`、`addEdge`、`applyNodeChanges`、`applyEdgeChanges`、`useNodesState`、`useEdgesState`，以及 `@xyflow/react/dist/style.css`。

| 包 | 版本 | 许可证 |
|---|---|---|
| react / react-dom | 19.3.0 | MIT |
| @xyflow/react | 12.12.0 | MIT |
| pdfjs-dist | 6.4.299 | Apache-2.0 |
| @modelcontextprotocol/ext-apps | 2.0.3 | MIT |
| esbuild（只用于探针打 IIFE） | 0.28.2 | 沿用 workbench 已锁定的许可证 |
| playwright | 1.62.1 | 沿用 workbench 已锁定的许可证 |

浏览器是本机 `/usr/bin/google-chrome`，Playwright 无头启动，用户代理 `HeadlessChrome/156.0.0.0`。Node `v22.23.4`。gzip 一律是 `node:zlib` 的 `gzipSync`，默认级别 6。

复现：

```bash
cd workbench && npm ci
cd spikes/bundle-loading && npm ci
cd ../.. && node spikes/bundle-loading/run.mjs
```

没有 `CHROMIUM_PATH` 时用 `/usr/bin/google-chrome`。命令覆盖 `workbench/spikes/bundle-loading/results/` 里的 `sizes.json`、`browser.json`、`host.json`、`summary.json`。探针依赖不进 `workbench/package.json`，`node_modules` 不提交。

## 1. 体积

| 文件 | 原始 | gzip |
|---|---:|---:|
| 当前 `workbench/dist/board.html` | 636536 | 186263 |
| 接入上述 React Flow 符号后的单文件 HTML | 835669 | 248449 |
| 增量 | 199133 | 62186 |
| 按需块：pdf.js API（`pdf.min.mjs` 打成 IIFE） | 429251 | 129662 |
| 按需块：pdf.js worker（`pdf.worker.min.mjs` 打成 IIFE） | 1188656 | 375070 |

发行包里的 `pdf.min.mjs` 是原始 458904、gzip 132544；`pdf.worker.min.mjs` 是原始 1264342、gzip 376488。探针注入并实测的是再打过一次的 IIFE，体积以按需块那两行为准。

单独入口（不是主包增量）：只含 React 的壳 gzip 69247；只含上列 React Flow 符号的入口 gzip 66648；`import * as` 整个 `@xyflow/react` 入口 gzip 69272。这三份摇掉的 React 代码不一样，不能相减。主包增量 62186 小于单独的 React 壳，说明接入构建没有把 React 再打一份。整个公开入口只比列出的符号大不到 3 KB gzip，T30 再多引用几个公开符号也不会把主包顶过上限。

主包 gzip 上限 320000 是接入后的 248449 再留约 70000 给 T31–T39 的界面。按需块 gzip 上限 450000 盖住 worker 块的 375070，并留约两成给定版本的体积抖动；它盖不住「worker 再加一份编辑器或图表库」。

## 2. 做法和宿主

本地宿主的 iframe 是 `sandbox="allow-scripts"` 的 srcdoc，CSP 为：

```text
default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; media-src data:; connect-src 'none'
```

MCP Apps 规范（2026-01-26）在省略 `ui.csp` 时要求的默认策略更宽，带 `script-src 'self' 'unsafe-inline'`，以及 `frame-src 'none'`、`object-src 'none'`、`base-uri 'self'`。规范没有写资源的字节上限。本地宿主比规范默认更严，没有 `'self'`。下面「规范默认 CSP」一行是在 Chromium 里套用这串策略，不是某个商业宿主的实测。

iframe 内 `location.origin` 为字符串 `"null"`。只有 `allow-scripts` 时，父页面读 iframe 的 `location` 会被浏览器拒绝。加上 `allow-same-origin` 后父页面能读到，读到的值仍是 `"null"`，不能把它看成拿到了 `http://127.0.0.1`。

| 做法 | 本地宿主 | 同一 CSP 的 Chromium 机制 | Claude 桌面版 | VS Code / Goose / ChatGPT / Postman |
|---|---|---|---|---|
| A 全内联 | 能。空白白板出现「从一块空白开始」，iframe CSP 与上面一致。`resources/read` `ui://sand-table/overview.html` 返回 200，`text/html;profile=mcp-app`，正文 636536 字节，含 `id="root"` | 能。内联经典脚本和一行 `type=module` 内联脚本都执行了 | 未测。环境里没有客户端，也没有登录会话 | 未测。环境里没有这些程序 |
| B 现在的本地实现 | 不能。`resources/read` `ui://sand-table/chunks/probe.js` 返回 400，`Resource not found`。iframe 发出同一次读取，宿主回复 `-32601 Method not found` | 不适用 | 未测 | 未测 |
| B 的注入机制 | 未在产品宿主里接通 | 能。父页面把 IIFE 文本 postMessage 给 iframe，iframe 用 `script.textContent` 注入后执行。pdf.js 两个块按这个方式跑通，见下一节 | 未测 | 未测 |
| C 外链脚本、`data:`、`blob:` 脚本、`fetch` | 未改产品 CSP，不能 | 不能。CSP 报告分别是 `script-src-elem`（blob、data、https）和 `connect-src` | 未测 | 未测 |
| C `eval` / `new Function` | 未改产品 CSP，不能 | 不能。`EvalError`，明确缺少 `unsafe-eval` | 未测 | 未测 |
| C 真 Worker | 未改产品 CSP，不能 | 当前 CSP 下经典 Worker 和 module Worker 都不能。只加 `worker-src blob:` 时，不透明 srcdoc 里的经典 Worker 能跑，module Worker 仍不能。pdf.js 6 创建的是 module Worker，所以这一处放宽不够。同时加上 `script-src blob:` 和 `allow-same-origin` 后，两种 Worker 都能跑；这两处是一起改的，没有拆开再测 | 未测 | 未测 |

SDK 夹具（不是宿主）：`@modelcontextprotocol/server` 2.0.0 的 `registerResource` 可以登记 `ui://sand-table/chunks/probe.js` 和 `sand-table://chunks/probe.js`，mime 为 `text/javascript`，`resources/read` 原样返回文本。`registerAppResource` 会把登记 mime 强制成 `text/html;profile=mcp-app`。chunk 必须走 `registerResource`。规范写明 `ui://` 的内容必须是 HTML；这个夹具没有证明商业宿主接受非 HTML 的 `ui://`。T72 先用卡片里的 `ui://sand-table/chunks/<名字>.js`。若某个已经实测的宿主拒绝非 HTML 的 `ui://`，那个宿主改用 `sand-table://chunks/<名字>.js`，注入方式不变。在测到之前两种 URI 都不算宿主通过。

DeepSeek Harness 未测。`workbench/dsh-plugin/client.js` 把 iframe 指到本地工作台 URL，不是另一套 MCP Apps srcdoc；白板里的 CSP 仍是本地宿主那一层。

机制探针的步骤：

1. 用 esbuild 0.28.2 把 `entries/pdf-worker-entry.js` 和 `entries/pdf-runner-entry.js` 打成 IIFE，确认产物里没有 `import.meta`。
2. 在 `http://127.0.0.1` 页面上创建 iframe，`sandbox` 和 CSP 按上表。
3. iframe 里的探针先做内联、blob、data、https、`eval`、`import()`、`fetch`、Worker，再按模式注入 pdf 块。
4. 另起本地工作台（`scripts/start-workbench.mjs --no-open`），用 Chromium 打开带会话片段的地址，等标题「从一块空白开始」，再从 iframe 和 `/rpc` 各读一次 chunk。

## 3. pdf.js worker

科研包在 Node 里用的是 `pdfjs-dist/legacy/build/pdf.mjs`。白板里用浏览器构建 `pdfjs-dist/build/pdf.min.mjs` 和 `pdf.worker.min.mjs`，版本仍是 6.4.299。

不设置 `GlobalWorkerOptions.workerSrc`，也不调用 `new Worker`。worker 块执行后写 `globalThis.pdfjsWorker`。pdf.js 看到 `pdfjsWorker.WorkerMessageHandler` 就走主线程假 worker，不再读 `workerSrc`。没有这份全局对象时，`getDocument` 直接抛出 `No "GlobalWorkerOptions.workerSrc" specified.`，不会自己退回主线程。

调用参数：`disableFontFace: true`、`isEvalSupported: false`、`useSystemFonts: false`。在本地 CSP 和 `sandbox="allow-scripts"` 下，一页只含 Helvetica 单词 Hello 的 PDF 读出了 `Hello`。pdf.js 会先把页面涂白，白底的 RGB 也大于 0，所以不能拿非零像素当画出了字形。对照是一张同样尺寸、只填 `#ffffff` 的空白画布：它的深色像素（不透明且任一通道小于 200）是 0，Hello 页是 445。多出的深色像素超过 20 才算画成功。没有网络请求，也没有 `unsafe-eval`。

这只证明了这一页。标准字体、CMap、含脚本的 PDF 没有测。T45 若需要字体，把字体字节打进块里，不能 `fetch`。`createPdfWorker()` 表示「worker 块已经在主线程就位」，`destroy()` 只释放引用和 pdf.js 的 loading task；没有 `Worker` 可以 `terminate`。块的顺序必须是 worker，然后才是 API。

## 4. 给 T42–T56 的约束

1. 不放宽 CSP。不加 `connectDomains`、`resourceDomains`、`blob:`、`data:`、`unsafe-eval`。每张组件卡不另写一套打包例外。
2. 新依赖版本写死。PR 里写许可证、打进产物后的原始字节和 gzip 字节。gzip 口径与本记录相同。
3. 相对当前主包，gzip 增量超过 50000 的依赖不得从白板入口 import。它等 T72 的 `loadComponentResource`。资源名只来自构建清单，不接受任意 URL。
4. 主包和每一个块都不得超过上表。超了就换库或拆块。要改上限，先按本记录的命令重测并改本 ADR。
5. 按需块是经典 IIFE，用 `script.textContent` 注入。不用 `script.src`。pdf.js 的两个块按上一节的顺序加载。
6. pdf 视图只通过 T72 的 `createPdfWorker()` 使用 worker 全局对象，参数保持 `isEvalSupported: false`。不创建 `Worker`。
7. 宿主没有在本记录里标成「能」之前，不宣称那里能按需加载。超过主包上限的组件在那个宿主上保持不可用，并写明未测，不用全内联把主包撑过上限。
8. 字体、CMap、wasm 一类附属文件打进对应的块。块就绪之后不再发网络请求。断网后已经注入的内置组件仍要能打开。
9. 成功的块按名字缓存；失败可以重试；切换工作空间时取消尚未完成的读取。

## 回退

某个宿主若被实测证明不能把脚本文本交回界面，那个宿主使用做法 A，但主包仍不得超过 1100000 / 320000。pdf.js、富文本和图表库都放不进这个上限，所以不能靠回退把它们打进主包。回退只覆盖仍然放得下的界面。放不下的组件等加载器，或者改 ADR 之前保持不可用。
