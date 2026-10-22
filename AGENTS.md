# 给编码 Agent 的说明

本仓库的分工：架构负责人写设计和任务卡，编码 Agent 按任务卡实现，架构负责人在 PR 评论里审查，项目所有者决定合并。

## 接到任务后

1. 读完本页。
2. 读你的任务卡 `docs/kernel-v3/tasks/Txx-*.md`。**只做卡片上写的事。**
3. 只读卡片“先读”里列出的文档和文件。
4. 不要从下列文档推断设计，它们是历史记录，很多决定已被推翻：`docs/DEVELOPMENT_PLAN.zh-CN.md`、`docs/architecture/`、`docs/reviews/`、`workbench/docs/ARCHITECTURE-HANDOVER.md`、`workbench/docs/ISSUES-CLEARANCE-PLAN.md`、`workbench/docs/ISSUE-RESOLUTIONS.md`。
5. 任务卡与 `docs/kernel-v3/` 的设计文档冲突，或者你拿不准时：**停下来**，在 PR 描述里写“需要架构确认：……”，不要自己猜。

## 硬规则

- 只改任务卡“可改文件”里列出的文件。确实需要改别的文件，先停下来问。
- 不重构任务以外的代码；不顺手改格式、改名、挪文件。
- 只引入卡片点名的依赖，版本号写死（不写 `^`、`~`）。
- 一张卡一个分支一个 PR。分支名 `task/Txx-简短英文`，PR 标题 `Txx: 中文标题`，描述按 `.github/pull_request_template.md` 填写。
- 提交前在 `workbench/` 下运行 `npm run format:check`、`npm run typecheck`、`npm test`，以及卡片“验收”里要求的其他命令，全部通过才提交。
- 不要把测试改松来让它通过。测试失败说明实现或理解有问题。
- 代码注释只写代码本身表达不了的约束。不要写“根据任务卡”“这次修改是为了……”这类给审查者看的话。
- 界面和错误信息用中文，具体到能指导用户下一步怎么做。
- PR 描述如实写没做到的部分。issue 和 PR 描述要短，写现象、做法、结果；不要写“未宣称”“关闭不等于修复”之类的固定段落。

## 提交身份

所有提交的作者和提交者都必须是 `victorzhong0110 <victorzhong0110@gmail.com>`。用本次命令的环境变量设置，**不要修改 git config**：

```bash
GIT_AUTHOR_NAME=victorzhong0110 GIT_AUTHOR_EMAIL=victorzhong0110@gmail.com \
GIT_COMMITTER_NAME=victorzhong0110 GIT_COMMITTER_EMAIL=victorzhong0110@gmail.com \
git commit -m "说明"
```

提交说明里不能有 `Co-authored-by`。推送前运行 `git log -1 --format=%B` 检查；如果工具或钩子自动加上了，用 `git commit --amend` 删掉（同样带上面的环境变量）再推送。

## 常用命令

在 `workbench/` 目录下：

| 命令 | 作用 |
|---|---|
| `npm ci` | 安装依赖 |
| `npm run format:check` | 格式检查 |
| `npm run typecheck` | 类型检查 |
| `npm test` | 单元与集成测试 |
| `npm run test:blank` | 空白白板浏览器测试（需要 Chromium，可设 `CHROMIUM_PATH`） |
| `npm run test:local` | 本地宿主浏览器测试 |

在仓库根目录：`npm start` 启动本地工作台。

## 目录速览

| 目录 | 状态 |
|---|---|
| `workbench/kernel/` | v3 内核（新建中）。只能依赖 `node:*`、`ajv` 和自己 |
| `workbench/packs/` | v3 内置包（新建中）。只能依赖 `workbench/kernel/index.ts` |
| `workbench/server/v3/` | v3 MCP 工具面（新建中） |
| `workbench/core/`、`workbench/server/`（v3 子目录除外）、`workbench/domains/`、`workbench/connectors/` | v2，将在 T24 删除。Phase 1、2 期间不要修改，除非任务卡明确要求 |
| `workbench/board/` | 白板界面（React） |
| `workbench/local/` | 本地浏览器宿主与 MCP 桥接 |
| `workbench/dsh-plugin/` | DeepSeek Harness 插件 |
| `src/`（仓库根目录） | 旧 Research OS 界面，与本项目无关，不要修改 |
