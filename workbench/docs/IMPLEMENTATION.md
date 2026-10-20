# 实现与验证范围

依据：[开发规划 v0.3](../../docs/DEVELOPMENT_PLAN.zh-CN.md)。本文描述当前实现，不把自动测试、真人体验与受控收益评估混为一项完成状态。

## 当前能力

| 范围 | 实现 | 可重复证据 |
|---|---|---|
| 现有 Agent、MCP 与 App | 原生 stdio、单文件 App、本地浏览器、独立 bridge 同板 | protocol、browser、local |
| 实际工作区与源码 | 最多四个 Git 根、内容 hash、JS/TS/Python、分页与遗漏 | repository、python、protocol |
| 功能理解 | 引用校验、功能讲解与步骤定位、源码变化后过期 | core、browser；语义另需人工 |
| 空间交互 | 嵌套、包含、引用多实例、视图选区／相机、复制、移动、固定、尺寸、关系 | spaces、browser、full |
| 内置组件 | 18 类、表单、媒体、研究／Bug 预设、未知占位 | spaces、full |
| 风格 | 黑白、纸张、自定义色／字体／密度／圆角／减少动效 | browser、full |
| 意图同步 | 明确请求与文件范围、编排快照、上次读取以来的混合变化 | core、changes |
| 改动核对 | 实际脏工作树基线、具体版本 digest、确认、宿主写入、结果／范围核对 | changes、full |
| 验证报告 | 命令、环境、输出、来源与实际内容指纹 | full |
| 验收材料工具 | 封存任务、隔离参考、随机匿名候选、盲评分、条件分配 | acceptance 单元测试 |

实际用户 Mac／客户端及模型未在当前环境接入。商业客户端内嵌 App、真人初学者体验、封存 Bug 实际修复、独立盲评和纯对话对照均未判通过。通用 MCP 配置在独立 SDK 客户端验证，并不证明任意商业客户端的安装包格式兼容。

## 架构

- core/：投影、会话、对象身份、空间／实例／视图、意图、提案与结果。对象属于工作区；实例属于空间；工作区不是白板。
- server/repository.ts：受限源码索引、内容 hash 与引用校验。TS AST 和隔离 Python AST 不 import 或执行目标模块。
- server/worktree.ts、changes.ts：只读取实际文件、提出目标版本、核对内容和范围。不存在源码写工具。
- server/spaces.ts：类型组件配置、包含无环、固定约束、关系和主题。未知组件不执行代码。
- board/：浏览、编排、上下文；视口裁剪；详情、源码、Diff、组件表单和主题。
- local/：一份源 MCP 服务、HTTP AppBridge、可重连 stdio bridge。dev/ 仅为协议探针。
- acceptance/：显式运行的外部验收材料工具，与产品会话和文件写入分开。

官方 MCP SDK server/client 2.0.0、MCP Apps 2.0.3、React 19、Vite 7、TypeScript 5.9.3。没有复制 archify 或 open-claude-ui 源码。公共 SDK 及动态组件代码执行按 D01 延后。

## 文件与确认的含义

提案记录真实 beforeHash、完整目标内容或删除，以及所有绑定工作区的跟踪／非忽略未跟踪文件观察基线。它不是源码索引 snapshot：索引最多 120 文件／2 MB，修改核对另有 2 MB 单文件、64 MB 总量和 10,000 文件限制。忽略文件默认不纳入观察，显式目标仍读取；遗漏会说明，不声称覆盖完整文件系统。

用户确认绑定 proposalId、版本、digest 及意图版本。替换提案重置确认；修订意图使已有提案失效。预检查和每文件读取再次观察；实际写入仍在宿主。核对区分未应用、部分、符合、偏离与观察不完整，并检查范围外路径及已有文件权限变化。

确认不是条件写事务，也不是恶意本机进程隔离。app-only 是协议可见性，不能证明调用者是人。若宿主未提供强制拦截，这条路径属于可审阅的工作约定；不能阻止 Agent 绕过其他宿主工具。

验证报告是 Agent 自报；绑定当时实际工作树内容指纹。刷新重核对提案，内容再次变化时旧报告显示与当前结果不一致。文件符合不证明行为正确；测试通过也不证明全部需求覆盖。

## 生命周期和资源边界

白板最多 8 个，闲置期限 30 分钟；已落盘工作空间的白板不因闲置回收，作品始终在文件里。视图最多 16 个。单板最多 80 空间、2,200 实例、500 人工关系；组件数据 40 KB，图表 100 点，表格 20 列／200 行。媒体每份 2 MB、每板 12 MB。

## 通用工作空间内核（issue #11）

契约与迁移映射：[工作空间内核契约](../../docs/architecture/workspace-kernel.zh-CN.md)。

| 范围 | 实现 | 可重复证据 |
|---|---|---|
| 工作空间落盘 | `core/workspace.ts`：原子写、备份回退、版本迁移、导出／导入；`core/persistence.ts` 接线 | workspace、kernel |
| 原生内容一等公民 | `core/content.ts`：对象／展示实例分离、版本冲突、引用策略、语义关系 | content、kernel |
| 撤销与审计 | `core/history.ts`：按意图分组的撤销栈、只追加的审计日志、外部效果边界 | history、kernel |
| 统一读回 | `sand_list_objects` / `sand_read_object`：原生内容与代码对象一起返回，用 `kind` 区分 | kernel、protocol |
| 保存可观察 | 保存失败与读取失败都进入 `sand_workspace_status`，不显示虚假的「已保存」 | kernel |

工作空间默认落在 `~/.sand-table/workspaces/<ID>/workspace.json`（`--workspace-dir` / `--workspace-id` 可改）。
去掉 Git、源码索引和 AI 连接后，白板仍可创建内容、编辑、保存、重开。

尚未完成：工作空间选择器与多工作空间管理、导出／导入的界面入口、领域包与连接器（issue #13）、
小说／科研场景（issue #14）、真人验收（issue #15）。

完整 App 数据置于 _meta.data，模型端整板调用只获摘要。空间分页与选区结果有数量限制，大组件按 ID 单独读取。intentDiff 只比较上次读取快照，不积累历史。

本地服务只监听 127.0.0.1，检查 Host、Origin 与随机 token；私有连接文件为 0600，目录 0700，仅存连接信息。公开 HTML 无凭据；iframe opaque origin、CSP 无外部网络。外部链接仅 HTTP(S)，媒体为受限上传，不执行组件 HTML。

## 外部验证场景

- lukeed/clsx@925494cf31bcd97d3337aacd34e659e80cae7fe2：实际 stdio、源引用、浏览器、共享会话和完整改动测试。完整测试在独立副本执行已知的混合输入断言。
- huggingface/huggingface_hub@bb2ef7579c3d2dc2eb49b16ccf15a070fe5b7023：根 README 和实际 snapshot_download Python 实现，120 文件、1,154 对象，遗漏明确报告；索引不执行目标代码。
- 研究比较预设：与代码领域相同空间／实例／组件内核，浏览器表单编辑图表、键盘尺寸、自定义主题；只是非代码交互检查，不是该领域真人收益证明。

这些仓库已被开发者阅读，不能再称为盲测修复题。新的封存任务由独立出题者准备，参见 [验收工具](../acceptance/README.md)。

## 尚需实际参与者完成

1. 用户指定客户端的真实安装、工具调用、中文输入法、App 呈现或浏览器共享模式。
2. 真实模型的源码讲解语义与修改质量；未知项是否诚实。
3. 初学者独立完成新交互流程，记录理解、错误和求助。
4. 外部封存修复题、匿名独立评分和受控纯对话对照。

以上项目不能靠继续编写模拟脚本宣称完成。过程回放、公共组件代码 SDK、多人、产品内对外提交属于明确后续范围。

## MCPB 分发与性能场景

新增独立 MCPB 0.3 bridge 包，构建时打入运行依赖与许可，不含仓库、模型或会话 token。官方 schema 验证与解压后独立 SDK 客户端链路分别检查；真实商业客户端安装仍需实测。通用 JSON 继续可用。

固定 HF Hub 场景在本次 Linux / Node 24.19 自动测得：服务就绪约 4.4 秒，打开页面到首卡约 0.54 秒，搜索约 0.24 秒；1,153 实例中首屏渲染 12 个，源码边 1,781。交互后帧间隔 P95 约 16.8 ms，只是该测试设备的一次样本，不泛化为 Mac 或拖动全过程性能。可通过 test:performance 重测，CI 保存机器可读报告。

自动检查新增创建／删除文件、权限变化、不同意图不得复用提案、上下文差异与清理。空间搜索会定位结果，编排请求顺序处理，避免快速双击选区与进入白板相互冲突；新组件寻找空位，选中视野外实例时定位。


明确改动意图绑定发起视图，而非借用其他窗口的最后选区；快照包含空间、实例几何、关系与备注。模型读取只给摘要，冻结编排与当前编排分别分页，避免把多份千节点快照重复送进上下文。验收评分重新校验封存摘要，修改标准后不能沿用原摘要评分。


## 本轮最终检查

16 项自动测试通过且无跳过，另完成浏览器回归、根启动器／重连、独立 MCPB 完整改动链路和固定大图场景。MCPB 按官方 v0.3 JSON Schema 校验通过。完整路径的页面截图与性能 JSON 随 CI 构建产物提供。测试与开发仓库均不冒充封存真人评估。


## 集成轮（issue #20，2026-10-20）

把 #5（交互基线）、#12（交互与接入）、#16（通用工作空间内核）、#19（新架构下的标题与层级修复）
合成一个可用版本。规格与逐条裁决见
[集成契约](../../docs/architecture/integration-2026-10.zh-CN.md)。

| 范围 | 实现 | 可重复证据 |
|---|---|---|
| 一套历史 | 按意图分组 + 实体快照（object/presentation/relation/board 键）；审计只追加 | `tests/history.test.ts`、`tests/integration.test.ts` |
| 板级内容可撤销 | 嵌套白板、分组、主题、组件包、布局锚点按键记录 | `tests/integration.test.ts` |
| 自动保存与并发 | 600ms 防抖；只提交真正改动的字段；同字段冲突明确报错并保留草稿 | `tests/integration.test.ts` |
| 校验唯一入口 | `core/spaces.ts` 的 `checkComponentData`，报错带下标路径 | `tests/spaces.test.ts`、`tests/packs.test.ts` |
| 组件包 | 数据型预设包；导入可撤销、随白板落盘；未知类型保留并给提示 | `tests/packs.test.ts` |
| 标题同源 | 折叠/展开/图标态、无障碍名称、属性栏、搜索都从对象解析 | `tests/blank.ts`、`tests/kernel.test.ts` |
| AI 入口 | 只有宿主能发能收才显示直接对话；只有 MCP 时只留接入状态与外部路径 | 人工验收（浏览器） |

**本轮没有做的**：发布与真人验收（#15）。真人验收需要真实被试、任务脚本与记录，
脚本通过不等于它通过。

## 收尾轮（2026-10-20）：内核加固与领域扩展

本轮把上一轮列为「仍未做」的前五项补齐。规格与逐条裁决见
[工作空间管理与文件锁](../../docs/architecture/workspace-management.zh-CN.md)、
[历史时间线](../../docs/architecture/history-timeline.zh-CN.md)、
[领域包与连接器](../../docs/architecture/domain-packs.zh-CN.md)、
[DSH 宿主集成](../../docs/architecture/dsh-integration.zh-CN.md)。

| 范围 | 实现 | 可重复证据 |
|---|---|---|
| 跨进程文件锁 | `<工作空间>/workspace.lock` 独占创建；可重入；陈旧锁抢占；超时明确报错 | `tests/workspace-lock.test.ts`（13 例） |
| 多工作空间管理器 | list/create/open/rename/delete/switch；切换前先落盘，落盘失败即中止 | `tests/workspace-manager.test.ts`（12 例） |
| 撤销到任意记录 | 历史从双栈改成**分支时间线**：新编辑分叉，旧分支仍可达 | `tests/timeline.test.ts`（22 例）、`tests/integration.test.ts` |
| 领域包与连接器 | 类型/组件/关系/工具/模板来自注册表；folder（只读）与 git（写入需确认）两个连接器 | `tests/domains.test.ts`、`tests/connectors.test.ts` |
| 小说/科研纵向验证 | 两个领域包 + 三个场景的**可重复**自动测试（人物双板展示、引用失效识别、混合工作空间） | `tests/vertical.test.ts`（9 例） |
| DSH 宿主集成 | 宿主桥协议（能力探测 + 结构化任务提交）；按官方 bundle 规范写的插件包 | `tests/host-bridge.test.ts`（9 例）、`tests/dsh-plugin.test.ts`（9 例） |
| 领域写路径 | 领域类型能过统一写路径；推测关系必须给依据；资源引用可登记/失效/撤销 | `tests/domain-write-path.test.ts`（4 例） |

### 迁移说明（#13 要求写明）

| 原来 | 现在 | 兼容性 |
|---|---|---|
| `server/repository.ts` | `workbench/domains/code/indexer.ts` | 内部路径变化，**MCP 工具语义不变** |
| `server/python.ts`、`server/python_index.py` | `workbench/domains/code/python-indexer.ts` | 同上 |
| `server/import.ts`、`server/worktree.ts` | `workbench/connectors/git.ts` | 同上；写入确认链路一字未改 |
| `core/spaces.ts` 里的代码类组件 | 代码领域包的注册表 | 同上 |
| 工作空间文件 `history: {undo, redo}` | `history: {version: 2, entries, cursorId}` | **文件格式版本 1 → 2**，读旧文件自动迁移，记录一条不丢 |

**MCP 工具语义没有静默变化**：`sand_*` 工具名与参数含义保持不变。
新增的工具是加法：`sand_list_workspaces` / `sand_create_workspace` / `sand_switch_workspace` /
`sand_rename_workspace` / `sand_delete_workspace`。
唯一的参数扩展：`relate` 操作新增可选的 `evidence`（关系可挂外部定位）。

### 行为变更（会影响用户）

- **工作空间文件格式从 v1 升到 v2**：历史从双栈变成分支时间线。旧文件自动迁移，不需要手工处理。
- **保存变成异步**：跨进程锁的等待是异步的。`flushSave()` 现在会**抛错**（保存失败必须能被调用方看见），
  定时保存路径自己 catch，错误照旧显示在「保存失败」上。
- **推测性关系必须给依据**：`status: "inferred"` 而没有 `basis` 的关系会被拒绝（契约 I5）。
- **多工作空间**：默认仍是单个工作空间；管理器是加法，不改变默认路径。

## 空白画布修正（2026-10-20）

默认入口改为不带仓库的 npm start、零组件画布与侧边工具箱。浏览／编排／AI、组件分类、拖入位置、按需属性、嵌套与可选场景是初始体验；不再展示项目统计、源码列表或改动面板。

代码是可选领域：人明确导入本机 Git 根，动态连接后把文件夹／文件场景放入当前空间中的子白板。源码索引仍有限，刷新不自动重铺画布。动态根由 App 导入工具接收；app-only 仍不构成调用者身份认证，不能向不可信本机客户端暴露会话。

AI 编排使用 MCP 消息交接和已有客户端；本地宿主只准备消息供人复制发送，不内置模型。空白板可读取没有选区的上下文。

旧代码场景保留为显式预设以复用源引用和提案回归，不作为默认入口验收。新增 test:blank 从真正的零工作区启动检查完整新路径。


通用空间活动新增 sand_report_space_activity：无需代码工作区即可自报实际空间与实例的任务，卡片和顶栏显示标识，超过 60 秒标记最后已知；不会把 MCP 连接或脚本探针冒充真实模型正在思考。AI 交接消息明确绑定 boardId、viewId、spaceId，并同步该视图的关注范围。


新入口的自动验收使用真正的零工作区启动，覆盖空板、拖入、正文编辑、子白板、明确 AI 交接、空间活动、主动导入外部仓库、源码读取、进入源码组件属性、提交代码意图、主题及窄屏。18 项单元／外部协议检查通过；原代码流程回归继续独立执行。真人 Mac／客户端仍需实际参与者验收，脚本不代替真人结果。
