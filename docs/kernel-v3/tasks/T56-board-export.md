# T56 白板导出为图片、PDF 和静态网页

| 项 | 内容 |
|---|---|
| 执行 | minimax |
| 依赖 | T54、T37、T32、T44、T51、T55、T72、T47 |
| 分支 | `task/T56-board-export` |
| 关联 issue | #42 |

## 目标

把一块白板或选中的区域导出成 PNG、PDF 或一个只读的静态 HTML，方便分享给没有安装 Sand Table 的人。导出前清楚告诉用户哪些内容不能被导出。

## 先读

- `AGENTS.md`
- `docs/kernel-v3/05-delivery-contracts.md`（本阶段公共契约与交接规则）
- `docs/adr/0005-design-and-export.md`（**做法和已知限制以它为准**）
- 外壳的白板面板与右键菜单（T37、T32）

## 开工前核对

确认 ADR 0005 已合并，写明了三种导出的做法和限制。不一致或没写清，先停下来问。

## 可改文件

- 新建 `workbench/board/export/`（`exportPng.ts`、`exportPdf.ts`、`exportHtml.ts`、`ExportDialog.tsx`）
- 白板面板和右键菜单里挂“导出”的地方
- `workbench/package.json`、`workbench/package-lock.json`（只加 ADR 选定的依赖，版本写死）
- 新建 `workbench/tests/board-export.test.ts`，修改 `workbench/tests/blank.ts`

## 不要做

- 不做可编辑格式的导出（PPT、Word）。
- 不上传到任何网络服务。

## 做法

1. **导出对话框**：范围（整块白板 / 选中区域）、格式（PNG / PDF / HTML）、PNG 的倍率（1x、2x）、是否包含评论。
2. **不能导出的内容**：对话框里提前列出——运行中的原型和视频导出为静态截图或封面；不可取得时用明确占位，音频不导出，外部链接保留为文字链接。
3. **静态 HTML**：一个自包含文件，内联必要的样式和图片；只读；不含任何脚本和会话凭据。
4. 导出完成后用宿主的下载能力保存。

## 验收

- `workbench/tests/board-export.test.ts`：静态 HTML 里没有 `<script>`、没有 `#session=`；选区范围计算。
- `workbench/tests/blank.ts`：导出一块含便签、图片、视频的白板为 PNG 和 HTML，文件非空；HTML 在新页面里打开能看到便签文字和图片，视频位置是封面图。
- `npm run format:check`、`npm run typecheck`、`npm test`、`npm run test:blank` 全部通过。

## 交接与边界验收

增加 PDF 实际输出验证、图表单独导出入口、HTML 转义/事件属性/危险 URL/嵌入脚本 fixture；测试像素或文本内容而非只验非空。
