# T79 宿主会话绑定、恢复与服务侧产物接收

| 项 | 内容 |
|---|---|
| 执行 | grok |
| 依赖 | T78、T75 |
| 分支 | `task/T79-dsh-session-bindings` |

## 目标

将易失任务映射和前端产物写入替换为 DSH 持久关联与状态投影；关页面、重连、Host 重启不丢关联、不重复执行。

## 先读

`AGENTS.md`、`05-delivery-contracts.md` §7、06 §5、T77 ADR、T78、workbench 下的 dsh-plugin、core/host-bridge、board/host-bridge-client、board/main、board/ai、kernel 命令与历史实现。

## 可改文件

- `workbench/dsh-plugin/`、resources 的绑定/产物适配，新建 `workbench/server/host/`。
- core/host-bridge、board/host-bridge-client、board/main、board/ai、HostTask 类型及 local 必要适配。
- kernel 产物去重接口、schema 迁移与导出；01/02/05 对应契约、架构允许文件清单及测试。
- 新建恢复/产物崩溃测试，更新 host-transport、host-browser 和执行夹具。

## 做法

1. 用 T77 锁定接口把会话/白板多对多绑定、请求、固定输入、输出关联写入 DSH 持久事件，注册 projection。前端消费快照/变化及宿主正文，不另建聊天库。
2. 提交明确 session 生命周期身份、workspaceId/boardId，requestId 贯穿实际轮次/产物；换会话或白板不改在途目标。未知提交结果按宿主证据核对，不盲重发。
3. 将产物接收移至 Host/服务侧。adapter 显式注册识别方式，保留来源、精确版本、目标和 operationId；普通 assistant 文本只在会话中，退出扫描任意 JSON 的兼容通道。
4. 作品写入与 operationId 去重记录共享 kernel 事务；异参重用拒绝，崩溃先查询记录。事件重放只重建状态，不执行写入。schema 迁移按最新 main 加一。
5. 分开展示执行状态与作品交付状态；断开为待核对，取消等待实际确认，迟到事件不回退终态。无恢复能力宿主明示限制。
6. 给 T62/T64/T65 提供服务端 submit/get/follow/cancel/reconcile 适配，实际命名与能力写进 05。postMessage 可保留传输兼容，不保存权威状态。

## 验收

- request/operationId 幂等与异参冲突、跨 session/工作区隔离、乱序/重复事件和合法状态转换。
- 提交回执前断开、落库前/后崩溃、客户端关闭、Host 重启分别测试；无重复作品/任务，未知状态不擅改失败。
- 关页面再开，原会话与原白板产物可见；人工并发编辑冲突保留候选，重放不改内容 revision。
- 计划检查、format:check、typecheck、npm test、build、test:host、test:blank；固定真实 DSH 重启记录与 fixture 分开。
