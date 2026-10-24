# T20 v3 工具面

| 项 | 内容 |
|---|---|
| 执行 | minimax |
| 依赖 | T15、T17 |
| 分支 | `task/T20-tools-v3` |

## 目标

在 v3 内核上注册新的 MCP 工具面：8 个模型可见的核心工具 + 界面专用工具。设置环境变量 `SAND_KERNEL=v3` 时，`server/main.ts` 和本地服务改用它；不设置时行为与现在完全一样。

## 先读

- `AGENTS.md`
- `docs/kernel-v3/05-delivery-contracts.md`（本阶段公共契约与交接规则）
- `docs/kernel-v3/02-commands-and-tools.md`（全文）
- `workbench/server/server.ts`（v2 的 `tool()` 注册方式、`appOnly`、模型 / 界面两份输出的做法、`Forwarder`）
- `workbench/server/main.ts`、`workbench/local/bridge.ts`、`workbench/local/service.ts`（启动与转发）
- `workbench/server/workspaces.ts`（v2 多工作空间管理，作为 `app_workspace` 的参考）
- `workbench/tests/connectors.test.ts` 里用 `InMemoryTransport.createLinkedPair()` 测工具的写法

## 可改文件

- 新建 `workbench/server/v3/server.ts`、`workbench/server/v3/core-tools.ts`、`workbench/server/v3/app-tools.ts`、`workbench/server/v3/workspaces.ts`、`workbench/server/v3/output.ts`
- `workbench/kernel/types.ts`（把 `ToolRegistrar` 从 `unknown` 换成具体类型）
- `workbench/server/main.ts`、`workbench/local/service.ts`、`workbench/local/bridge.ts`（只加 `SAND_KERNEL=v3` 分支）
- `workbench/local/config.ts`（默认桥接命令的唯一来源。给默认条目补环境变量时改 `defaultMcpEntry`，不要在 `service.ts` 再写一套 command/args）
- 新建 `workbench/tests/tools-v3.test.ts`
- `workbench/tests/architecture.test.ts`（加工具数量规则）
- `.github/workflows/workbench.yml`（加一步：`SAND_KERNEL=v3 npm test`）

## 不要做

- 不改 v2 工具的行为；不设环境变量时一切照旧。
- 工具层不写业务规则：参数解析 → 调 `kernel` → 整理输出。需要的查询 `kernel/read.ts` 没有时，停下来在 PR 里提“需要架构确认”，不要在工具层拼 SQL。
- 不注册任何领域包工具（T22、T23 的事）。
- 不把 `defaultMcpEntry` 的默认命令复制到别的文件。

## 做法

1. **`ToolRegistrar`**（写在 `kernel/types.ts`，内核不能 import zod，所以参数结构用 `Record<string, unknown>`，实际传入的是 zod 的 shape，类型收窄在 `server/v3/` 里做）：

   ```ts
   export type ToolRegistrar = {
     tool(
       name: string,
       description: string,
       shape: Record<string, unknown>,
       handler: (args: any, ctx: { actor: Actor; db: Db; registry: Registry }) => unknown,
       options?: { appOnly?: boolean; readOnly?: boolean; ui?: boolean },
     ): void;
   };
   ```

   `Registry` 类型在 `kernel/registry.ts` 里，`types.ts` 用 `import type` 引用即可。

   包工具随包启停：`server/v3/server.ts` 启动时为每个内置包调用一次 `registerTools`（不论是否启用），记下每个包注册出的工具句柄（MCP SDK 的 `registerTool` 返回值，有 `enable()` / `disable()`）；包未启用就立即 `disable()`。之后每次 `applyCommands` 结果里有 `packs` 表的变化，就按新状态对相应工具 `enable()` / `disable()`（SDK 会自动通知客户端工具列表变了）。

2. **`server/v3/server.ts`**：`createServerV3(options: { workspaceRoot: string; workspaceId: string; forward?: Forwarder })`。启动时 `createRegistry()` → 注册 `builtinPacks` → `openWorkspace(...)`。工具的 actor 按 `02` §3.1 决定（模型可见工具从 MCP 握手的 `clientInfo.name` 取）。
3. **核心工具**（`core-tools.ts`）：按 `02` §3.2 逐个实现，描述字符串**原样**照抄。只有 `sand_status` 带 UI 资源（`ui: true`）。
4. **界面专用工具**（`app-tools.ts`）：按 `02` §3.4，`appOnly: true`。`app_workspace` 在 `server/v3/workspaces.ts` 里实现：列出根目录下的工作空间、新建、切换（关闭当前 db、打开新 db）、改名（改 `meta.title`）、删除（不能删除当前工作空间）。
5. **输出**（`output.ts`）：模型文本输出、`_meta.data`、错误格式按 `02` §3.1。`CommandError` 转成 `{code, message, hint}`，每个错误码一条固定的英文 hint。
6. **启动分支**：`server/main.ts` 和 `local/service.ts` 读 `process.env.SAND_KERNEL === "v3"` 决定用 `createServerV3` 还是 v2 的 `createServer`。

## 验收

`workbench/tests/tools-v3.test.ts`（用 `InMemoryTransport.createLinkedPair()` 和临时目录）：

1. 先用 `app_edit` 停用 `novel`、`research`，再列工具：模型可见工具（`_meta.ui.visibility` 缺省或包含 `"model"`，且未被 `disable()`）的名字**正好**是这 8 个：`sand_status`、`sand_types`、`sand_query`、`sand_read`、`sand_edit`、`sand_history`、`sand_context`、`sand_activity`。
2. 02 §3.4 列出的界面专用工具（`code_decide` 除外）全部存在，且 `visibility` 为 `["app"]`。
3. 一个完整流程：`sand_status` → `sand_types { types: ["base.note"] }` → `sand_edit` 新建便签并放到首页白板 → `sand_query { text }` 找到它 → `sand_read` 读回 → `sand_history { action: "undo" }` → `sand_query` 找不到 → `redo` → 又能找到。
4. 模型输出不超过 4 KB：建 300 个便签后 `sand_status`、`sand_query`（缺省 limit）的文本长度都小于 4096。
5. 错误：`sand_edit` 写一个不存在的类型，返回 `isError` 且文本可解析出 `code: "UNKNOWN_TYPE"` 和非空 `hint`。
6. actor：经 `sand_edit` 写入的历史 `actor_kind = 'agent'`，经 `app_edit` 写入的为 `'human'`；之后 `sand_context` 只报告 `app_edit` 那次。
7. `app_changes`：两次写入后，从第一次的修订号取增量，只含第二次改动的行。
8. `app_workspace`：新建、切换、改名、删除各一次；不能删除当前工作空间。

`workbench/tests/architecture.test.ts` 新增规则：只启用 `base` 时模型可见工具数为 8；启用全部内置包并绑定文件夹时不超过 8 + 2 × 3 + 1。

命令：`npm run format:check`、`npm run typecheck`、`npm test`、`SAND_KERNEL=v3 npm test` 全部通过。

## 交接与边界验收

运行状态遵守 05 §3：提供内核 views/activity/workspace 管理接口，工具不写 SQL。允许新增对应 kernel 模块/导出及测试。app_view get 返回导航栈；app_activity list 读取活动不更新 agent_reads。只读 app 工具不计入模型 8 工具。sand_types 精简项还返回 icon、capabilities、presets 所需元数据，03/02 同步。跨进程包启停通过 revision 轮询刷新工具句柄，不仅监听本进程命令。
