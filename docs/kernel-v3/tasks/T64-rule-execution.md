# T64 规则执行与宿主接入

| 项 | 内容 |
|---|---|
| 执行 | grok |
| 依赖 | T62、T63、T66（至少在一个真实宿主上确认了任务提交能用） |
| 分支 | `task/T64-rule-execution` |
| 关联 issue | #36 执行阶段、#18 |

## 目标

用户点运行（或输入变化时自动触发，需用户开启），规则带着输入引用、版本和参数交给宿主执行；运行状态如实显示，可以取消、重试；产出落到指定白板，关联到这次运行；输入后来变了，旧结果标为“依据已变化”，不覆盖用户的新编辑。没有能执行任务的宿主时，不显示可以点的运行按钮。

## 先读

- `AGENTS.md`
- issue #36、#18
- `docs/architecture/dsh-integration.zh-CN.md`（宿主事实）、`workbench/core/host-bridge.ts`（`HostCapabilities`、`HostTaskRequest`、`HostTaskEvent`；T24 之后的位置以 `main` 为准）
- `workbench/kernel/runs.ts`、`workbench/board/rules/`（T62）、`workbench/board/controls/params.ts`（T63）
- T66 的真机验证记录（issue #18 里）

## 开工前核对

确认：T66 的记录里任务提交在真实宿主上能用；`HostTaskRequest` 的字段与本卡一致。任何一项不成立，先停下来问——不要用脚本夹具冒充真实宿主来宣称完成。

## 可改文件

- 新建 `workbench/board/rules/execute.ts`、`workbench/board/rules/trigger.ts`
- `workbench/board/rules/RuleView.tsx`、`RunList.tsx`
- 宿主桥（`host-bridge.ts` 及界面侧客户端）：只在任务请求里加规则需要的字段
- `workbench/kernel/runs.ts`（如需记录产出）
- `workbench/dsh-plugin/`（只在需要把运行结果写回时修改）
- 新建 `workbench/tests/rule-execution.test.ts`，修改 `workbench/tests/host-browser.ts`

## 不要做

- 不自建模型调用、对话记忆或 Agent 循环（#18 的决定）。
- 撤销白板不声称撤销已经发出的任务。
- 自动触发默认关闭。

## 做法

1. **手动运行**：就绪 → `createRun`（状态 `queued`，记下输入的 id 与版本、参数、`idempotency`）→ 发宿主任务（`instruction` 为规则说明 + 参数，`targets` 为输入引用与版本，附运行 id 与输出白板 id）→ 宿主事件到达时 `updateRun`。
2. **产出**：宿主（或它驱动的 Agent）通过 `sand_edit` 写入输出白板，`intentId` 用 `run:<运行 id>`；这样产出在历史里是一步，可以撤销（撤销的是白板内容，不是任务）。任务完成事件里带回产出 id，记进运行记录。
3. **状态显示**：只显示宿主真实回报的状态；超过宿主声明的心跳时间没有消息，显示“最后一次消息在 N 分钟前”，不伪造进度。
4. **取消**：宿主支持取消就发取消；不支持时显示“已请求停止，宿主未确认”。**重试**：新建一条运行，不覆盖旧的。
5. **依据已变化**：任何输入的当前版本与运行记录里的版本不同，运行结果旁标“依据已变化”，提供“用新输入重新运行”。不自动重跑、不改动已有产出。
6. **自动触发**（`trigger.ts`）：规则的 `trigger = "change"` 且用户在卡片上打开了“自动运行”开关时，输入对象版本变化后 2 秒内无新变化才触发；循环与重复保护在 T65，本卡先保证“产出白板里的变化不会触发同一条规则”。
7. **没有执行能力**：宿主未声明 `taskSubmit` 时，运行按钮不显示，卡片写“当前连接的 AI 只能读写白板，不能执行规则”。

## 验收

- `workbench/tests/rule-execution.test.ts`：运行请求的组装（引用、版本、参数）；状态转换；依据变化判断；自身产出不触发自身。
- `workbench/tests/host-browser.ts`（宿主夹具，只用于自动化回归）：手动运行 → 完成 → 产出出现在输出白板并关联运行；取消；失败显示原因；无 `taskSubmit` 时没有运行按钮。
- **真机记录**：在 T66 用过的真实宿主上手动跑一次完整流程，把步骤和截图写进 PR 描述。没有真机记录，本卡不能算完成。
- `npm run format:check`、`npm run typecheck`、`npm test`、`npm run test:host` 全部通过。
