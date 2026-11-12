# T75 白板内的直接 AI 协作

| 项 | 内容 |
|---|---|
| 执行 | chatgpt（项目所有者本轮直接授权设计与实现） |
| 依赖 | main `aa0b806`：T31、T37、T38 与已有宿主桥 |
| 分支 | `task/T75-whiteboard-dialogue` |

## 目标

按项目所有者要求，以 Claude Whiteboards 的直接协作为交互方向。首个增量完成：白板与选区都有直接入口、明确的目标范围、连续对话记录、真实宿主反馈。后续图形、评论、导出与组件任务继续复用现有卡片。

## 先读

`AGENTS.md`、`05-delivery-contracts.md`、`04-canvas.md`、`workbench/core/host-bridge.ts`、`board/main.tsx`、`board/CanvasShell.tsx`、`board/data-client/adapter.ts`、`tests/host-browser.ts`。

## 可改文件

- 本卡、`docs/kernel-v3/tasks/README.md`、`docs/kernel-v3/04-canvas.md`、`README.md`。
- `workbench/board/CanvasShell.tsx`、`workbench/board/main.tsx`、`workbench/board/style.css`。
- 新建 `workbench/board/ai/{context.ts,conversation.ts,WhiteboardAI.tsx}`。
- `workbench/tests/whiteboard-ai.test.ts`、`workbench/tests/host-browser.ts`、`workbench/tests/blank.ts`。

不增加依赖、内核表、模型服务或 Agent 循环，不修改其他进行中的 T39/T40 分支。

## 做法与边界

1. 顶部固定“和 AI 协作”；选区另有“询问选区”。右侧协作面板与画布并存，支持当前白板／当前选区切换、目标标题预览及整理、查漏、总结的可编辑草稿。
2. 发送只使用真实 `HostBridge.submitTask`。没有任务能力时展示连接说明与帮助入口，不显示可发送的输入框，不用复制提示词或本地 `app.sendMessage` 回显假装执行。
3. 目标从 `views[viewId].selection` 的展示编号解析成对象与版本；同对象多个展示去重。请求固定提交时的白板、对象版本、上下文修订号。缺对象、缺版本、空选区、超过 200 个目标时明确拒绝，禁止静默降级为整板。
4. 每块白板的草稿和对话在本次打开期间独立保留；收起面板不丢失。明确提示刷新不保存对话。每块白板最多保留 50 次交互，达到上限需清空已结束记录后继续。
5. 一次发送期间防重复，宿主拒绝保留草稿。任务记录绑定 taskId，其他任务事件不改本次状态，终态不因迟到事件回退；提交应答与事件乱序仍能关联。取消按宿主确认显示；现有 DSH 只支持取消运行中的任务，按钮按这一真实边界显示。
6. 白板编辑仍通过既有宿主工具、命令、历史与冲突检测。此卡不承诺真实模型质量、多人协作或宿主真机验收。

## 验收

- 单元：展示编号到对象版本、重复展示、空板／空选区、无效版本、200 上限、子白板隔离、请求快照、事件隔离与终态保护。
- `test:host`：真实本地服务＋插件＋脚本执行端，验证发送、选区目标、范围切换、连续记录、收起重开、快速双击、失败保留草稿与停止；明确区分脚本夹具与真实模型。
- `test:blank`：独立模式入口只显示说明，没有假发送框；已有白板交互继续通过。
- `format:check`、`typecheck`、`npm test`、`build`、`test:host`、`test:blank` 全部通过。
