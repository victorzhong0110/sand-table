# T62 规则：契约与运行记录

| 项 | 内容 |
|---|---|
| 执行 | grok |
| 依赖 | T34、T40 |
| 分支 | `task/T62-rules-contract` |
| 关联 issue | #36 契约阶段 |

## 目标

“规则”成为一种组件：写明要做什么、需要哪些输入、产出放到哪里、由谁执行。每次运行留一条运行记录（输入及其版本、执行端、状态、输出、失败原因）。运行记录不进白板撤销历史。本卡只做契约、存储和显示；真正执行是 T64。

## 先读

- `AGENTS.md`
- issue #36
- `docs/kernel-v3/01-data-model.md` §4（表结构与迁移规则）、§7.4、§9（V9：外部效果不进历史）
- `docs/kernel-v3/03-types-and-extensions.md` §4、§9
- `workbench/kernel/schema.ts`、`workbench/kernel/db.ts`

## 开工前核对

确认 `kernel/schema.ts` 当前的 `SCHEMA_VERSION`，本卡在它的基础上加 1。不一致或有人同时在改 schema，先停下来问。

## 可改文件

- `workbench/kernel/schema.ts`（追加一段迁移：新建 `runs` 表）、新建 `workbench/kernel/runs.ts`、`workbench/kernel/index.ts`
- `docs/kernel-v3/01-data-model.md`（§4 加 `runs` 表，§7.4 加“运行记录不进历史”）
- `workbench/packs/base/index.ts`（新增类型 `base.rule`，关系类型 `base.rule_input`、`base.rule_output`）
- `workbench/server/v3/app-tools.ts`（加 `app_runs`：列出、读取运行记录）
- 新建 `workbench/board/rules/`（`RuleView.tsx`、`RunList.tsx`、`readiness.ts`）
- `workbench/board/views/registry.ts`
- 新建 `workbench/tests/kernel-runs.test.ts`、`workbench/tests/rules.test.ts`，修改 `workbench/tests/blank.ts`

## 不要做

- 不实现执行、触发、取消、重试（T64）。
- 不引入规则引擎或流程编排库。

## 做法

1. **`runs` 表**：

   ```sql
   CREATE TABLE runs (
     id          TEXT PRIMARY KEY,
     rule_id     TEXT NOT NULL REFERENCES objects(id),
     state       TEXT NOT NULL CHECK (state IN ('queued','running','waiting','done','failed','cancelled')),
     trigger     TEXT NOT NULL CHECK (trigger IN ('manual','change')),
     executor    TEXT NOT NULL,                     -- 'dsh'、'local' 等，来自宿主能力
     inputs      TEXT NOT NULL CHECK (json_valid(inputs)),   -- [{ id, version }]
     params      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(params)),
     outputs     TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(outputs)),  -- [{ table, id }]
     message     TEXT,
     error       TEXT,
     task_id     TEXT,                              -- 宿主侧任务 id
     idempotency TEXT NOT NULL,                     -- 规则 id + 输入版本的哈希
     created_at  INTEGER NOT NULL,
     updated_at  INTEGER NOT NULL
   );
   CREATE INDEX runs_rule ON runs(rule_id, created_at);
   ```

   `kernel/runs.ts` 提供 `createRun`、`updateRun`（只允许合法的状态转换：queued→running/cancelled，running→waiting/done/failed/cancelled，waiting→running/cancelled）、`listRuns`、`getRun`。运行记录只保留每条规则最近 100 条。
2. **`base.rule`**：数据 `{ instruction: markdown（要 AI 做什么）, trigger: "manual" | "change"（x-sand-default "manual"）, requires: ("taskSubmit")[] }`；关系槽 `inputs`（`base.rule_input`，`many: true`）、`output`（`base.rule_output`，指向一块白板，`many: false`）。规则声明 `container: true`，可以进入整理它的说明和样例。
3. **就绪判断**（`readiness.ts`，纯函数）：没有输入、没有输出白板、输入对象已删除、宿主没有声明 `requires` 里的能力 → 不可运行，并给出每一条原因。不可运行时**仍然可以编辑**。
4. **规则卡片**：显示说明摘要、输入标签、输出白板、就绪状态（不可运行时列出原因）、最近运行记录（状态、时间、输入版本、失败原因）。运行按钮本卡先置灰，提示“执行在 T64 接入”。
5. 运行记录里的输入版本与当前版本不同时，标“依据已变化”。

## 验收

- `workbench/tests/kernel-runs.test.ts`：建表迁移（旧库升级后有 `runs` 表）；合法与非法状态转换；保留 100 条；运行记录的增删不改变历史记录数。
- `workbench/tests/rules.test.ts`：就绪判断的每种原因。
- `workbench/tests/blank.ts`：新建规则、连接两个输入和一个输出白板，卡片显示“就绪”；删除一个输入后显示具体原因；规则仍可编辑。
- `npm run format:check`、`npm run typecheck`、`npm test`、`npm run test:blank` 全部通过。
