# T31 选择、剪贴板与快捷键

| 项 | 内容 |
|---|---|
| 执行 | minimax |
| 依赖 | T30 |
| 分支 | `task/T31-selection-clipboard-keys` |
| 关联 issue | #30 |

## 目标

按 `04-canvas.md` §4 的快捷键表，把选择、复制粘贴、“再放一份”和“复制出独立对象”、方向键微调、缩放快捷键做全，并提供快捷键说明面板。引用和独立副本的区别必须清楚、可撤销。

## 先读

- `AGENTS.md`
- `docs/kernel-v3/05-delivery-contracts.md`（本阶段公共契约与交接规则）
- `docs/kernel-v3/04-canvas.md` §2、§4
- `docs/kernel-v3/02-commands-and-tools.md` §1.1（`object.clone`、`presentation.create`）
- `workbench/board/canvas/`（T30 产物）、`workbench/board/keyboard.ts`（T18 的按键隔离）

## 开工前核对

确认 T30 已合并，`board/keyboard.ts` 的 `blocksCanvasShortcut` 仍在。依赖未完成则等待；机械差异按 05 §1 适配，语义冲突只暂停受影响部分。

## 可改文件

- `workbench/board/canvas/` 下的文件，新建 `workbench/board/canvas/clipboard.ts`、`workbench/board/canvas/keymap.ts`
- `workbench/board/keyboard.ts`
- 新建 `workbench/board/ShortcutHelp.tsx`
- `workbench/tests/blank.ts`，新建 `workbench/tests/keymap.test.ts`

## 不要做

- 不做对齐、层级、锁定、右键菜单（T32）。
- 不把系统剪贴板当成唯一来源：系统剪贴板可能被别的程序改写。

## 做法

1. **`keymap.ts`**：一张表列出每个快捷键、Mac / Windows 写法、行为、是否在输入框内生效（一律不生效）。快捷键说明面板直接读这张表生成，保证文档和行为一致。
2. **剪贴板**：
   - 复制：把选中展示的 `objectId`、相对位置、尺寸、外观存进页面内的剪贴板；同时往系统剪贴板写一份纯文本（标题列表），方便贴到别处。
   - 粘贴（`⌘V`）：在当前白板、鼠标位置附近新建展示，指向**同一批对象**（引用）。一次 `app_edit`，一个 `intentId`。
   - 粘贴为独立副本（`⇧⌘V`，并写进快捷键表）：先 `object.clone` 再建展示。
   - 切换工作空间时清空内部剪贴板；源对象已删除时拒绝引用粘贴并提示恢复源对象或使用工作空间导入。不得调用不存在源对象的 clone，也不自动改变复制语义。
3. **`⌘D`** 再放一份（偏移 24px），**`⇧⌘D`** 复制出独立对象并放在旁边。
4. **方向键**：移动 1px，按住 Shift 为 10px；停止按键 500ms 后作为一步写入。
5. **`⌘A`** 全选当前白板；**`⌘0` / `⌘=` / `⌘-`** 缩放复位、放大、缩小；**`?`** 打开快捷键说明；**`Escape`** 依次退出编辑、取消选择。
6. 框选：React Flow 的选择框，按住 Shift 拖动时出现（不和画布平移抢）。

## 验收

- `workbench/tests/keymap.test.ts`：每个快捷键在 Mac 和 Windows 上解析到正确行为；焦点在输入框时全部不触发。
- `workbench/tests/blank.ts`：
  1. 复制两张卡片、粘贴：多两个展示，对象数不变；改其中一个对象的正文，两处显示一起变；撤销一次两个新展示都消失。
  2. `⇧⌘V`：对象数多 2，改副本不影响原对象。
  3. `⌘D` 与 `⇧⌘D` 同理各断言一次。
  4. 方向键连按 5 次再停：位置变化 5px，历史只多一条。
  5. `?` 打开说明面板，面板里的条目数等于 `keymap.ts` 里的条目数。
  6. 在设置对话框里按 `⌘V`、方向键，画布不发生任何变化。
- `npm run format:check`、`npm run typecheck`、`npm test`、`npm run test:blank` 全部通过。

## 交接与边界验收

保存剪贴板 workspaceId；切换空间清空。缺失源对象整批拒绝，无半批展示。普通 clone 不复制 container 内部白板内容，UI 写明“复制对象内容，不复制内部白板”；模板复用由 template.apply。
