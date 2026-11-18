# ADR 0008：DSH 提供者版本与接口验证

日期：2026-11-16。任务：T77。状态：基础宿主验证完成；绘图提供者需要适配，组合 UI 与真实模型仍需验收。2026-11-17 修正槽位接口判断。

## 结论

以 `@deepseek-ai/dsh@0.2.2-rc.1` 作为本轮适配基线，CLI 的 Node 要求是 `>=24.9.0`。保持独立白板自己的 Node 22.18+ 要求，不为 DSH 改写整个项目的运行时。`dsh-context@0.85.1` 可复用其 Host 状态投影；其 UI 的嵌入/组合仍需实测。`dsh-diagram@0.6.1` 被该版本宿主的兼容性检查拒绝，不选为可直接安装的默认绘图提供者，也不使用版本豁免绕过。

当前 Sand Table 的四个 Host 工具在真实 DSH 中完成了白板创建/读取。2026-11-17 核对两层发布源码后确认：`ctx.slots` 是 renderer 所有的 SlotRegistry，仍提供 `inject(key, callback)` 声明生命周期接口；底层 SlotCore 没有此方法。原先由底层原型推断客户端不兼容的结论错误，已修正验证脚本。`register({inject: factory})` 是另一项业务属性接口，不能用于替代声明生命周期。组合 UI 仍需浏览器实测。

## 固定组合与环境

| 项 | 固定值 / 证据 |
|---|---|
| 白板源基线 | `f8b12c9c69ce55c8857ba95844edfbe8986bb5db`（T76） |
| DSH CLI / 官方包 | `0.2.2-rc.1`，MIT；精确传递依赖见 spike 的 package-lock.json |
| 上下文插件 | `dsh-context@0.85.1`，Apache-2.0；npm gitHead `8b4fddd59d386d69611902d85d805e352a80aee6` |
| 绘图候选 | `dsh-diagram@0.6.1`，MIT；发布包声明的旧版 peer 约束见 registry.json |
| 安装工具 | spike 固定 `pnpm@10.32.1`；最初探测另用环境 pnpm 11.25.0，最终生命周期脚本用固定版本重测 |
| Linux Host | Node 24.22.1，npm 11.9.0；真实 DSH CLI，独立临时 DSH_HOME，sdk-minimal/web profile |
| Mac 基础 UI | Node 25.8.1，macOS，Playwright 1.62.1；独立临时目录和 DSH_HOME；仅基础界面渲染 |
| 模型 | 未调用真实模型；未复制或修改用户 DSH 凭据。Host 工具由探测插件直接调用 |

发布包 tarball、integrity 和版本清单见 [registry.json](../../workbench/spikes/dsh-providers/evidence/registry.json)。DSH 发布元数据未提供 gitHead；采用 npm integrity、lockfile 及 [源码文件 SHA-256](../../workbench/spikes/dsh-providers/evidence/source-files.json) 锁定接口，不虚构 Git 提交。所有验证只修改隔离目录，不改用户已有 profile。

## 验证矩阵

| 能力 | 结果 | 验证范围 |
|---|---|---|
| CLI 与 profile 启动 | 通过 | 真实 sdk-minimal/web，非自建 Cordis 应用树 |
| JSONL 单写者、只读句柄 | 通过 | 第二个 write open 被拒绝；read handle 不可 append |
| 进程间恢复 | 通过 | 第一个 CLI 进程 flush/关闭，第二个 CLI 冷读原记录 |
| 状态投影 | 通过 | 纯 fold、快照、变化通知、注销/重注册重建；重读不触发作品写入 |
| 模型可见上下文持久化 | 通过（基础机制） | user/message 被记录，恢复后 deriveMessages 得到原文；未验证 Agent 注入策略或模型理解 |
| 白板 Host 工具 | 通过 | 真实 DSH → 插件 → MCP bridge → 本地服务 → kernel；创建便签后读回 |
| 上下文 Host 插件 | 通过 | 0.85.1 在真实 web profile 挂载，注册下述 context 投影 |
| 上下文包安装/卸载/重装 | 通过 | 独立 profile 通过官方插件命令完成，不等于 UI 组件生命周期通过 |
| 白板包安装 | 通过（本地链接） | `dsh plugin ... add <仓库插件目录>`；不是自足发布包验收 |
| 网络与 token 计量 | Host 接口通过 | ctx.web search/fetch、tokenMeter 存在；未执行公网搜索/读取或实际 token 准确性评估 |
| 压缩 | 组合确认，实际摘要未测 | Web 的压缩器在 Agent preset 内隔离；sdk-minimal 的默认组合包含基础压缩器；未调用模型压缩 |
| 绘图 0.6.1 安装 | 明确拒绝 | 保留安装器完整拒绝信息和各包约束，profile 未添加该依赖 |
| Web 基础 UI | Mac 通过 | 基础导航、预览说明可见，无 pageerror；未含插件组合验收 |
| 白板客户端 API | 2026-11-17 更正：接口匹配 | ctx.slots 是 renderer 的 SlotRegistry，实际提供 inject 与 register；已加载固定发布包的客户端工厂核对原型 |
| 上下文/白板组合 UI | 未测 | 后续 Mac 设备请求超时；Cloud Chromium 的 Unix socket 权限不支持此浏览器检查 |
| 实际 prompt/cancel/follow 往返 | 未测 | 已验证真实控制服务公开方法，未用真实模型完成一轮 |
| Desktop、跨插件产物、图形分叉/导出 | 未测 / 阻塞 | Desktop 不是本次 CLI web；图形须先适配后验收 |

`dsh-context` 在 Host 中产生了 `contextTimeline`、`contextHeaders`、`contextActivity`，并与官方 `contextPressure`、`contextBreakdown` 一起可读。这证明其 Host 部分实际运行，不代表存在一个可直接导入白板的 React 组件。

运行输出：[持久化与投影](../../workbench/spikes/dsh-providers/evidence/persistence-projection.json)、[Host 服务及白板读写](../../workbench/spikes/dsh-providers/evidence/web-services.json)、[安装生命周期](../../workbench/spikes/dsh-providers/evidence/install-lifecycle.json)、[客户端 API](../../workbench/spikes/dsh-providers/evidence/client-api.json)、[基础浏览器记录](../../workbench/spikes/dsh-providers/evidence/browser-core.json)。

## 目标发布接口与接入规则

路径均相对 spike 的 node_modules；其内容哈希在 source-files.json。

| 接口 | 发布路径 | 后续接法 |
|---|---|---|
| 持久日志 | `@deepseek-ai/dsh-session-persistence/lib/types/index.d.ts` | `create(header)` / `open(id, access)` 得到 handle；`read/append/flush/close`，flush 才是崩溃持久屏障 |
| 生命周期路由 | `@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js` | 已有 write handle 订阅 live session/event；不要另订阅后再 append 同一事件两遍 |
| 投影 | `@deepseek-ai/dsh-session-projection/lib/types/index.d.ts` | `await register(definition)` 得 ready handle，`handle.stateOf`、snapshot 和变化流；不新用弃用的 registry.stateOf |
| 持久插件记录 | `@deepseek-ai/dsh-session/lib/types/index.d.ts` | `appendPluginRecord` / `pluginRecordOf`，带 owner 校验；见下文稳定性限制 |
| 用户消息 | `@deepseek-ai/dsh-session/lib/types/types.d.ts` | user/message 的 data 是 UserMessage，自带稳定 id/source；requestId 在人类来源 rpcId 中关联 |
| 任务控制 | `@deepseek-ai/dsh-api-session-controller/lib/types/{index,types}.d.ts` | `prompt({requestId,sessionId,mode,content}, signal)` 回 accepted；`follow/projections` 读真实状态；排队回执不是完成 |
| 客户端命令 | `@deepseek-ai/dsh-commands/lib/typert.remote-client.d.ts` | commands.execute(agentId, line, attachments, signal?) 仍存在；不要把 Host 的 Agent 参数误当客户端调用形状 |
| UI slots | `@deepseek-ai/dsh-client-ui-renderer/lib/types/client/registry.d.ts` + `lib/client.js`，以及 ui-slots 的 SlotCore | ctx.slots:SlotRegistry 同时提供 inject(key, callback) 和 register；前者跟随声明生命周期，后者的 inject factory 组装组件业务属性 |
| Web 组合 | `@deepseek-ai/dsh-web-app/cordis.patch.yml` | root 压缩器关闭，preset 中提供隔离实例；root 插件注入 compaction 会一直 pending，须按 Agent composition 获取 |

### 自定义记录不是稳定持久事件的任意扩展

TypeScript 的 SessionEventMap 可声明合并，不等于发布版存储校验自动认识新增事件。0.2.2-rc.1 明确提供实验性的 `plugin:` 记录通道：不进入模型消息表面，owner 校验 data；声明的类型不进入 released persistence schema，格式迁移只承诺尽力保留。

同版本跨进程恢复已通过。T79 可以据此验证关联投影，但必须固定版本、验证自己的记录结构，并对升级/缺记录明确报不可恢复，不能声称可在任意新版本稳定恢复。若业务需要超出此约定的权威数据稳定性，应通过资源提供者存储稳定引用并设计显式迁移，而不是伪造一个新的通用 SessionEvent 类型。

### 白板发布包与客户端缺口

`npm pack --dry-run` 的文件清单只有 index/client/tasks、patch、locale、icon、README、package.json；默认 `serverEntry=../local/bridge.ts` 不在发布包中。现有清单的 DSH engines 范围也不表示真机支持矩阵。

最小适配范围：

1. `workbench/dsh-plugin/client.js`：保留 slots.inject 的声明生命周期调用；真实 Web UI 里核对入口、面板、能力握手及卸载。不能把 register 的业务属性工厂当作同义替换。
2. `workbench/dsh-plugin/` 的分发/配置：显式桥接地址可以作为开发模式；T82 的预构建包必须携带 bridge 或通过声明的服务依赖取得它。
3. T79 按已验证的 handle、projection 和 controller 做关联、重连及服务侧产物写入；不要复制 Host 日志或把浏览器缓存当恢复。
4. T54 对 dsh-diagram 的客户端 slots、工具/skills、storage-domain、会话持久化与 webServer 路由逐一做版本适配；需要固定 fork/patch 及许可证来源。其旧版 sidecar 分叉/导出与多媒体限制仍须独立解决。

## 复现与退出条件

见 [spike README](../../workbench/spikes/dsh-providers/README.md)。脚本全部使用临时 DSH_HOME，成功/失败均清理该脚本创建的目录。进程恢复脚本不驱动模型；Host 白板读写脚本不驱动 Agent。安装脚本验证的是安装器拒绝不兼容版本与 profile 生命周期，其成功不代表被拒绝的绘图插件可用。

本卡不修改产品清单、不放宽 engines、不引入模型循环。T78 可使用本记录的资源/Host API 继续实现；实际 UI 与执行入口在验证完成前不得标可用。T66/T69 仍需真实模型和人工任务。Mac 后续验证连接中断，隔离试验目录未能确认清理；恢复连接后先核对该试验进程和目录，不重发未知的安装操作。
