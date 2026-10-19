# Sand Table

人和 AI 共享的交互沙盘：从总览进入真实代码，圈定关注范围，并看到 Agent 在哪个工作区做什么。

**开发状态：** 新实现位于 [`workbench/`](workbench/README.md)，提供只读 MCP 服务器与 MCP App 的 P0/P1 开发切片。已验证本地协议链路，真实 AI 客户端和真人验收尚未完成。完整方向见 [v0.3 开发规划](docs/DEVELOPMENT_PLAN.zh-CN.md)。

## 旧 Research OS 界面

以下为保留的旧实现；与新的 MCP 工作台独立。

沙盘。[LLM Research OS](https://github.com/victorzhong0110/llm-research-os) 的图形交互界面。源码取自上游 `web/`，对应 `main` 的 `c6b21b9`。

浏览器里可以查看同一份已记录研究事实：项目、规范修订、执行图、Run、事件与日志、决策与授权、指标、制品、环境，以及研究流程和操作。界面不另存配置。执行图只展示已验证的规范或计划节点和依赖边，不能把布局写回语义身份。

本地 API、事件库和 `researchos web serve` 仍在上游仓库。本仓库负责界面源码和构建产物。页面必须由那个本地服务打开：API 只接受启动它的 loopback 来源，Vite 开发服务器过不了这道检查。

## 开发

需要 Node.js 22。

```bash
npm ci
npm run typecheck
npm run build
```

默认产物在 `dist/`。要让上游服务器使用这份界面，把产物写进它的静态目录后再启动：

```bash
RESEARCHOS_STATIC_DIR=../llm-research-os/src/llm_research_os/web/static npm run build
```

在上游仓库中：

```bash
uv run researchos web serve --root ./ws --port 8787
```

打开命令打印的一次性引导链接。链接片段里的密钥不会发给服务器；会话建立后地址栏里的片段会被清掉。

## 浏览器冒烟

冒烟测试启动上游仓库里的合成夹具服务器，打开的是该仓库静态目录里的已构建包。先按上一节把本仓库构建进那个目录，再跑：

```bash
RESEARCHOS_ROOT=../llm-research-os npm run test:browser
```

未设置 `RESEARCHOS_ROOT` 时，默认使用同级目录 `../llm-research-os`。

## 类型

`src/generated/local-api.ts` 由上游 `scripts/generate_web_types.py` 从 Python 契约生成。契约变更后在上游仓库重新生成，再把文件同步回来。不要手改。

## 许可

Apache-2.0。Copyright 2026 victorzhong0110。
