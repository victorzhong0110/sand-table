# T43 文字：富文本、公式、代码块与对象链接

| 项 | 内容 |
|---|---|
| 执行 | minimax |
| 依赖 | T42、T35、T33、T72 |
| 分支 | `task/T43-text` |
| 关联 issue | #37 |

## 目标

便签、章节正文、人物弧光这类 `markdown` 字段，可以在卡片上就地用富文本编辑：标题、列表、链接、引用、公式、代码块。正文里可以链接到白板上的其他对象，链接只保存在正文中作为导航引用，不同步关系，对象被删除后链接显示为失效。

## 先读

- `AGENTS.md`
- `docs/kernel-v3/05-delivery-contracts.md`（本阶段公共契约与交接规则）
- `docs/adr/0003-rich-text.md`（**以它的结论为准**）、`docs/adr/0002-bundle-loading.md`
- `docs/kernel-v3/03-types-and-extensions.md` §3.1 第 3 条、§3.2
- `workbench/board/widgets/`（T35 的 `markdown` 控件）、`workbench/board/edit-session.ts`
- `docs/kernel-v3/05-delivery-contracts.md` §2（正文链接与语义关系分离）

## 开工前核对

确认 ADR 0003 已合并，并写明了选定的编辑器和接入要点。技术选型按 ADR；ADR 不得覆盖 00–05 的语义契约。缺少实现接口由本卡在公共集成范围内补齐并记录。

## 可改文件

- 新建 `workbench/board/richtext/`
- `workbench/board/widgets/markdown.tsx`（换成富文本编辑器）
- `workbench/packs/base/index.ts`（仅登记文字视图，不新增提及关系）
- `workbench/package.json`、`workbench/package-lock.json`（只加 ADR 里选定的依赖，版本写死）
- 构建配置（只在 ADR 要求按需加载时改）
- 新建 `workbench/tests/richtext.test.ts`，修改 `workbench/tests/blank.ts`

## 不要做

- 不做长文排版、分页、导出 Word（不在本卡）。
- 不执行代码块里的代码。

## 做法

1. 编辑器按 ADR 接入，读写都是 Markdown 字符串。ADR 列出的不支持语法原样保留。
2. **就地编辑**：双击便签（或在表单里点 `markdown` 字段）进入编辑；`Escape` 或点外面退出。编辑期间编辑器自己的撤销可用；按交接节定时保存并在退出时 flush，同一编辑会话复用 intentId。中文输入法组合期间不触发任何画布快捷键（沿用 `board/keyboard.ts` 的隔离，补上 `isComposing`）。
3. **公式**：KaTeX 渲染；语法错误时显示红色原文和错误信息，不吞掉内容。
4. **代码块**：语言选择、高亮、行号、复制按钮。
5. **对象链接**：
   - 输入 `@` 弹出对象搜索（`sand_query`），选中后对完整对象 id 做一次 `encodeURIComponent`，插入 `[标题](sand://object/<编码结果>)`。id `人物/林#a%b` 的结果是 `[标题](sand://object/%E4%BA%BA%E7%89%A9%2F%E6%9E%97%23a%25b)`。解析时解码一次。不要插入未编码的 `<id>`。
   - 显示为对象标签，点击定位到该对象（用 T33 的定位）。
   - 保存只提交 Markdown 字段。既不创建也不删除语义关系；AI 经 `sand_edit` 写入同一语法时行为完全一致。
   - 链接的对象已删除：显示为划线的“已删除的对象”，不报错。
6. 卡片上的显示（不在编辑时）：渲染后的富文本，超出卡片高度时淡出，不出现滚动条。

## 验收

- `workbench/tests/richtext.test.ts`：ADR 里的往返样例全部逐字相等；从 Markdown 中解析并安全渲染对象导航链接的纯函数（代码块、行内代码不转链接）。编码往返至少覆盖 id `人物/林#a%b`（含 `/`、`#`、`%`、中文）：生成 `[标题](sand://object/%E4%BA%BA%E7%89%A9%2F%E6%9E%97%23a%25b)`，解码一次得到原 id，不能解码两次。`sand://object/%ZZ` 和 `sand://object/%` 保留原文，不转成链接。
- `workbench/tests/blank.ts`：
  1. 在便签里输入标题、列表、行内公式 `$a^2$`，退出后服务端是对应 Markdown，历史只多一步。
  2. UI 与 MCP 分别插入/删除对象链接，落盘的 Markdown 是一次 `encodeURIComponent` 的结果，关系表始终不变；删除目标后原文仍在并显示“已删除的对象”；撤销目标删除后可重新导航。
  3. 编辑中按 Delete、`⌘Z`，只作用于文本，不删组件、不撤销白板。
  4. 写一个错误公式，显示错误且原文保留。
- 构建后体积符合 ADR 0002 的预算（PR 里写数字）。
- `npm run format:check`、`npm run typecheck`、`npm test`、`npm run test:blank` 全部通过。

## 交接与边界验收

富文本每 600ms 空闲自动保存并在失焦 flush，中文 composition 结束前不提交；同一编辑会话 intentId 连续合并，其他人写入可打断，不能保证任意时长都只有一步。原始 HTML 不执行，URL 白名单；KaTeX trust=false，所有文字按编辑器安全规则渲染。测试 UI/AI/撤销/复制/重开链接一致，关系表无额外记录。
