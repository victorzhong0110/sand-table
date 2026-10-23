# T63 输入控件组件

| 项 | 内容 |
|---|---|
| 执行 | minimax |
| 依赖 | T62 |
| 分支 | `task/T63-controls` |
| 关联 issue | #36 交互阶段 |

## 目标

按钮、文本输入、下拉、滑块成为可以放在白板上的组件。它们的值保存在自己身上，通过**明确的连线**交给规则（作为参数）或触发规则运行。没有隐藏的全局变量，没连线就不影响任何东西。

## 先读

- `AGENTS.md`
- issue #36
- `docs/kernel-v3/03-types-and-extensions.md` §4
- `workbench/board/rules/`（T62）、`workbench/board/widgets/`（T35，下拉、滑块等编辑控件可复用）

## 开工前核对

确认 T62 已合并，`base.rule` 和运行记录的 `params` 字段存在。不一致先停下来问。

## 可改文件

- `workbench/packs/base/index.ts`（新增类型 `base.button`、`base.text_input`、`base.select`、`base.slider`；新增关系类型 `base.param_for`、`base.triggers`）
- 新建 `workbench/board/controls/`（每种控件一个视图文件、`params.ts`）
- `workbench/board/views/registry.ts`
- `workbench/board/rules/RuleView.tsx`（显示连进来的参数）
- 新建 `workbench/tests/controls.test.ts`，修改 `workbench/tests/blank.ts`

## 不要做

- 不让控件直接修改别的对象的数据。
- 按钮触发运行只在 T64 接入执行后才真正生效；本卡里按钮发出触发请求，规则不可运行时显示原因。

## 做法

1. **类型**：
   - `base.text_input`：`{ label, value?: string, placeholder? }`
   - `base.select`：`{ label, options: { value, label }[], value? }`
   - `base.slider`：`{ label, min, max, step, value? }`
   - `base.button`：`{ label }`，关系槽 `triggers`（`base.triggers`，指向规则，`many: true`）
   - 前三种有关系槽 `param_for`（`base.param_for`，指向规则，`many: true`），关系的 `attributes.name` 是参数名。
2. **操作**：控件在卡片上直接可用（不用进入编辑）；改值停止 500ms 后作为一步写入；控件区域加 `nodrag nowheel nopan`。
3. **参数收集**（`params.ts`，纯函数）：给定一条规则，收集所有 `param_for` 指向它的控件，得到 `{ 参数名: 值 }`；同名参数冲突时列出冲突，不随便取一个。
4. **规则卡片**：显示“参数：语气 = 正式（来自下拉“语气”）”；冲突时显示原因并视为不可运行。
5. **按钮**：点击 → 对每条连着的规则请求一次手动运行（T64 接入前显示“执行尚未接入”或规则的不可运行原因）。

## 验收

- `workbench/tests/controls.test.ts`：参数收集与同名冲突。
- `workbench/tests/blank.ts`：放一个下拉连到规则，规则卡片显示参数；改下拉的值，卡片随之变化；断开连线后参数消失；拖动滑块不会拖动卡片。
- `npm run format:check`、`npm run typecheck`、`npm test`、`npm run test:blank` 全部通过。
