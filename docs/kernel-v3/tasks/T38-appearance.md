# T38 外观：主题与外观设置

| 项 | 内容 |
|---|---|
| 执行 | minimax |
| 依赖 | T37 |
| 分支 | `task/T38-appearance` |
| 关联 issue | #25（§1.1 视觉、§1.3 外观工作台） |

## 目标

提供黑白、暖纸两套完整主题；在设置里实时预览地调整颜色、字体、字号、行距、密度、圆角、阴影、动效；可以恢复默认、导入导出主题；单块白板可以覆盖工作空间的主题。所有调整可以撤销。

## 先读

- `AGENTS.md`
- `docs/kernel-v3/05-delivery-contracts.md`（本阶段公共契约与交接规则）
- issue #25 的 §1.1、§1.3
- `docs/kernel-v3/02-commands-and-tools.md` §1.1（`setting.set`）
- `docs/kernel-v3/01-data-model.md` §4（`settings` 表）、§5（`Appearance.accent`）
- `workbench/board/style.css`（现有颜色变量）、`workbench/board/CanvasShell.tsx` 的设置对话框

## 开工前核对

确认 T37 已合并，设置面板入口存在；`setting.set` 可用。依赖未完成则等待；机械差异按 05 §1 适配，语义冲突只暂停受影响部分。

## 可改文件

- 新建 `workbench/board/theme/`（`tokens.ts`、`presets.ts`、`apply.ts`、`ThemeSettings.tsx`）
- `workbench/board/style.css`（把写死的颜色、圆角、阴影换成变量）
- 设置面板里挂主题设置的那一处
- 新建 `workbench/tests/theme.test.ts`，修改 `workbench/tests/blank.ts`

## 不要做

- 不做工具栏拖动、导航重排（以后再开卡）。
- 不引入 CSS 框架。

## 做法

1. **主题结构**（`tokens.ts`，存进 `settings` 的 `theme` 键）：

   ```ts
   type Theme = {
     name: string;
     base: "mono" | "paper";
     colors: { background: string; surface: string; ink: string; muted: string; line: string; accent: string };
     font: "system" | "serif" | "mono";
     fontSize: number;   // 12–20
     lineHeight: number; // 1.3–2.0
     density: "comfortable" | "compact";
     radius: number;     // 0–20
     shadow: "none" | "soft" | "strong";
     motion: { speed: number; reduce: boolean }; // speed 0.5–2
   };
   ```

2. **预设**（`presets.ts`）：黑白（偏 Apple / OpenAI 的冷静黑白灰）与暖纸（偏 Anthropic 的米色纸张）。两套都要满足正文对比度至少 4.5:1（单测计算）。
3. **应用**：主题转成 CSS 变量挂到根元素；`motion.reduce` 或系统“减少动态效果”打开时，所有过渡时长为 0。
4. **设置界面**：每项调整立即预览；停止调整 500ms 后 `setting.set` 写入（一次拖动滑块是一步历史）。“恢复默认”回到当前预设。正文对比度低于 4.5:1 时在颜色选择旁给出提示，不阻止保存。
5. **白板覆盖**：设置 `theme.board.<白板 id>` 只覆盖与工作空间主题不同的字段；进入该白板时合并应用；提供“跟随工作空间”一键清除覆盖。
6. **导入导出**：主题导出为 JSON 文件；导入时校验结构和取值范围，不合格的字段逐条报错，不应用半个主题。

## 验收

- `workbench/tests/theme.test.ts`：两套预设的对比度计算；取值范围校验；白板覆盖与工作空间主题的合并结果；导入不合格 JSON 报出具体字段。
- `workbench/tests/blank.ts`：切换到黑白主题后根元素的背景变量改变；撤销一次回到暖纸；为某块白板设置覆盖后，进入它颜色变化，返回后恢复。
- 在 PR 里附两套主题的截图。
- `npm run format:check`、`npm run typecheck`、`npm test`、`npm run test:blank` 全部通过。

## 交接与边界验收

白板主题覆盖是 settings 的布局配置键，不能用来表达语义对象关联；清除走 setting.delete（若当前命令无此 op，由本卡在共享命令事务中补齐及测试），不存 undefined。
