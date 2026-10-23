# T53 精确锚点与失效重定位

| 项 | 内容 |
|---|---|
| 执行 | minimax |
| 依赖 | T43、T45、T51、T47 |
| 分支 | `task/T53-anchors` |
| 关联 issue | #38 第二阶段、#41 第二阶段 |

## 目标

可以把引用或批注精确地挂在：一段文字、PDF 页面上的一个区域、图片上的一个区域、音视频的一个时间点或区间、表格的若干行列。原内容变化后，能重新定位的自动跟上，不能的明确标为失效并允许手动重新定位，**绝不悄悄挂到错误的内容上**。

## 先读

- `AGENTS.md`
- `docs/kernel-v3/05-delivery-contracts.md`（本阶段公共契约与交接规则）
- `docs/kernel-v3/03-types-and-extensions.md` §10（锚点格式，**以它为准**）
- `workbench/board/richtext/`（T43）、`workbench/board/media/`（T44、T45）、`workbench/board/comments/`（T51）

## 开工前核对

确认 T43、T45、T51 已合并。内部锚点以本卡、`03` §10 和 `05` §2 为准，已经定了：`{ fragment, version?, fingerprint? }`，对象由关系端点表示。不要因为这份格式相对更早草稿改过而停下来，也不要改回带对象 id 的 `sand://object/` uri。依赖未完成则等待；机械差异按 05 §1 适配。

## 可改文件

- 新建 `workbench/board/anchors/`（`fragment.ts` 解析与生成、`relocate.ts` 重新定位、`AnchorOverlay.tsx` 在内容上画出锚点、`pick.ts` 选择锚点的交互）
- `workbench/board/richtext/`、`workbench/board/media/`、`workbench/board/comments/`、`workbench/board/data/TableView.tsx`（接入选择和显示）
- 新建 `workbench/tests/anchors.test.ts`，修改 `workbench/tests/blank.ts`

## 不要做

- 不把对象 id 或 `sand://object/` 写进锚点，不新增 `ExternalLocator` 的 `kind: "object"`，不给内部锚点加 `uri`。
- 不改 `03` §10 的 fragment 格式；需要改格式，先停下来问。
- 不做 OCR。

## 做法

1. **`fragment.ts`**：`03` §10 每种格式的解析、生成和校验（纯函数）。
2. **选择锚点**（`pick.ts`）：
   - 文字：选中一段文字 → 右键“引用”或“批注”。
   - PDF、图片：在查看器里框选一个区域。
   - 音视频：在当前播放位置打点，或拖出一个区间。
   - 表格：选中若干单元格。
   生成的锚点只放进 base.comments_on 或 base.cites 关系的 `attributes.anchor`，形状是 `{ fragment, version?, fingerprint? }`。对象只由关系端点表示。新引用建 base.note，引用文字与原文分开。
3. **显示**：在原内容上高亮锚点；悬停显示对应的批注或引用；点击引用跳到原内容并高亮。
4. **重新定位**（`relocate.ts`）：原内容的指纹变了时：
   - 文字：在新内容里找 `quote`；有多处匹配时用 `prefix` / `suffix` 区分；唯一匹配就更新位置并标“已自动跟上”；找不到或仍有歧义就标失效。
   - PDF、图片：源文件 sha256 变了就标失效（不尝试自动移动区域）。
   - 表格：按行列 key 找，key 不存在就标失效。
   失效的锚点显示原因（“原文已改动，找不到这段话”），提供“重新选择位置”和“保留为失效记录”。

## 验收

- `workbench/tests/anchors.test.ts`：每种格式的往返；文字重新定位在“唯一匹配”“多处匹配靠上下文区分”“找不到”三种情况下的结果；百分号编码。
- `workbench/tests/blank.ts`：
  1. 在便签里选一段话写批注；在这段话前面插入一句，批注仍高亮在原来那段话上；删掉这段话，批注显示失效原因。
  2. 在测试 PDF 第 2 页框选一个区域写批注，点击批注回到该区域。
  3. 在测试视频 3 秒处打点批注，点击批注跳到 3 秒。
- `npm run format:check`、`npm run typecheck`、`npm test`、`npm run test:blank` 全部通过。

## 交接与边界验收

音视频内容换 blob 或时段越界判失效。关系上的 anchor 只接受 fragment、可选 version 和 fingerprint；带 uri 或对象 id 的锚点拒绝写入。不修改 `ExternalLocator` 的 kind 联合。关系更新携带版本条件，重定位结果仅唯一匹配可采纳。
