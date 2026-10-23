# T43 文字：富文本、公式、代码块与对象链接

| 项 | 内容 |
|---|---|
| 执行 | grok |
| 依赖 | T42（决策记录已合并）、T35 |
| 分支 | `task/T43-text` |
| 关联 issue | #37 |

## 目标

便签、章节正文、人物弧光这类 `markdown` 字段，可以在卡片上就地用富文本编辑：标题、列表、链接、引用、公式、代码块。正文里可以链接到白板上的其他对象，链接会同步成关系，对象被删除后链接显示为失效。

## 先读

- `AGENTS.md`
- `docs/adr/0003-rich-text.md`（**以它的结论为准**）、`docs/adr/0002-bundle-loading.md`
- `docs/kernel-v3/03-types-and-extensions.md` §3.1 第 3 条、§3.2
- `workbench/board/widgets/`（T35 的 `markdown` 控件）、`workbench/board/edit-session.ts`
- `workbench/packs/base/`（加 `base.mentions` 关系类型）

## 开工前核对

确认 ADR 0003 已合并，并写明了选定的编辑器和接入要点。与本卡冲突的地方以 ADR 为准；ADR 没说清的，停下来问。

## 可改文件

- 新建 `workbench/board/richtext/`
- `workbench/board/widgets/markdown.tsx`（换成富文本编辑器）
- `workbench/packs/base/index.ts`（加关系类型 `base.mentions`：`allowsInferred: false`，标题“提到”，反向“被提到”）
- `workbench/package.json`、`workbench/package-lock.json`（只加 ADR 里选定的依赖，版本写死）
- 构建配置（只在 ADR 要求按需加载时改）
- 新建 `workbench/tests/richtext.test.ts`，修改 `workbench/tests/blank.ts`

## 不要做

- 不做长文排版、分页、导出 Word（不在本卡）。
- 不执行代码块里的代码。

## 做法

1. 编辑器按 ADR 接入，读写都是 Markdown 字符串。ADR 列出的不支持语法原样保留。
2. **就地编辑**：双击便签（或在表单里点 `markdown` 字段）进入编辑；`Escape` 或点外面退出。编辑期间编辑器自己的撤销可用；退出时整段修改作为一步写入（一个 `intentId`）。中文输入法组合期间不触发任何画布快捷键（沿用 `board/keyboard.ts` 的隔离，补上 `isComposing`）。
3. **公式**：KaTeX 渲染；语法错误时显示红色原文和错误信息，不吞掉内容。
4. **代码块**：语言选择、高亮、行号、复制按钮。
5. **对象链接**：
   - 输入 `@` 弹出对象搜索（`sand_query`），选中后插入 `[标题](sand://object/<id>)`。
   - 显示为对象标签，点击定位到该对象（用 T33 的定位）。
   - 保存正文时，在**同一次** `app_edit` 里同步 `base.mentions` 关系：正文里新出现的链接建关系，消失的链接删关系（只删 `base.mentions`，不碰其他关系）。
   - 链接的对象已删除：显示为划线的“已删除的对象”，不报错。
6. 卡片上的显示（不在编辑时）：渲染后的富文本，超出卡片高度时淡出，不出现滚动条。

## 验收

- `workbench/tests/richtext.test.ts`：ADR 里的往返样例全部逐字相等；从 Markdown 中抽取 `sand://object/` 链接并计算关系增删的纯函数。
- `workbench/tests/blank.ts`：
  1. 在便签里输入标题、列表、行内公式 `$a^2$`，退出后服务端是对应 Markdown，历史只多一步。
  2. 插入一个对象链接后服务端多一条 `base.mentions`；删掉链接后关系消失；删掉被链接对象后便签里显示“已删除的对象”。
  3. 编辑中按 Delete、`⌘Z`，只作用于文本，不删组件、不撤销白板。
  4. 写一个错误公式，显示错误且原文保留。
- 构建后体积符合 ADR 0002 的预算（PR 里写数字）。
- `npm run format:check`、`npm run typecheck`、`npm test`、`npm run test:blank` 全部通过。
