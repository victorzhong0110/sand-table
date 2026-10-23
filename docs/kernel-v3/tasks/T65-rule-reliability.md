# T65 规则可靠性：循环、重复、超时与并发

| 项 | 内容 |
|---|---|
| 执行 | grok |
| 依赖 | T64 |
| 分支 | `task/T65-rule-reliability` |
| 关联 issue | #36 可靠性阶段 |

## 目标

规则之间连成环、同一输入被重复触发、运行卡住、同时点了好几次——这些情况都有可测试的明确行为，不会无限运行、不会重复产出、不会互相覆盖。

## 先读

- `AGENTS.md`
- issue #36
- `workbench/kernel/runs.ts`、`workbench/board/rules/`（T62、T64）

## 开工前核对

确认 T64 已合并，运行记录有 `idempotency` 字段。不一致先停下来问。

## 可改文件

- `workbench/kernel/runs.ts`
- `workbench/board/rules/trigger.ts`、`execute.ts`、`RuleView.tsx`
- 新建 `workbench/board/rules/graph.ts`
- 新建 `workbench/tests/rule-reliability.test.ts`

## 不要做

- 不引入任务队列或调度库。

## 做法

1. **环路**（`graph.ts`）：规则 A 的输出白板里的对象是规则 B 的输入、B 的输出又是 A 的输入，且两者都开了自动运行，即为环。开启自动运行前检查，成环时拒绝开启并列出环上的规则。手动运行不受限。
2. **连锁深度**：一次自动触发引起的连锁最多 3 层，超过的停在 `queued` 并标“连锁过深，需要手动运行”。
3. **重复**：同一规则、同样的输入版本和参数（`idempotency` 相同）已有 `queued` / `running` / `waiting` 的运行时，不新建，直接指向那条。
4. **并发**：同一规则同时只有一条运行在执行；新的手动运行排队在后面，界面显示排队位置。
5. **超时**：运行超过规则设定的时长（默认 10 分钟，可在规则上改）没有完成，标 `failed`，原因“超时”，并向宿主发取消。
6. **重试**：只对 `failed` / `cancelled` 的运行提供；新建运行，旧运行的产出保留并标注来自哪次运行，不删除。

## 验收

`workbench/tests/rule-reliability.test.ts`（用假时钟和假宿主）：

1. 两条规则成环时开启自动运行被拒绝，错误列出两条规则。
2. 三层以上连锁在第 4 层停住。
3. 同样输入连续触发 5 次只产生 1 条运行。
4. 同一规则连点 3 次，只有 1 条在执行、2 条排队，按顺序执行。
5. 超时后状态为 `failed`、原因“超时”，并发出了取消。
6. 重试后有两条运行记录，旧产出仍在。

命令：`npm run format:check`、`npm run typecheck`、`npm test`。
