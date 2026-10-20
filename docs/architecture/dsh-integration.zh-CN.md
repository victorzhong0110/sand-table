# DSH 宿主集成契约

> 契约版本 v1（2026-10-20）。本文是 issue #18 的**阶段 A（接口调研与集成契约）**交付物，
> 也是白板内 AI 入口、能力探测与宿主适配的规格。
> 上位：#11（通用内核）、#18（DSH 集成规划）。

## 0. 一句话结论

**DSH 承担 AI 宿主，Sand Table 提供空间内容与交互。**
Sand Table 侧要做的不是「再实现一个 Agent」，而是：
① 一个**诚实的能力探测**（能不能发任务由宿主说了算）；
② 一个**宿主桥协议**（把「向宿主提交任务、接收事件」抽象成接口）；
③ 一个**按官方插件规范写的 DSH 插件包**（侧栏入口 + 画布承载 + Agent 可读的白板工具）。

## 1. 宿主事实（已核实，一手来源）

核实时间：2026-10-20。来源全部是官方仓库 `deepseek-ai/deepseek-harness`
（默认分支 `master`，MIT，仓库描述「DeepSeek Harness: Everything is a Plugin.」）。

| 事实 | 依据 |
|---|---|
| 宿主是插件化运行时；插件分 **Host 半**与 **Client 半** | `packages/preset/agent-preset/skills/cordis-plugin-development/SKILL.md` |
| Host 插件导出 `apply(ctx, config)`，可选 `inject = ['tools']` 与 `Config` | 同上 + `references/host-plugin.md` |
| 插件包是 **bundle**：`package.json` 声明 `dsh.bundle.patch`，YAML patch 插入插件行 | `references/host-plugin.md` |
| Client 插件：`package.json` 的 `dsh.client` 段（`platform` / `immediately` / `inject`）+ `./client` 导出 | `references/ui-plugin.md` |
| Client 通过 `ctx.slots.inject(key, cb)` + `ctx.slots.register({name,id,order}, Component)` 注册 UI | `references/ui-plugin.md`、`docs/subsystems/slots.md` |
| 槽位是**有类型的 React 组合系统**；`root` 是唯一内建声明，由 `ctx.slots.renderSlot('root', {})` 渲染 | `docs/subsystems/slots.md` |
| 槽位基数：`single`（优先级最低者胜出）/ `list` / `keyed` / `chain`；`single` 与已占用的 keyed 格是**替换点** | `docs/subsystems/slots.md` |
| 槽位作用域：`root` / `session-maybe` / `session` | 同上 |
| 现成的槽位（节选）：`conversation.session.header.actions`、`conversation.header.leading`、`conversation.composer.dock`、`conversation.input.activity`、`conversation.view`、`conversation.hero.*`、`shell.overlay`、`plugins.add.actions` | 同上（随附的槽位层级树） |
| **侧栏 + 主面板的正确组合是 `sidebar.panellist`（list/root）+ `main`（keyed/root），两个 id 必须一致**——侧栏选中的面板 id 直接作为 `main` 的 `entryKey` | `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts:3641,2126`；`packages/client/ui-layout/src/client/AppFrame.tsx:42` |
| `conversation.view` 是 **`list`**（scope `session`），不是 single：用新 id 注册是**新增**会话视图，复用官方 id 才是替换 | 同上，slot-catalog.ts:1937 |
| Host 半暴露 **Agent 工具**：`ctx.tools.register(defineTool({...}))`，注册即进入系统提示的 schema 汇总；参数用 DSH 的 schema DSL 声明，非法参数变成普通错误结果 | `packages/core/tools/README.md:45` |
| 面向人的动作 / Client 可调用入口：`ctx.commands.register({ name, description, input?, handler })`；name 只能小写字母/数字/`_`/`-`；同名重复注册抛错；命令不产生模型消息，但记进 agent 的 session log | `packages/interaction/commands/README.md:32-35` |
| 清单字段：`dsh.bundle.patch`（单文件或**有序数组**）、`dsh.profile.bundles`（**有序数组**）、`dsh.client.{platform,inject,immediately,external}`、`engines.dsh`；patch 是 Cordis patch YAML，**不能是空/只有注释的文件**（空 patch 会导致启动失败） | `packages/util/package-manifest/src/types.ts:30-95`；`packages/boot/app-boot/README.md:50,61` |
| DSH 的 Web 外壳**没有**给页面设 `frame-ancestors` / `X-Frame-Options`；插件自渲染 iframe 时 **CSP 要自己管**（DSH 自带范式：`ui-sidebar-documentpreview` 用 `meta` CSP + `sandbox`） | `packages/credentials/deepseek-account-platform/src/index.ts:645` |
| 官方槽位权威目录（生成物，覆盖全部槽位键的基数/作用域/占用者/替换风险） | `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts` |
| 标准 props 提供 `useSessions` / `useSessionStatus` / `useSessionAccess` / `useWorkspaces` / `useWorkspaceAccess` / `usePanelInfo` | 同上 |
| **不得**替换应用根、不得往 `document.body` 追加第二个应用 | `references/ui-plugin.md` |
| UI 操作要暴露给 Agent 时：操作实现为 **Host 服务方法**，UI 走 Client 可调用的 Host 入口，Agent 走**同名工具**，两者共用同一实现 | `references/user-actions.md` |
| Client 调用 Host 入口的方式是 `ctx.remote.commands.execute()` | 同上 |
| 插件安装由 `plugin_manager` 的 `install_bundle` 完成（不手写 profile 的 package.json / cordis.patch.yml） | `SKILL.md` |
| 运行时可用 `cordis_inspect_query` 查询 `Slots.listSubTree` 拿到实时槽位树 | `SKILL.md`、`docs/subsystems/slots.md` |

### 1.1 由此得出的能力边界

| 目标（#18 §2） | 普通插件机制能否做到 | 依据 |
|---|---|---|
| 侧栏加「新建 Sand Table」入口 | **能** | 向 `sidebar.panellist` 注册一个 id（`list`/root，加法） |
| 在主内容区打开画布 | **能，且不顶掉官方 UI** | 向 `main` 注册**同名 key**（`keyed`/root，加法）；侧栏 id 与 main key 必须一致 |
| 白板内发任务给 Agent 并收响应 | **能，但需走 Host 入口**（`ctx.commands.register` 或 `ctx.tools.register`），且要确认宿主提供的会话命令 | `references/user-actions.md`；`packages/interaction/commands/README.md` |
| 会话与白板统一导航 | **能**：`useSessions` / `useWorkspaces` / `useSessionAccess` 是标准 props | `docs/subsystems/slots.md` |
| Agent 读取/修改白板内容 | **能**：把白板操作暴露成 **Host 工具** | `references/user-actions.md` |
| 复用 DSH 插件能力 | **能**（Agent 侧直接用宿主插件） | #18 §7 |
| 自建模型调用循环、凭据管理、对话压缩 | **不做**（按 #18 决策撤销该路线） | #18 §3 |

### 1.2 本轮**没有**核实的（不得当成已存在）

- 宿主**具体**的「提交任务 / 发送消息」会话命令名与签名（本轮未取得权威定义）。
- 宿主**自定义 HTTP 路由**的注册方式（社区插件用过，但属第三方实现，不是官方 API）。
- 插件在 DSH Web 端与 Desktop 端的差异细节。
- 真实 DSH 实例中的安装与运行（本沙箱**没有安装 DSH**，无法真跑）。

因此本轮的实现策略是：**能力探测驱动**。
拿不到确证的能力，一律标为不可用，入口随之隐藏——这与 #18 §6「能力决定入口是否出现」一致。

## 2. 宿主桥协议（Sand Table 侧，本仓实现）

文件：`workbench/core/host-bridge.ts`。类型在 `core/objects.ts`：
`HostCapabilities` / `HostTaskRequest` / `HostTaskEvent`。

```ts
export type HostBridge = {
  /** 宿主标识。 */
  readonly host: string;
  /** 宿主实际能力。入口显隐由它决定，不由猜测决定。 */
  capabilities(): HostCapabilities;
  /** 提交任务。宿主不支持时抛错，错误文案要说明原因。 */
  submitTask(request: HostTaskRequest): Promise<{ taskId: string }>;
  /** 订阅任务事件。返回取消订阅函数。 */
  subscribe(listener: (event: HostTaskEvent) => void): () => void;
};
```

### 2.1 三个实现

| 实现 | 何时用 | 能力 |
|---|---|---|
| `localBridge` | 独立模式（无宿主） | `taskSubmit: false`，提交任务抛错 |
| `mcpBridge` | 只有 MCP 客户端接入 | `taskSubmit: false`（MCP 不是任务执行通道） |
| `injectedBridge(scope)` | 宿主注入了桥（DSH 插件的 Client 半注入） | 取宿主自报的能力 |

### 2.2 注入约定

宿主 Client 半在页面里注入：

```js
window.__SAND_TABLE_HOST__ = {
  host: "dsh",
  version: "0.1.0",
  capabilities: { taskSubmit: true, eventStream: true, contentRead: true, resultKinds: ["text", "link"] },
  submitTask: async (request) => ({ taskId: "..." }),
  subscribe: (listener) => { /* ... */ return () => {} },
};
```

Sand Table 读这个对象；**读不到就是没有宿主**，不报错、不显示入口。

### 2.3 能力与入口的对应（硬规则）

| 能力 | 界面行为 |
|---|---|
| `taskSubmit: false` | **不显示**白板内对话入口（不显示「问 AI」，不显示输入框） |
| `taskSubmit: true` | 显示入口与输入框；发送时携带对象引用与版本 |
| `eventStream: false` | 仍可发送，但只显示「已提交」，**不伪造进度** |
| 断线 | 保留历史与未发送草稿，显示断开/重试状态，不销毁正在编辑的内容 |

这条规则延续集成轮决策 D7：**AI 入口按真实能力显示**。

### 2.4 任务上下文用引用 + 版本

`HostTaskRequest` 携带 `targets: {objectId, version}[]` 与 `contextVersion`，
**不传整份快照**。任务开始后用户改选择，不改变已提交任务的目标；
内容变化引起的冲突要可见（宿主拿到的版本与当前版本不一致时由宿主提示）。

## 3. DSH 插件包

目录：`workbench/dsh-plugin/`。按官方 bundle 规范写：

```
dsh-plugin/
  package.json      # dsh.bundle.patch + dsh.client 段
  cordis.patch.yml  # 插入插件行
  index.js          # Host 半：服务 + Agent 工具
  client.js         # Client 半：入口 + 画布承载
  locale/en.json    # meta.title / meta.description
  locale/zh.json
  icon.svg
  README.md         # 安装与验证步骤
```

### 3.1 Host 半职责

1. 暴露 **Agent 工具**：把白板读操作暴露给 DSH 的 Agent
   （列白板、读白板、读对象）。实现复用 **Sand Table 的 MCP server**（stdio 子进程），
   不重复实现内核逻辑——这与「外部 AI 客户端通过 MCP 读取和操作同一内核」一致。
2. 暴露 **Client 可调用的 Host 入口**：供 Client 半提交任务。
3. **不**实现模型调用、凭据、对话压缩。

### 3.2 Client 半职责

1. 向 `sidebar.panellist` 注册一个 id（如 `sand-table`）→ 侧栏出现图标入口。
2. 向 `main` 注册**同名 key** → 侧栏选中该面板时，主区域渲染画布容器。
   两者都是**加法**，不顶掉官方 UI；id 不一致则侧栏点开没有内容。
3. 画布用 **iframe** 承载 Sand Table 本地服务（`local/main.ts` 提供的 HTTP 服务），
   **不**往 `document.body` 追加第二个应用、**不**替换应用根；
   iframe 的 **CSP 与 sandbox 自己管**（照 `ui-sidebar-documentpreview` 的范式）。
3. 提供「问 AI」的就近输入（`conversation.composer.dock` 一类的槽位），
   发送时走宿主桥的 `submitTask`。

### 3.3 安装

按官方流程：`plugin_manager` 的 `install_bundle` 指向插件目录。
**不**手写 profile 的 `package.json` / `cordis.patch.yml`。
README 写清步骤与**未验证项**。

## 3.4 插件结果映射

插件结果不一定自带可嵌入的白板 UI。映射是**降级优先**的
（`core/host-bridge.ts` 的 `mapHostResult`）：

| 结果种类 | 目标组件 | 说明 |
|---|---|---|
| 文献（`document` / `paper`） | 证据卡（`evidence`） | 带页码级引用与来源 |
| 数据（`dataset` / `data`） | 表格（`table`）或图表（`chart`） | 有行就表格，没有就图表占位 |
| 文件（`file` / `resource`） | 资源引用（`resource`） | 保留 uri 与片段定位 |
| 其他 | 基础文本（`text`） | 通用降级：结果可以看不懂，来源不能丢 |

**来源与资源定位一律保留**——映射丢的是呈现细节，不是可追溯性。

## 4. 独立模式与 MCP 保留

- 不依赖 DSH 也能创建、编辑、保存、重开（内核不依赖宿主）✓。
- MCP 客户端仍能读同一份工作空间 ✓。
- 不建 Sand Table 自有的 API Key 配置页或 Agent 运行系统 ✓。

## 5. 不变量

| 编号 | 不变量 | 怎么验 |
|---|---|---|
| X1 | 没有宿主时，白板内**不出现**对话入口 | UI 快照测试 + bridge 单测 |
| X2 | 宿主自报 `taskSubmit: false` 时同样不出现 | 同上 |
| X3 | 提交任务携带对象引用与版本，不带整份快照 | bridge 单测断言请求形状 |
| X4 | 断线保留草稿与历史，显示断开/重试 | UI 行为（CI 浏览器测试） |
| X5 | 事件缺失时不伪造进度 | 只显示「已提交」 |
| X6 | 插件包清单符合官方 bundle 规范 | 清单结构测试（exports / files / locale / icon） |
| X7 | 插件两端代码语法可解析 | `node --check` |
| X8 | 未在真实 DSH 中验证的部分**明确标注** | 文档与 README 明写 |

## 6. 交付形态

| 文件 | 归属 | 内容 |
|---|---|---|
| `workbench/core/host-bridge.ts` | 负责人 | 桥协议与三个实现 |
| `workbench/tests/host-bridge.test.ts` | 负责人 | X1–X5 |
| `workbench/dsh-plugin/**` | 生产者 E | 插件包（Host/Client/清单/locale/图标/README） |
| `workbench/tests/dsh-plugin.test.ts` | 生产者 E | X6、X7 |
| `workbench/board/**`（AI 入口接线） | 负责人 | 按能力显示入口 |
| `docs/architecture/dsh-integration.zh-CN.md` | 负责人 | 本文档 |

## 7. 需要 DSH 宿主改动的诉求

本轮**未发现必须由宿主改动才能实现**的目标项：
侧栏入口、画布承载、会话导航、Agent 工具都落在普通插件机制内。

原列的四条待核实项，经源码核对**已有答案**（见 §1）：

| 原问题 | 结论 |
|---|---|
| 提交任务/发送消息的会话命令名与签名 | `ctx.commands.register({name, description, input?, handler})`；name 限小写字母/数字/`_`/`-` |
| `conversation.view` 是否 single 槽位 | **不是**，是 `list`（scope session）；本次改用 `sidebar.panellist` + `main` 组合，不碰它 |
| 跨源 iframe 的 CSP | DSH 外壳不设 `frame-ancestors`/`X-Frame-Options`；**插件自己管**（`meta` CSP + `sandbox`） |
| Agent 工具的注册与调用时序 | `ctx.tools.register(defineTool(...))` 注册即进系统提示的 schema 汇总 |

仍需在**真实 DSH 实例**里验证的（源码查不到答案）：
安装是否成功、入口实际长什么样、Agent 侧能否真的调到工具。
这些以**能力探测**兜底：探测不到就不显示对应入口。
