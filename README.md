# Sand Table

人和自己的 AI 共用的一张交互沙盘。用总览理解一个代码仓库，点击源码和功能路径追溯依据，用拖动、分组和备注表达关注，并看到 Agent 在哪个工作区做什么。

**当前版本：可本地运行的只读工作台。** AI 使用你已有的本机 MCP 客户端；项目不提供模型服务，也不需要新的 API Key。修改代码仍由你的 AI 客户端执行，目前没有内置补丁确认与应用流程。

## 直接开始

需要 **Node.js 22.18+** 和 **Git**。Python 符号索引还需系统 `python3`；缺少时仍可读文件，界面会说明符号未索引。先把你想理解的项目克隆到本机，然后执行：

```bash
git clone https://github.com/victorzhong0110/sand-table.git
cd sand-table
npm start -- /absolute/path/to/your-repository
```

把最后一行的路径换成目标仓库目录。首次启动自动安装本项目的固定版本依赖并构建界面，然后打开浏览器；之后启动会复用构建。它不会安装或执行目标仓库的代码。

1. 在白板中点“项目说明”或代码卡片，查看真实源码；Shift 可多选，编排模式可拖动、固定、分组。
2. 点顶部 **“连接我的 AI”**，复制页面生成的 Codex CLI 命令，或通用 MCP JSON／Codex TOML，安装到你的本机客户端。
3. 回到该客户端的新会话，粘贴页面的 **“复制当前选区提问”**。Agent 读取的正是浏览器里的板子、选区和备注；它提交的功能讲解和活动也会出现在这里。

MCP 配置只需安装一次。保持启动终端运行；Ctrl+C 结束服务并清除白板。重新启动后，已有配置会连接新会话，不恢复旧整理。若浏览器没自动打开，使用终端打印的完整启动链接。

浏览器中的普通 ChatGPT 对话不能直接使用本机 stdio 配置。需要在同一台电脑上的 MCP 客户端中完成第二步；当前聊天网页不会因为你在本机安装配置而自动获得连接。

## 现在可以做什么

- 同一总览包含最多四个仓库或 worktree；对象与 Agent 活动对应各自实际工作区。
- 阅读 JS / TS / JSX / TSX / Python / Markdown，按需显示包含、导入和可能调用关系，明确报告未索引范围。
- 让 AI 提供用途、输入输出、功能步骤、源码依据和未知项；点击步骤定位图上对象。
- 源码变化时拒绝旧引用，刷新后标记失效讲解；未提交变化也会被识别。
- 黑白与温暖纸张主题；浏览、编排和 AI 上下文模式。
- 支持在兼容客户端内呈现 MCP App；本地浏览器也是同一 App 的呈现入口。

功能讲解需要你的 AI 读取源码后提交；界面不会按文件名编造架构。活动来自 Agent 自报，连接状态不代表模型正在思考。当前语法索引不等于整个仓库已被理解。

## 多工作区与启动选项

```bash
npm start -- --workspace frontend=/absolute/frontend --workspace backend=/absolute/backend
# 不自动打开浏览器
npm start -- /absolute/repository --no-open
```

仅监听 `127.0.0.1`，自动选择空闲端口。临时目录中的私有连接文件仅用于本机 MCP 接入；启动链接含会话凭据，打开后会从地址栏移除。不要分享完整链接。不会建立白板数据库或历史记录。

详见 [使用与开发说明](workbench/README.md)、[接入与故障排查](workbench/docs/QUICKSTART.md)、[已验证范围](workbench/docs/IMPLEMENTATION.md)、[v0.3 开发规划](docs/DEVELOPMENT_PLAN.zh-CN.md)。

## 开发与验证

```bash
cd workbench
npm ci
npm run build
npm test
```

外部集成和浏览器验证使用固定版本的 `lukeed/clsx`，不执行或向它提交代码。设置 `SAND_EXTERNAL_REPO` 后运行 `npm test`、`npm run test:browser` 和 `npm run test:local`；浏览器需要 Playwright Chromium，详见工作台说明。

Linux 环境的完整启动／共享会话链路已有自动验证。macOS 使用系统 `open` 打开浏览器，尚待真人实机确认。Windows 未验收。真实模型讲解质量、初学者理解、补丁流程和对话对照仍在后续计划中。

## 旧界面与许可

根目录原有的 Research OS 界面仍保留，使用方式见 [旧界面说明](docs/LEGACY_RESEARCH_OS.md)。它与 `workbench/` 的 MCP 实现独立。

Apache-2.0。Copyright 2026 victorzhong0110。保留原始历史与来源声明。
