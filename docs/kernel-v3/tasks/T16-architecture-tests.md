# T16 架构测试

| 项 | 内容 |
|---|---|
| 执行 | minimax |
| 依赖 | T10 |
| 分支 | `task/T16-architecture-tests` |

## 目标

用自动测试把 v3 的目录边界和命名规则钉死，让任何越界的改动在 CI 里直接失败。

## 先读

- `AGENTS.md`
- `docs/kernel-v3/01-data-model.md` §1（术语和禁用名词）、§9（V8）
- `docs/kernel-v3/00-decisions.md` K1

## 可改文件

- 新建 `workbench/tests/architecture.test.ts`

## 不要做

- 不修改被检查的代码来让测试通过。如果现有 `kernel/` 代码违反规则，在 PR 描述里列出来，测试照样写严。
- 不检查 v2 目录（`core/`、`server/`、`board/`、`domains/`、`connectors/`、`local/`）的内部写法。

## 做法

用 `node:fs` 递归读取 `.ts` 文件（跳过 `node_modules`），用正则检查。每条规则一个 `test(...)`，失败信息列出违规的文件和行号。

1. **内核只依赖自己**：`workbench/kernel/**/*.ts` 里的 `import ... from "x"` / `import("x")`，`x` 只能是 `node:` 开头、`ajv` 开头，或以 `./` 开头的相对路径。
2. **包只依赖内核**：`workbench/packs/<包>/**/*.ts` 里的相对 import 解析后必须落在 `workbench/kernel/index.ts` 或本包目录内；不能 import 其他包、`core/`、`server/`、`board/`、`domains/`。
3. **SQL 写语句只在内核**：除 `workbench/kernel/` 和 `workbench/tests/` 外，所有 `.ts` 文件的字符串字面量（单引号、双引号、反引号）里不得出现 `INSERT INTO`、`UPDATE ... SET`、`DELETE FROM`、`REPLACE INTO`（不区分大小写）。
4. **内核没有领域词**：`workbench/kernel/**/*.ts`（排除 `workbench/kernel/legacy/`，那里是 v2 导入器，必然出现旧名字）去掉注释后，不得出现这些单词（区分大小写，按整词匹配）：`novel`、`research`、`character`、`chapter`、`hypothesis`、`repository`。（`evidence` 不在禁用列表里：它是关系的通用字段。`ExternalLocator.kind` 里的 `"git"`、`"symbol"` 也是通用定位类型，不在检查范围。）
5. **禁用 v2 名词**：`workbench/kernel/`（同样排除 `workbench/kernel/legacy/`）和 `workbench/packs/` 里去掉注释后，不得出现标识符 `Space`、`SpaceLink`、`ComponentInstance`、`Projection`、`placements`（整词匹配）。
6. **只从入口导入内核**：`workbench/kernel/` 以外的 `.ts` 文件（含 `packs/`、`server/`，不含 `tests/`），若 import 了 `kernel/` 下的文件，只能是 `kernel/index.ts`。

去掉注释的简单做法：删除 `//` 到行尾（不在字符串内的）和 `/* ... */` 块。实现不必完美，但要有单元测试覆盖它自己的边界（见验收第 2 条）。

## 验收

1. 在当前代码上全部通过（若 T10 之后的某张卡已经违规，按“不要做”第一条处理）。
2. `architecture.test.ts` 里另有一组自检用例：把几段示例源码字符串交给检查函数，确认违规能被发现、注释里的词不会误报。
3. 在本地临时往 `kernel/` 某个文件里加一行 `import "../core/store.ts"`，测试失败；删掉后通过（在 PR 描述里说明你做过这个核对）。

命令：`npm run format:check`、`npm run typecheck`、`npm test` 全部通过。


T19修订：导入检查用已有TypeScript AST，路径归一化后判断是否在内核/本包。允许内核子目录引用上级内核，ajv精确包或子路径；包可用Node内置模块，其他裸依赖必须显式批准。扫描TSX/MTS/CTS并覆盖require、export、动态import与INSERT OR变体。
