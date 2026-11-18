# T76 DSH 插件组合契约与回复归属

| 项 | 内容 |
|---|---|
| 执行 | chatgpt（项目所有者本轮直接授权设计与实现） |
| 依赖 | T75（PR #101；未合并时以该分支为 base 提交叠加 PR，不改 main） |
| 分支 | `task/T76-dsh-plugin-composition` |

## 目标

将 DSH 插件组合方向落实为正式契约、复用清单和任务路由；普通 AI 回复留在协作对话，避免每次回复自动新增便签。

## 先读

`AGENTS.md`、`05-delivery-contracts.md`、00–04、T75、`dsh-plugin/tasks.js`、`tests/host-transport.test.ts`、`tests/host-browser.ts`（代码路径在 workbench 下）。

## 可改文件

- `AGENTS.md`、根 `README.md`；`docs/kernel-v3/README.md`、00–05，新建 06/07。
- 本卡、T77–T82；任务索引、`check_plan.py`；受影响卡的依赖、先读与复用边界。
- `workbench/dsh-plugin/tasks.js`、其 README；`workbench/tests/host-transport.test.ts`、`host-browser.ts`。

## 做法

1. 内核成为默认白板文档提供者；同步宿主/外部资源的状态权威、数据包与 DSH 插件的区别。
2. 06 明确资源、选区、宿主持久关联、产物、分叉/导出和降级；未来接口标注责任卡。07 标记候选的证据、版本缺口与责任。
3. assistant/message 仍转为对话事件，不再附加文本 HostResult。结构化工具产物保持兼容；显式正文创作走白板编辑工具。
4. 新旧卡依赖无环，规则/图形任务按复用与宿主边界推进；T75 已完成部分保留。

## 验收

- `python3 docs/kernel-v3/check_plan.py`：执行者/依赖一致、无环、链接有效。
- host-transport：普通回复可见且无作品产物，结构化表格保留来源；任务隔离和取消通过。
- test:host：对话出现回复，画布只增加结构化表格；独立 Agent 读回无“AI 回复”便签。
- `format:check`、`typecheck`、`npm test`、`build`、`test:host` 通过；真实 DSH/模型未测项交接 T77/T66。

## 交付

叠加 PR 以 T75 分支为 base，只展示本卡差异；待 T75 合并后改 base 为 main。作者与提交者仍使用仓库指定账号，提交不加模型归属署名。
