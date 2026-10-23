# T45 PDF：查看与页级引用

| 项 | 内容 |
|---|---|
| 执行 | grok |
| 依赖 | T41（决策记录已合并）、T44 |
| 分支 | `task/T45-pdf` |
| 关联 issue | #38、#41 |

## 目标

PDF 能在白板上直接翻页、缩放；选中某一页可以“引用这一页”，生成一个带页码和指纹的引用，点击引用能回到那一页。

## 先读

- `AGENTS.md`
- `docs/adr/0002-bundle-loading.md`（pdf.js 和 worker 的做法以它为准）
- `docs/kernel-v3/03-types-and-extensions.md` §10（PDF 锚点格式）
- `workbench/packs/research/`（科研包的 PDF 工具 `research_pdf`，T23 产物）
- `workbench/board/media/`（T44 产物）

## 开工前核对

确认 ADR 0002 写明了 pdf.js worker 的做法，T44 已合并。不一致先停下来问。

## 可改文件

- 新建 `workbench/board/media/PdfView.tsx`、`workbench/board/media/pdf-locator.ts`
- `workbench/board/views/registry.ts`
- `workbench/packs/base/index.ts`（`base.media` 的视图按 `mime` 为 `application/pdf` 时用 PDF 视图）
- 构建配置（按 ADR）
- 新建 `workbench/tests/pdf-view.test.ts`，修改 `workbench/tests/blank.ts`

## 不要做

- 不做 OCR、全文搜索、区域框选（区域锚点是 T53）。
- 不改 `research_pdf` 的行为。

## 做法

1. **查看**：卡片上显示当前页；上一页、下一页、页码输入、缩放；双击打开大查看器。翻页和缩放只是视图状态，不进历史。
2. **页级引用**：查看器里“引用这一页” → 新建一个 `research.evidence`（科研包启用时）或 `base.note`（否则），`citation` / 正文里带 `ExternalLocator`：`kind: "pdf"`、`uri: "blob:<sha256>"`、`fragment: "page=<N>"`、`fingerprint`（该页文字的 sha256）；同时建 `base.about` 关系指向 PDF 对象。
3. **回跳**：点击引用里的定位，打开 PDF 查看器并翻到那一页。
4. **失效检查**：PDF 被替换（sha256 变了）后，引用显示“原文件已更换，页码可能对不上”；同一文件但该页文字指纹不同时显示“该页内容已变化”。

## 验收

- `workbench/tests/pdf-view.test.ts`：`fragment` 生成与解析；指纹比较。
- `workbench/tests/blank.ts`：放入一个 3 页的测试 PDF（放在 `tests/fixtures/`，自己生成，不用有版权的文件），翻到第 2 页并引用，生成的引用带 `page=2`；点击引用回到第 2 页；替换 PDF 后引用显示失效提示。
- 构建后体积符合 ADR 0002。
- `npm run format:check`、`npm run typecheck`、`npm test`、`npm run test:blank` 全部通过。
