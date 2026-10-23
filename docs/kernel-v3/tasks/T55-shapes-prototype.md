# T55 图形与交互原型

| 项 | 内容 |
|---|---|
| 执行 | grok |
| 依赖 | T54（决策记录已合并）、T35 |
| 分支 | `task/T55-shapes-prototype` |
| 关联 issue | #42 |

## 目标

白板上可以画基础图形（矩形、圆、线、箭头、图标、文字），样式跟随外观主题又可单独调整；可以放一个交互原型，在“运行模式”里点得动，在“编辑模式”里像普通组件一样拖动；原型暴露的参数可以在表单里调整。原型运行在沙箱里，不能联网、不能读写宿主。

## 先读

- `AGENTS.md`
- `docs/adr/0005-design-and-export.md`（**数据结构和消息协议以它为准**）
- `docs/kernel-v3/03-types-and-extensions.md` §7
- `workbench/board/theme/`（T38）、`workbench/board/widgets/`（T35）

## 开工前核对

确认 ADR 0005 已合并，并给出了 `base.shape`、`base.prototype` 的结构和原型消息协议。与本卡冲突的地方以 ADR 为准；ADR 没说清的，停下来问。

## 可改文件

- `workbench/packs/base/index.ts`（新增 `base.shape`、`base.prototype`，结构按 ADR）
- 新建 `workbench/board/design/`（`ShapeView.tsx`、`PrototypeView.tsx`、`sandbox.ts`）
- `workbench/board/views/registry.ts`、工具箱的图形分组（如需）
- 新建 `workbench/tests/design.test.ts`，修改 `workbench/tests/blank.ts`

## 不要做

- 不做复杂矢量编辑（贝塞尔曲线、布尔运算）、不做多页设计稿。
- 原型 iframe 不加 `allow-same-origin`，不放开任何网络。
- 不做“AI 修改原型”的流程（T68）。

## 做法

1. **图形**：按 ADR 的结构实现；颜色默认取主题变量，单独设置后保存在对象数据里；线和箭头的端点可以吸附到其他组件的边（吸附只影响绘制，不建关系）。
2. **原型**：
   - 原型的 HTML 存在对象数据里（超过 1 MB 存为附件）。
   - 编辑模式（默认）：显示一张静态截图或占位，可拖动、选中、调整尺寸。
   - 运行模式：卡片上点“运行”，在 `sandbox="allow-scripts"` 的 iframe 里加载，CSP 禁止一切网络；iframe 外加一层边框和“停止”按钮；运行中卡片不能拖动，Escape 或“停止”回到编辑模式。
   - 参数：原型声明的参数 Schema 在表单里用 T35 的控件编辑，改动通过消息发给运行中的原型。
   - 消息：只接受 ADR 列出的消息类型，每条校验来源是该 iframe；其他一律丢弃。
3. 原型运行出错时，在卡片上显示错误信息，不影响白板。

## 验收

- `workbench/tests/design.test.ts`：图形数据校验；原型消息白名单（非法类型、错误来源被丢弃）。
- `workbench/tests/blank.ts`：
  1. 画一个矩形和一条连到另一组件的箭头，移动那个组件后箭头跟随，服务端没有新关系。
  2. 放一个带按钮的测试原型，运行模式下点击按钮，原型内文字变化；编辑模式下拖动卡片可用。
  3. 测试原型里执行 `fetch("https://example.com")` 失败；访问 `parent.document` 报错。
  4. 在表单里改原型的“按钮文字”参数，运行中的原型立即更新。
- 构建后体积符合 ADR 0002。
- `npm run format:check`、`npm run typecheck`、`npm test`、`npm run test:blank` 全部通过。
