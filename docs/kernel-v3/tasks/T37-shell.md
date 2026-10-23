# T37 外壳与信息架构

| 项 | 内容 |
|---|---|
| 执行 | grok |
| 依赖 | T30 |
| 分支 | `task/T37-shell` |
| 关联 issue | #25（§1.2 外壳与信息架构）、#28、#31 |

## 目标

界面变成“左侧窄导航 + 浮动面板 + 占满的画布”。去掉本地宿主页顶部那条重复的栏；连接 AI 的说明进“帮助”；Agent 正在做什么在画布上可见，但不抢你的视角。

## 先读

- `AGENTS.md`
- issue #25 的 §1.1、§1.2（视觉与外壳原则）
- `docs/kernel-v3/04-canvas.md` §6
- `docs/kernel-v3/02-commands-and-tools.md` §3.2（`sand_activity`）、§3.4
- `workbench/board/CanvasShell.tsx`、`workbench/board/main.tsx`、`workbench/local/service.ts`（顶栏 HTML）、`workbench/local/client.ts`（接入面板、复制消息）

## 开工前核对

确认 T30 已合并；`sand_context` 的 `otherAgents` 或等价数据能在界面拿到 Agent 活动。不一致先停下来问。

## 可改文件

- `workbench/board/CanvasShell.tsx`，新建 `workbench/board/shell/`（`Rail.tsx`、`Panel.tsx`、`HelpPanel.tsx`、`BoardsPanel.tsx`、`ActivityLayer.tsx`、`nav.ts`）
- `workbench/board/main.tsx`、`workbench/board/style.css`
- `workbench/local/service.ts`、`workbench/local/client.ts`（只删顶栏、把接入说明移进帮助）
- `workbench/tests/blank.ts`、`workbench/tests/local.ts`、`workbench/tests/reopen-browser.ts`

## 不要做

- 不做主题和外观设置（T38）。
- 不做工具箱内容和数据包界面（T39），只放好它的面板位置。
- 不删任何真实能力：宿主支持任务提交时，白板内的任务入口保留（`HostCapabilities.taskSubmit`）。

## 做法

1. **左侧导航**（`nav.ts` 一张表，顺序固定）：白板、组件、历史、设置、帮助。每项一个图标按钮，悬停显示名字，键盘可达。“历史”的面板内容由 T36 接入，本卡先放占位。
2. **浮动面板**：圆角、有阴影、不切割画布；同一时间只开一个；Escape 关闭并把焦点还给导航按钮。面板宽度可拖动调整，宽度和开合状态存在浏览器本地（不进工作空间）。提供“专注画布”（`F` 键或按钮）一键收起全部面板。
3. **白板面板**：当前工作空间的白板树（白板里放了哪些白板）、搜索对象（调用 `sand_query`，结果点击后定位过去，定位用 T33 的遮挡感知定位）、新建白板。
4. **帮助面板**：MCP 连接配置（JSON、Codex 命令、TOML 及复制按钮）、Agent 发来的编排消息及“复制这条消息”（保留 T03 的行为）、快捷键说明入口、连接状态说明。
5. **去掉顶栏**：`local/service.ts` 里的 `<nav>` 删除。连接状态改成帮助按钮上的小圆点（绿：已连接；灰：断开）。“重新连接”只在出错条里出现（保留 T04 的加载提示和 15 秒超时）。
6. **Agent 活动层**（`ActivityLayer`）：`sand_activity` 报告的对象，在卡片右上角显示 Agent 名字的小标签和状态（进行中、等待、完成）；画布角落一个小列表列出当前所有 Agent 活动，点击才定位过去。**任何 Agent 活动都不自动移动镜头。** 过期的活动消失。
7. **嵌入 DSH 时**（`/embed`）：不显示帮助里的连接配置和工作空间切换，其余一致。
8. 面板占据的屏幕区域通过一个函数提供给 T33 的遮挡感知定位。

## 验收

- `workbench/tests/blank.ts`：五个导航入口都能打开对应面板，Escape 关闭后焦点回到按钮；在白板面板搜索一个对象并点击，镜头定位到它且它没被面板挡住；“专注画布”收起全部面板。
- `workbench/tests/local.ts`：页面上没有顶栏；帮助面板里能复制 MCP 配置和 Agent 消息；断开服务后帮助按钮的圆点变灰。
- Agent 活动：用 MCP 客户端调用 `sand_activity` 报告某对象，界面出现标签，且镜头位置不变。
- `workbench/tests/reopen-browser.ts` 仍通过（重新连接入口改在出错条里）。
- `npm run format:check`、`npm run typecheck`、`npm test`、`npm run test:blank`、`npm run test:local`、`npm run test:reopen` 全部通过。
