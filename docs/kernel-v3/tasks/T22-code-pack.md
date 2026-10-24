# T22 代码包迁移

| 项 | 内容 |
|---|---|
| 执行 | minimax |
| 依赖 | T20 |
| 分支 | `task/T22-code-pack` |

## 目标

把代码领域（仓库导入与索引、源码读取、意图 → 提案 → 人批准 → 宿主写入 → 核对 这条改动链路）搬到 v3：数据变成 `code.*` 对象，工具变成 `code_repo`、`code_change`（模型可见）和 `code_decide`（界面专用）。改动链路的安全边界**一条都不能弱化**。

## 先读

- `AGENTS.md`
- `docs/kernel-v3/05-delivery-contracts.md`（本阶段公共契约与交接规则）
- `docs/kernel-v3/02-commands-and-tools.md` §3.3、§3.4、§4（代码相关的行）
- `docs/kernel-v3/03-types-and-extensions.md` §8.4
- `docs/kernel-v3/01-data-model.md` §5（`derived`）、§7.4
- v2 实现（只读）：`workbench/connectors/git.ts`、`workbench/domains/code/`（`index.ts`、`indexer.ts`、`python-indexer.ts`）、`workbench/server/changes.ts`、`workbench/core/changes.ts`
- v2 测试：`workbench/tests/changes.test.ts`、`repository.test.ts`、`python.test.ts`、`import.test.ts`

## 可改文件

- `workbench/packs/code/`（加 `tools.ts`、`indexer.ts` 等，并给 `PackSpec` 加 `registerTools`）
- `workbench/server/v3/server.ts`（启用的包调用 `registerTools`）
- 新建 `workbench/tests/code-pack-v3.test.ts`

## 不要做

- 不修改 v2 的 `connectors/`、`domains/`、`server/changes.ts`、`core/changes.ts`。需要的逻辑（索引器、Python 索引脚本、摘要计算）**复制**到 `packs/code/`，因为 T24 会删除 v2 目录。
- 不把批准动作放进 `code_change`；`code_decide` 必须是界面专用工具。
- 索引写入不进历史：代码文件、符号、仓库对象一律 `source.origin = "derived"`，用 02 §1.5 的内部 object.upsert_derived 命令；不向公共 create 开放任意 ID。

## 做法

1. **对象 id 要稳定**：`code.file` 的 id 用 `code:<仓库 id>:<相对路径>`，`code.symbol` 用 `code:<仓库 id>:<相对路径>#<符号名>:<起始行>`。通过内部 derived upsert 更新。旧索引 ID 格式不同则保留 ID→稳定定位映射，刷新优先复用旧 ID，不断开已有引用。
2. **`code_repo`**：`import` 绑定本机仓库并索引；`refresh` 重新索引，删除已不存在的文件和符号对象（软删除）；`read_source` 读源码片段（沿用 v2 的分段和指纹）。
3. **`code_change`**：9 个动作与 v2 对应工具语义一致；意图、提案、验证存为 `code.intent`、`code.proposal`、`code.validation` 对象（用 `applyCommands`，**进历史**）。超过 1 MB 的基线文件内容写入 `blobs/`。
4. **`code_decide`**：`appOnly`；只接受 `actor.kind === "human"`，否则抛 `FORBIDDEN`；`digest` 必须与当前提案的摘要一致。
5. 包只在“已导入过仓库”或用户在设置里启用时启用（`packs` 表 `enabled`）。

## 验收

`workbench/tests/code-pack-v3.test.ts`，把 v2 的 `changes.test.ts`、`repository.test.ts` 中的核心场景在 v3 上重写（需要外部仓库的用例沿用 `SAND_EXTERNAL_REPO` / `SAND_PYTHON_REPO` 的跳过规则）：

1. 导入仓库后能 `sand_query { types: ["code.file"] }` 查到文件；刷新后删除的文件消失；导入和刷新不产生历史记录。
2. 完整改动链路：创建意图 → 发布提案 → 模型调用 `code_decide` 被拒（模型看不到这个工具，测试里直接以 agent 身份调用，返回 `FORBIDDEN`）→ 以 human 身份 `code_decide` 批准 → `prepare_apply` → `read_approved_file` → `verify` 发现实际文件与提案一致 / 不一致两种情况。
3. 提案内容在批准后被修改，`digest` 不再匹配，批准失败。
4. 启用 code 包后，模型可见工具比启用前多 2 个（`code_repo`、`code_change`）；停用后恢复原数。

命令：`npm run format:check`、`npm run typecheck`、`npm test`、`SAND_KERNEL=v3 npm test` 全部通过。
