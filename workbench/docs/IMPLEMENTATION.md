# 首个只读切片：实施与验证记录

设计依据：仓库 `docs/DEVELOPMENT_PLAN.zh-CN.md` v0.3，D15–D17、D22–D28。
本记录只说明本 PR 的实现，不宣称 P0/P1 整阶段完成。

## 技术选择

- Node.js 22.18+ 原生 TypeScript 执行；官方 MCP SDK server/client 2.0.0、MCP Apps 2.0.3。
- React 19 + Vite 7 单文件 HTML，作为 `ui://sand-table/overview.html` 资源交付。
- TypeScript 5.9.3 AST 提取有限 JS/TS 结构，无 LSP 常驻进程，也不执行项目代码。
- 只读 stdio 服务器。CLI 显式绑定根目录；不依赖 Research OS API、事件库或旧前端。
- `core/` 管理会话与布局；`server/repository.ts` 负责代码投影；`board/` 消费投影；`dev/` 仅为验证宿主。通用公共 SDK 尚未抽取。
- 当前视图一对一绑定 boardId；session 等同该白板内存实例，多个实例隔离。持久化、多视图独立布局、嵌套及对象多实例留待 P2。
- 固定对象 ID 由实际根路径、相对路径与顶层符号名构成。工作区 snapshot 为本次索引文件及内容摘要，不是整个工作区指纹；P2 的修改提案不能直接复用它冒充全量基线。
- 布局、分组不是代码关系；后续意图 diff 必须增加明确的修改请求入口。

官方依据：已安装 SDK 类型定义及示例（`@modelcontextprotocol/ext-apps` server/react/app-bridge 模块），[MCP Apps](https://github.com/modelcontextprotocol/ext-apps)。未复制 archify 或 open-claude-ui 源码。

## 验证结果与边界

外部集成目标：[`lukeed/clsx`](https://github.com/lukeed/clsx)，提交 `925494cf31bcd97d3337aacd34e659e80cae7fe2`。只读当前检出内容，没有运行其代码。此仓库用于协议与引用测试，已阅读源码，**不是封存修复题目**。

本次重建后运行：

- `npm run build`：类型检查与单文件构建通过。
- `SAND_EXTERNAL_REPO=… npm test`：4 项通过，0 跳过。覆盖修订冲突、固定位置、分组上下文、过期清理、工作区活动映射、真实 stdio、坏引用、会话结束、未提交变更与 worktree 身份。
- `SAND_EXTERNAL_REPO=… CHROMIUM_PATH=… npm run test:browser`：真实 stdio → AppBridge → iframe → 选区与备注 → 测试客户端读取；分组、拖动、固定、活动报告、双主题、移动窄屏渲染、拒绝错误来源通过。
- 浏览器中的活动明确标为 Protocol test client；没有真实模型参与。

合成 Git 仓库仅测试内容指纹、路径和 worktree 不变量，不充当外部产品验收。

测试宿主是本地协议探针，不是商业宿主。未证明 Claude、Codex、Cursor 等任一客户端已可安装、展示或交换上下文；不能据此勾选 P0/P1 宿主验收。初学者理解、中文输入法真机体验、封存 Bug 修复基准、纯对话对照尚未执行。

## 读取与执行边界

服务器不接受任意根路径工具参数；只读 Git 跟踪文件，拒绝路径穿越、符号链接、二进制和超限文件。Git 用参数数组调用，禁用 fsmonitor；不会安装依赖、执行仓库脚本或读取源码以外的任意路径。不能将这些检查当作同机恶意进程下的完整隔离：文件检查和读取不是原子快照，宿主进程仍具有自身文件权限。

仓库文本、备注、解释都是不可信数据。React 文本渲染不执行其 HTML；MCP App 不需要外部网络。Agent 仍可能被源码中的恶意指令影响，工具提示明确要求按数据处理。

`app-only` 是 MCP 可见性元数据，不是服务器级调用者身份认证。服务器不控制宿主 Agent 的其他工具，也不能阻止宿主写文件。任何“改前确认”承诺必须等具体宿主流程实现后单独验证。

开发 HTTP 测试宿主仅监听 127.0.0.1，并检查 Host、Origin 和随机请求令牌；iframe 使用 opaque origin 和 CSP。它仅验证协议路径，未实现生产宿主完整的双 iframe 沙箱代理，不应部署到公网。

## 下一步

1. 在实际支持 MCP App 的用户客户端中验证安装、界面、真实工作区定位、选区读取、模型解释、刷新和断连；产出宿主能力矩阵。
2. 补齐面向初学者的项目用途、输入输出与一条功能路径讲解；当前源码入口列表不等于完整架构理解。
3. 确定并封存未阅读答案的外部 Bug 题目及评分标准。
4. P2：明确改动意图、具体补丁版本、所涉实际文件基线、确认、宿主写入及结果核对；随后实现嵌套、多实例与自定义主题。
5. P3：初学者真人与纯对话对照。旧界面验收及本次自动测试都不能替代。
