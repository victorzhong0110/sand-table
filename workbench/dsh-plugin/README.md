# Sand Table 的 DSH 插件包

把 Sand Table 白板接进 DeepSeek Harness（DSH）：

- **Host 半**：把白板的**读**操作暴露成 Agent 工具（列白板 / 读白板 / 读对象），
  并注册一条 Client 可调用的会话命令 `sand-table`（探测宿主能力、读白板、提交任务）。
- **Client 半**：在侧栏注册一个面板条目，点开就在中央列用 **iframe** 承载本机工作台，
  并把宿主能力按宿主自报的样子交给白板（白板里的「问 AI」入口因此才有意义）。

不实现模型调用、凭据管理、对话压缩——那是 DSH 的事。

> **验证状态（请先读这一段）**
>
> 本插件写在一个**没有安装 DSH** 的沙箱里：装不了、跑不起来。
> 已经验证的只有两件事——清单结构符合官方 bundle 规范（测试 `tests/dsh-plugin.test.ts`）、
> 两个 JS 文件语法可解析（`node --check`）。
> **所有运行时行为都没有在真实 DSH 实例里验证过**，包括但不限于：
> 插件能否被 `install_bundle` 装上、Client 半能否注册到那两个槽位、
> Agent 工具能否被模型调用、宿主命令能否被 `ctx.remote.commands.execute` 调到、
> 画布页面能不能收到注入的桥。逐条清单见下面「未验证项」。
> 下面凡是写「实测」的，都能在本仓库里复核；凡是写「未验证」的，就是没验过。

## 目录

```
dsh-plugin/
  package.json      # dsh.bundle.patch + dsh.client 段 + exports/files/engines
  cordis.patch.yml  # 插入插件行（含默认 config）
  index.js          # Host 半：Agent 工具 + 宿主命令 + MCP server 子进程
  client.js         # Client 半：侧栏条目 + 中央列面板 + 宿主桥注入
  locale/en.json    # meta.title / meta.description（插件管理器展示用）
  locale/zh.json
  icon.svg
  README.md
```

## 安装

插件是 **bundle**：由 `plugin_manager` 的 `install_bundle` 装进当前 profile。
**不要**手写 profile 的 `package.json` 或 `cordis.patch.yml`——`install_bundle` 会做这件事。

1. 确认 DSH 版本满足 `engines.dsh`：**`>=0.2.1-rc.2 <0.3.0`**。
   目前 DSH 的发布全是 prerelease（最新 `dsh-v0.2.1-rc.2`，2026-10-17），
   所以这是一个**预发布版本区间**；换更新的 DSH 时请一并复核下面的槽位与 API。
2. 把 `dsh-plugin/` 整个目录放到一个工作区里（要能被 DSH 进程读到）。
3. 用 `plugin_manager` 的 `install_bundle`，`target` 指向这个目录的**绝对路径**。
4. 读安装结果：`application` 与 `warnings` 决定改动是否真的生效，不是日志说了算。
5. 确认新插件行：装完后插件行会出现在插件管理里；Agent 工具是否可用要在会话里试。

命令行等价物（`dsh plugin` 会转发给 profile 目录里的 pnpm）：

```bash
dsh plugin --profile <profile> add /absolute/path/to/dsh-plugin
```

## 配置

配置写在插件行的 `config` 里（见 `cordis.patch.yml`）。插件**不声明 `Config`**
（声明它需要宿主的 schemastery 依赖），所以是自己读的：缺哪个键就用哪个的默认值，
不会因为配置缺失拒绝启动。补丁是**整行替换**不是深合并，所以要改配置就整行重写。

| 键             | 默认值                              | 说明                                                                                                 |
| -------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `serverEntry`  | `../server/main.ts`（相对插件目录） | Sand Table MCP server 入口。装成 bundle 后这个相对路径通常不存在，要改成**实际安装好的** server 路径 |
| `workspaceDir` | `~/.sand-table/workspaces`          | 工作空间存储目录（白板落盘位置），与 `server/main.ts` 的默认一致                                     |
| `workspaceId`  | `default`                           | 同一目录下的工作空间 ID。绑定了仓库时内核会用 `project-<hash>`                                       |
| `boardUrl`     | `http://127.0.0.1:4173/board.html`  | Client 半 iframe 承载的白板地址                                                                      |
| `nodePath`     | `process.execPath`                  | 跑 MCP server 的 node 可执行文件                                                                     |
| `timeoutMs`    | `20000`                             | 单次 MCP 调用超时                                                                                    |

「端口」不在这里配置：白板本地服务的端口由启动它的那一端决定
（`npm run launch -- --port <port>`），本插件只消费 `boardUrl`。

### MCP server 是怎么被拉起来的

Host 半用 stdio 子进程跑 Sand Table 自己的 MCP server，命令形态与仓库 README 一致：

```
node --experimental-strip-types server/main.ts --workspace-dir <dir> --workspace-id <id>
```

插件内手写了一个极简 MCP stdio 客户端（MCP 的 stdio 传输就是每行一个 JSON-RPC 消息），
**没有新增任何 npm 依赖**，也**没有重复实现内核逻辑**：真正的读写都在 MCP server 里。

## Host 半：Agent 工具与宿主入口

### Agent 工具（只读）

| 工具                     | 参数                  | 做什么                                                       |
| ------------------------ | --------------------- | ------------------------------------------------------------ |
| `sand_table_list_boards` | 无                    | 列出工作空间里的白板（boardId、标题、版本、对象数）          |
| `sand_table_read_board`  | `boardId`             | 读一张白板：标题、版本、选区、对象与空间概览、备注与编排摘要 |
| `sand_table_read_object` | `boardId`、`objectId` | 读白板上的一个对象：内容、版本、展示实例、语义关系           |

工具的规范值是 JSON 字符串。工具定义按 `ctx.tools.register` 认的结构产出
（`name` / `description` / `parameters` 的 JSON Schema / `output{schema, render}` / `execute`），
**没有 import 宿主的 `defineTool`**——运行时代码不引宿主包，形状与它一致。

### 宿主命令（Client 可调用）

命令名 `sand-table`（小写，无斜杠）。Client 半用 `ctx.remote.commands.execute(sessionId, line, [])` 调用，
行格式是 `/sand-table <子命令> [参数]`：

| 子命令                             | 作用                                                                                                 |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `capabilities`                     | 返回宿主自报的能力 JSON（`taskSubmit` / `eventStream` / `contentRead` / `boardUrl` / `workspaceId`） |
| `list_boards`                      | 同 `sand_table_list_boards`                                                                          |
| `read_board <boardId>`             | 同 `sand_table_read_board`                                                                           |
| `read_object <boardId> <objectId>` | 同 `sand_table_read_object`                                                                          |
| `submit {json}`                    | 把白板里的任务提交给当前会话                                                                         |

`submit` 的请求形状就是契约里的 `HostTaskRequest`：
`{ boardId, instruction, targets: [{ objectId, version }], contextVersion }`。
**只带引用与版本，不带整份快照**（契约 X3）。提交时任务上下文会被拼成一段文字，
提醒 Agent 先用读工具取内容再回答。

读操作**一次实现、两个调用方**：会话命令与 Agent 工具走同一份实现。

## Client 半：槽位、降级与桥注入

### 槽位

| 槽位                | 种类           | 注册的东西                                          |
| ------------------- | -------------- | --------------------------------------------------- |
| `sidebar.panellist` | `list` / root  | 面板条目 `id: "sand-table"`（新增，不顶掉官方条目） |
| `main`              | `keyed` / root | 中央列面板 `key: "sand-table"`                      |

**两处用同一个 id/key**：侧栏选中的面板 id 就是中央列要渲染的键
（DSH 源码 `packages/client/ui-layout/src/client/AppFrame.tsx`：
`renderSlot('main', {}, { entryKey: panelId ?? 'conversation' })`）。

> 早期设计里写的是「在 `conversation.view` 一类 `single` 槽位用更小的 priority 胜出」。
> 实际不是这样：`conversation.view` 在 DSH 里是 **`list`**（scope `session`），
> 塞进去是**新增一个会话视图**，不是替换；`single` 的遮蔽语义只在同一种槽位里成立。
> 侧栏 + 中央列的组合是 DSH 自带插件（如插件管理器、任务管理）的既有范式，
> 两个槽位都是**加法**，不会顶掉官方 UI。

### 降级策略

- **槽位不可用**（没声明、被占、注册抛错）→ 不注册，界面上就没有这个入口，
  并在控制台留一条 `[sand-table] … 槽位不可用` 的警告。**不猜位置、不读别的插件的 DOM**。
- **宿主命令不在**（`ctx.remote.commands.list` 里没有 `sand-table`）→ 不注入桥，
  白板里**不显示**「问 AI」入口（契约 X1/X2）。
- **宿主自报 `taskSubmit: false`** → 照样注入它自报的能力，白板据此**不显示**入口。
- **没有事件通道**（`eventStream: false`）→ 订阅是空操作，白板只显示「已提交」，**不伪造进度**（契约 X5）。
- **找不到当前会话** → 提交不了，面板里说明原因，不假装成功。

### 宿主桥的消息契约

白板页面读的是 `window.__SAND_TABLE_HOST__`（形状见 `workbench/core/host-bridge.ts` 的 `InjectedHost`）。
Client 半按两种情况处理：

1. **同源**（白板页面和 DSH 页面同源）：直接写 `iframe.contentWindow.__SAND_TABLE_HOST__`，
   连函数一起给（`submitTask` / `subscribe`）。
2. **跨源**（正常情况：白板在 `127.0.0.1:<port>`，DSH 在另一个源）：
   跨源只能传**数据**，所以走消息：

| 方向        | 消息                                                                        | 内容              |
| ----------- | --------------------------------------------------------------------------- | ----------------- |
| 父页 → 画布 | `{ type: "sand-table:host-bridge", host: { host, version, capabilities } }` | 宿主自报的能力    |
| 画布 → 父页 | `{ type: "sand-table:submit-task", id, request }`                           | `HostTaskRequest` |
| 父页 → 画布 | `{ type: "sand-table:submit-task-result", id, taskId }`                     | 提交成功          |
| 父页 → 画布 | `{ type: "sand-table:submit-task-error", id, message }`                     | 提交失败与原因    |

> **白板侧还需要接线（负责人）**：`board/main.tsx` 现在的桥是
> `resolveBridge(window, app ? "mcp" : "local")`（`board/main.tsx:81-90`），
> `useMemo` 的依赖只有 `[app]`，**注入晚到不会被重新读到**。
> 需要：① 监听上面 `sand-table:host-bridge` 消息并写 `window.__SAND_TABLE_HOST__`；
> ② 让桥的重新解析有一个会变化的依赖（例如一个 state）。
> 跨源时 `submitTask` 也要由白板侧按上面的往返协议自己实现。

### iframe 的安全

- **不**替换应用根，**不**往 `document.body` 追加第二个应用。
- iframe 用 `sandbox="allow-scripts allow-same-origin allow-forms"`。
- 父页只接受**自己画布**发来的消息（比对 `event.source`）。

## 已知限制（读之前先看）

1. **`boardUrl` 的默认值当前打不开。**
   任务书给的默认是 `http://127.0.0.1:4173/board.html`，但本仓库的本地服务
   （`workbench/local/service.ts`）只提供 `/`、`/host.js`、`/session`、`/health`、
   `/bootstrap`、`/status`、`/rpc`、`/agent/*` 这些路由——**没有 `/board.html`**。
   实测（本地起 `local/main.ts --port 4173`）：
   `GET /board.html` 不带凭据是 **403** `{"error":"Session authorization required."}`，
   带上 `X-Sand-Token` 是 **404** `{"error":"Unsupported route"}`；
   `GET /host.js` 是 200。能用的页面是根路径 `/`（工作台外壳页，白板在它自己的 iframe 里）。
2. **本地服务的页面带 `frame-ancestors 'none'`**（`workbench/local/service.ts:138`，
   实测响应头确实有这一段），浏览器**不允许**把它嵌进 iframe。
   要么改这一行，要么用一个不带该响应头的静态服务器伺服 `dist/board.html`，
   再把 `boardUrl` 指过去。
3. **插件只读**。白板的写入仍由 MCP 客户端那条路负责；插件不重复实现内核写入逻辑。
4. **`serverEntry` 指向的 server 必须能自己找到依赖**（`@modelcontextprotocol/*` 等）。
   装成 bundle 后插件目录里没有 `node_modules`，`server/main.ts` 得跑在
   Sand Table 自己的安装目录里。
5. **插件需要宿主有 `tools` 与 `commands` 两个服务**（`inject: ["tools", "commands"]`）。
   没有命令面的宿主（无 UI 的演示、ACP 自动化）里这个插件不会加载。

## 未验证项（本沙箱没有 DSH，全部未验）

- 插件能否被 `plugin_manager` 的 `install_bundle` 装上、装上后是否需要重启。
- 插件行能否激活（`inject` 的两个服务在目标宿主里是否都存在）。
- `sidebar.panellist` / `main` 两个槽位在目标 DSH 版本里是否还是这个种类与作用域。
- Client 半能否成功注册、侧栏图标是否出现、中央列是否渲染 iframe。
- Agent 工具是否出现在模型的工具列表里、能否被真的调用、返回是否是期望的形状。
- 会话命令 `sand-table` 能否被 `ctx.remote.commands.execute` 调到、
  `ctx.remote.commands.list` 能否看到它。
- MCP server 子进程能否在本机拉起来、stdio 握手是否顺畅。
- 宿主能力探测（`capabilities`）在真实宿主里返回什么。
- 跨源 iframe 里的 postMessage 往返是否与白板侧接线对得上。
- 插件管理器里 `meta.title` / `meta.description` / 图标的实际显示效果。

**本机可复核的**：`npx tsc --noEmit`、`node --experimental-strip-types --test tests/dsh-plugin.test.ts`、
`npx prettier --check dsh-plugin tests/dsh-plugin.test.ts`、`node --check dsh-plugin/index.js`、
`node --check dsh-plugin/client.js`。

**本机另外实测过的（仍不是 DSH）**：用一个假 `ctx`（`tools.register` / `commands.register` /
`effect` / `get`）驱动 `apply`，验证了 Host 半自己的逻辑——MCP stdio 握手、
`sand_table_list_boards` / `sand_table_read_board` 真的读到了白板、
缺参数时返回明确错误而不是崩。这只证明 Host 半的内部逻辑成立，
**不证明**它在 DSH 里能被注册、被调用。
