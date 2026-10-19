# Sand Table

人和自己的 AI 共用的一张交互沙盘。通过空间总览理解仓库、追溯源码依据、表达改动意图，并核对 Agent 实际完成了什么。

白板是总览，可以跨越多个仓库与 Agent 工作区；工作区只是其中一部分。组件之间既有包含和从属，也有并列、依赖、比较和证据关系。你可以浏览详情、编排组件，或让自己的 Agent 维护白板。

## 直接开始

需要 **Node.js 22.18+、Git**，以及你已有的本机 stdio MCP 客户端。Python 符号索引另外使用系统 python3；没有时仍能阅读文件。

~~~bash
git clone https://github.com/victorzhong0110/sand-table.git
cd sand-table
npm start -- /absolute/path/to/your-repository
~~~

首次启动安装本项目的固定版本依赖并构建界面，然后打开浏览器。只索引目标仓库，不自动安装或运行目标项目。保持终端运行；没有自动打开时，使用终端打印的完整链接。

1. 点击“项目说明”开始，或搜索代码卡片、阅读源码与有引用的功能讲解。
2. 点击 **“连接我的 AI”**，把页面生成的通用 MCP JSON 安装到你的本机客户端。页面也提供 Codex 格式。
3. 在该客户端粘贴 **“复制当前选区提问”**。Agent 会读取同一张白板的选区、备注和编排变化。
4. 切换 **“编排”**，拖动、调整尺寸、固定、分组、复制引用或进入子白板；右侧 **“组件”** 提供组件和场景预设。
5. 要改代码时，在 **“改动”** 填写请求及允许的文件。Agent 提交具体目标内容后，审阅 Diff 并确认这一版，再回到 AI 对话要求继续处理已确认提案；Agent 使用宿主工具写入，核对实际结果和测试报告。

**项目不提供模型服务，也不需要新的 API Key。** 普通浏览器聊天不会因本机安装 MCP 配置而自动连上；请使用同一台电脑上的 MCP 客户端。支持 MCP App 的宿主也可直接呈现这张界面。

## 已实现的工作流

- 最多四个仓库或 worktree 共用总览；活动对应实际工作区，明确区分 Agent 自报与最近已知状态。
- JS / TS / JSX / TSX / Python / Markdown 源码索引；包含、导入和可能调用关系；分段读取、内容指纹、覆盖缺口与过期讲解。
- 嵌套白板、同一源码对象的多个独立实例、每个视图独立的选区和相机；拖动、缩放、框选、调整大小、固定与键盘操作。
- 18 种内置组件：源码引用、白板和入口、文本、标题、资源／媒体、代码片段、指标、状态、图表、表格、事件、任务、推理、比较、意图、提案、验证。
- Bug 修复与研究比较预设；手动表单或 Agent 配置组件；未知组件保留数据并显示占位。
- 黑白、温暖纸张与自定义颜色、字体、密度、圆角、减少动效；自定义正文对比度提示。
- 明确意图 → 实际文件基线 → 具体提案版本与摘要 → 人确认 → 宿主写入 → 实际内容及范围核对 → 绑定内容指纹的测试自报。

## 改动与生命周期

整理、连线和备注表达关注，**不自动授权修改文件**。确认绑定具体提案版本和 digest；提案替换、意图修订和实际内容变化需要重新检查。Sand Table 的源码服务器只读，写入由你的 Agent 客户端完成；检查与宿主写入之间并非原子操作，强制约束取决于宿主。测试报告会注明自报来源，不冒充服务器运行的测试。

白板只存在于内存，不建立整理历史数据库。关闭进程会清空；MCP 配置可在重启后连接新会话。Git 保存你选择提交的代码版本。组件媒体也随会话结束清理。

~~~bash
npm start -- --workspace frontend=/absolute/frontend --workspace backend=/absolute/backend
npm start -- /absolute/repository --no-open
~~~

仅监听 127.0.0.1。启动链接含本机会话凭据，打开后从地址栏移除；请勿分享完整链接。

## 验证与当前边界

~~~bash
cd workbench
npm ci
npm run build
npm test
~~~

外部集成使用固定版本的 lukeed/clsx 和 huggingface/huggingface_hub。完整改动测试在 clsx 的可丢弃副本中，由独立测试宿主写入并运行一个明确的源码断言；不会向外部仓库提交内容。

本地 Linux 启动、共享 MCP 会话、浏览器交互与改动链路有自动检查。**用户实际 Mac／MCP 客户端、真实模型讲解质量、初学者真人和受控对话对照仍需实际验收**；脚本通过不等于这些项目通过。当前没有公共组件代码执行 SDK、过程回放、多人协作或对外 Issue／PR 提交功能，这些属于规划中明确延后的范围。

详见 [工作台说明](workbench/README.md)、[快速上手](workbench/docs/QUICKSTART.md)、[实现与证据](workbench/docs/IMPLEMENTATION.md)、[真人验收](workbench/docs/HOST_ACCEPTANCE.md)、[盲评工具](workbench/acceptance/README.md)、[开发规划](docs/DEVELOPMENT_PLAN.zh-CN.md)。

根目录旧 Research OS 界面独立保留，见 [旧界面说明](docs/LEGACY_RESEARCH_OS.md)。

Apache-2.0。Copyright 2026 victorzhong0110。保留原始历史与来源声明。
