# T12 内置包类型声明

| 项 | 内容 |
|---|---|
| 执行 | minimax |
| 依赖 | T11 |
| 分支 | `task/T12-builtin-packs` |

## 目标

把 v2 的内置组件类型和小说、科研、代码三个领域的类型，改写成 v3 的 `PackSpec`（JSON Schema 声明）。只写声明，不写工具、不写界面。

## 先读

- `AGENTS.md`
- `docs/kernel-v3/03-types-and-extensions.md`（全文，重点 §3、§4、§8）
- `docs/kernel-v3/01-data-model.md` §10.1（类型改名表）
- v2 的来源（只读，**不要修改**）：
  - `workbench/core/spaces.ts`：`componentTypes`、`defaultData`、`checkComponentData`（字段和长度、条目数限制）
  - `workbench/domains/novel/index.ts`、`workbench/domains/research/index.ts`、`workbench/domains/code/index.ts`：字段、`check` 函数里的限制、关系类型、模板

## 可改文件

- 新建 `workbench/packs/base/index.ts`、`workbench/packs/novel/index.ts`、`workbench/packs/research/index.ts`、`workbench/packs/code/index.ts`
- 新建 `workbench/packs/index.ts`（导出 `builtinPacks: PackSpec[]`，顺序：base、novel、research、code）
- 新建 `workbench/tests/packs-v3.test.ts`

## 不要做

- 不修改 `workbench/domains/`、`workbench/core/` 里的任何文件。
- 不写 `registerTools`（T22、T23 会加）。
- 不写 `display.view`（自定义视图是 Phase 3 的事）。
- `packs/` 里的文件只能 import `../../kernel/index.ts`，包之间不能互相 import。

## 做法

1. 每个类型按 `03-types-and-extensions.md` §3.3 的例子格式写。类型清单和关系清单以 §8 为准。
2. 限制数字从 v2 搬：例如 v2 `checkComponentData` 里图表“最多 100 个点、标签最多 100 字”，就写成 `points: { type: "array", maxItems: 100, items: { ..., label: { type: "string", maxLength: 100 } } }`。
3. 对照 §3.1 的规则逐条检查：
   - 不写 `default`；v2 `defaultData` 里的配置类默认值（如图表 `kind: "bar"`、代码片段 `language: "text"`、标题 `level: 1`）改成 `x-sand-default`。
   - 删除 v2 的占位字段：人物 `name`（用对象标题）、事件 `participants`（改成关系槽，见 §8.2）。
   - 指向其他对象的字段一律改成关系槽。
   - 每个字段都写 `x-sand-label`（中文）和 `x-sand-widget`。
4. `display.summary` 选 2 到 3 个最能代表这个类型的字段。
5. v2 的模板改写成 `TemplateSpec`：每个模板对象变成一条 `object.create`（带 `ref`）加一条放到 `"$board"` 上的 `presentation.create`；模板关系变成 `relation.create`，用 `"@ref"` 引用。

## 验收

`workbench/tests/packs-v3.test.ts`：

1. 在一个新的 `createRegistry()` 里按顺序注册 `builtinPacks`，全部成功（注册表会做 §3.1 的规则检查）。
2. 每个类型至少一组“合格样例”通过 `validateData`、一组“不合格样例”失败。样例写在测试文件里，按类型分组。
3. `novel.event` 的 Schema 里没有 `participants`；`novel.character` 的 Schema 里没有 `name`。
4. 所有 Schema 里搜不到 `"default"` 键（注册表已经会拒绝，这里再断言一次，防止有人改松注册表）。
5. 每个模板展开后的命令里，`type` 和 `kind` 都能在注册表里找到。
6. `base.board`、`novel.character` 的 `capabilities.container` 为真；`base.note` 没有 `container`。

命令：`npm run format:check`、`npm run typecheck`、`npm test` 全部通过。

## PR 里写清楚

列一张表：每个 v2 类型 → v3 类型，以及你删掉、改名或改成关系槽的字段。

代码内置包声明 derivedIdPrefix: "code:"；仅内置包可声明，注册表验证不重叠。
