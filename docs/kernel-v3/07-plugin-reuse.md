# 插件复用清单与证据

候选初查：2026-11-13；固定发布版实测：2026-11-16。归属与接口以 [06-plugin-composition.md](06-plugin-composition.md) 为准。T77 已完成真实 Host 基础验证，结果见 [ADR 0008](../adr/0008-dsh-provider-matrix.md)；组合 UI 与真实模型仍未验收。包的安装说明、下载量、星数不代替兼容性或恢复验证。

## 本轮实测结论

| 项 | 结论 |
|---|---|
| 基线 | DSH 0.2.2-rc.1，CLI 要求 Node >=24.9.0；Linux Node 24.22.1 上完成验证 |
| 会话/投影 | 两个真实 CLI 进程完成 JSONL 冷读、单写者/只读、消息重建、投影注销/重注册 |
| 上下文 | dsh-context 0.85.1 的 Host 投影运行；官方 profile 安装、卸载、重装通过；UI 未测 |
| 白板 | 真实 DSH 的四个工具注册并完成创建/读回；客户端仍调用已移除的 slots.inject，需适配 |
| 绘图 | dsh-diagram 0.6.1 被该宿主拒绝，未安装；不豁免旧版约束，T54 做版本适配评估 |
| 运行边界 | Web 压缩器位于隔离 Agent preset，不能依赖 root compaction；实验 plugin: 记录不能承诺跨版本无损 |
| UI/模型 | Mac 基础 DSH 界面渲染通过，后续连接超时；组合 UI、真实模型、Desktop 和实际压缩/搜索未测 |

下表的“候选”保留初查背景，当前采用与适配范围以以上固定版本结果及 ADR 的接口/源码哈希为准。

## 证据等级

- 文档：确认有公开能力说明，不代表目标版本可用。
- 静态：检查精确包/源码及接口，记录版本或提交。
- 宿主：在固定版本的真实 DSH 安装、加载、调用与重启通过。
- 场景：人与 Agent 完成具体跨插件工作流；记录模型、资源与异常测试。

等级不可跳跃；fixture 测试记为 fixture，不能写宿主或场景通过。T77 填写锁定版本、来源、包完整性、运行命令和结果。

## 能力选择

| 能力 | 优先复用 | 现有证据 / 本轮选择 | 缺失集成 / 责任 |
|---|---|---|---|
| 加载、生命周期、组合 | DSH profile/bundle/Cordis | 官方架构文档；采用宿主机制 | T77 固定版本，T82 发布组合 |
| 会话记录/持久化 | DSH session、session-persistence 及其 JSONL provider | 官方接口文档；采用 | T79 绑定事实与重连，不建聊天库 |
| 会话状态视图 | session-projection 与控制接口 | 官方投影文档；采用，需核对目标包 | T77/T79 注册与恢复验证 |
| 上下文计量/压缩 | token-meter、compaction-basic、tool-result-pruner | 官方 compaction 文档；默认优先 | T80 提供空间语义，测试压缩后可追溯 |
| 上下文观察 | bowenliang123/dsh-context | 作者文档确认 Context/Fleet 等入口；候选 | T77 验证兼容性，不复制其 dashboard |
| 替代压缩策略 | ranxianglei/billion-context | 作者文档有 DSH 安装路径；可选候选 | 单独 profile 比较，核查默认压缩器启停与恢复；不采信倍率承诺 |
| 消息编辑/失败重试 | @linxin666/dsh-chat-recovery | 作者包说明为分叉后重提最后消息；可选候选 | 不承担整个工作区恢复；T77 核对目标版本是否已有同等能力 |
| 网络搜索/读取 | DSH ctx.web + search/fetch providers + tool-web | 官方接口文档；采用 | 选定可用 provider；凭据由宿主管理 |
| 文件/进程/远程运行 | DSH fs/subprocess/jobs/MCP 对应能力 | 官方能力目录；具体 provider 待验证 | T77 核对；业务插件管理任务语义 |
| 可编辑绘图 | hanzhangzzz/dsh-diagram | 作者文档：0.6.1、Excalidraw 0.18.1；列出 DSH 0.1.7-rc.2 等验证版本 | 优先试装候选；T54/T81 补引用、版本、复制/导出 |
| 其他图形候选 | Jegozhou/dsh-excalidraw | 目录发现；本轮未取得足够作者源码证据 | 暂不选为默认，不把目录评语当验收 |
| 结构化总览画布 | 当前 React Flow 12.12.0 实现 | 本仓库已有固定依赖与测试 | 先保留，T78/T82 纳入提供者与组合 |
| 白板原生文档 | 当前 kernel SQLite/命令/历史 | 本仓库已有实现 | T78 包装成默认提供者，不先重写数据 |
| 非会话通用存储 | DSH storage-domain + JSON/SQLite providers | 官方存储文档；候选底座 | 先核对事务、版本和历史语义，不因名称相同强迁移 |
| 文档/表格/PDF/媒体/导出 | 已有组件与外部业务插件 | 当前卡片有不同实现与候选库，不能统称现成 DSH 插件 | 各卡先做复用审计；通过资源契约接入 |

## 已确认的适配缺口

1. 当前 `workbench/dsh-plugin/package.json` 声明 `>=0.2.1-rc.2 <0.3.0`，不是实测版本矩阵。dsh-diagram 文档列出的验证版本与此不同，不能直接宣布可用或擅自放宽 engines。T77 必须选择一个两端实测的组合；若没有，T54 记录需适配的接口与范围。
2. dsh-diagram 0.6.1 文档说明图形正文为 Excalidraw scene；会话分叉/导出不包含其 sidecar；该版本拒绝图片、iframe/embeddable 等内容。整板多媒体与独立副本能力不能由它的“有画布”推导。
3. dsh-context 主要提供上下文与 Agent 状态观察界面，不代表已公开可供 Sand Table 任意嵌入的 React 组件。通过公开 slot/service 集成，缺口写适配。
4. 当前 tasks.js/pendingTasks 为内存映射，client.js 用轮询转发事件；board/main.tsx 仍负责旧产物写入。T76 只移除普通回复自动落板，恢复与服务侧接收由 T79 完成。
5. 当前选区转换会按 objectId 去重，缺少完整展示坐标与布局版本；T80 保留 presentation 身份，不把正文去重扩展到空间信息。
6. 现有 PR #99/#100 的绑定和数据包工作继续维护原白板提供者；不得在其中提前加入 DSH 插件加载器、第二套运行服务或无契约的资源字段。

## T77 验证记录必须包含

| 项 | 要记录的事实 |
|---|---|
| 组合 | DSH 精确发布版本/提交、Node/系统、profile、每个包版本及完整性 |
| 安装 | 隔离目录、构建/安装命令、发布包是否自足、是否依赖仓库外相对文件 |
| 接口 | 目标发布源码位置、注入服务、slots、Session 事件/投影/流与能力协商 |
| 能力 | 加载、读取、编辑、回复、产物、卸载、重装、Host 重启分别通过/失败/未测 |
| 状态归属 | 会话、作品、引用、缓存的提供者与存储位置；是否随分叉/导出携带 |
| 模型与权限 | 真实模型/脚本分别标明；使用何种已授权配置，不导出凭据 |
| 结论 | 默认/可选/需适配/不采用；失败证据、改动范围和复测入口 |

## 来源

- [DSH 架构与 profiles/bundles](https://deepseek-harness.github.io/deepseek-harness/en/reference/)
- [DSH 能力服务目录](https://deepseek-harness.github.io/deepseek-harness/en/reference/capability-services)
- [DSH 会话持久化](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/persistence)
- [DSH Session projections](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/session-projection)
- [DSH compaction 插件组](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/compaction)
- [DSH Web](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/web)
- [DSH UI slots](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/slots)
- [DSH storage](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/storage)
- [dsh-context](https://github.com/bowenliang123/dsh-context)
- [billion-context](https://github.com/ranxianglei/billion-context)
- [dsh-chat-recovery 作者包说明](https://www.npmjs.com/package/@linxin666/dsh-chat-recovery)
- [dsh-diagram 作者文档](https://github.com/hanzhangzzz/dsh-diagram)

以上网页可能滚动更新。T77 的精确包与源码记录才是后续实现的 API 依据，不能用本表里的未锁定网页证明某个发布版本支持某方法。

### 2026-11-17 槽位证据更正

ADR 0008 的原判断只查看 SlotCore，遗漏 renderer 提供的 SlotRegistry。后者在同一固定版本中提供公开 slots.inject(key, callback)，现有白板与 dsh-context 的调用无需因此改写。verify-api 同时核对两层发布源码；原始 client-api.json 另存为 client-api-2026-11-16.json，保留更正过程。静态接口匹配仍不计组合界面通过。
