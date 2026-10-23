# T35 表单控件

| 项 | 内容 |
|---|---|
| 执行 | minimax |
| 依赖 | T34 |
| 分支 | `task/T35-widgets` |
| 关联 issue | #33 |

## 目标

按 `x-sand-widget` 把每种控件的“显示”和“编辑”都做出来，替换 T34 里的文本输入兜底。每个控件都能区分“没填”和“填了 0 / 空列表”。

## 先读

- `AGENTS.md`
- `docs/kernel-v3/05-delivery-contracts.md`（本阶段公共契约与交接规则）
- `docs/kernel-v3/03-types-and-extensions.md` §3.2（控件列表与提示关键字）、§10（锚点格式，`locator` 控件要用）
- `workbench/board/views/registry.ts`、`format.ts`（T34 定的控件接口）

## 开工前核对

确认 `views/registry.ts` 里的 `Widget`、`WidgetProps` 与 T34 卡片一致。依赖未完成则等待；机械差异按 05 §1 适配，语义冲突只暂停受影响部分。

## 可改文件

- 新建 `workbench/board/widgets/`，每个控件一个文件
- `workbench/board/views/registry.ts`（登记控件）、`workbench/board/views/format.ts`
- `workbench/board/style.css`
- 新建 `workbench/tests/widgets.test.ts`，修改 `workbench/tests/blank.ts`

## 不要做

- `markdown` 控件只做“多行文本框 + 纯文本预览”，富文本编辑器是 T43 的事。
- 不改类型声明，不改内核。

## 做法

每个控件都要有：显示格式化函数（纯函数，单测）、编辑组件、清空按钮（触发 `onChange(undefined)`）。

| 控件 | 显示 | 编辑要点 |
|---|---|---|
| `text` | 原文 | 单行；`maxLength` 实时显示剩余字数 |
| `longtext` | 前 200 字 | 多行，自动增高 |
| `markdown` | 去掉标记的前 200 字 | 多行文本框 + 预览切换 |
| `number` / `integer` | 数字 + `x-sand-unit` | 空输入 = 清空，不当成 0；`integer` 拒绝小数；超出 `minimum` / `maximum` 即时提示 |
| `boolean` | 是 / 否 | 三态：是、否、未设置 |
| `enum` | `x-sand-enum-labels` 里的中文名 | 下拉，含“未设置” |
| `tags` | 标签串 | 回车添加、点 × 删除；重复的忽略 |
| `date` | `YYYY年M月D日` | 日期选择器，存 `YYYY-MM-DD` |
| `url` | 域名 + 路径前 40 字，可点击 | 只接受 http(s)，点击用宿主的打开链接能力 |
| `color` | 色块 + 十六进制 | 颜色选择器 |
| `locator` | “PDF 第 3 页”“第 12–20 行”这类人话 | 分字段编辑 `kind`、`uri`、`fragment`，`fragment` 按 `03` §10 的格式校验 |
| `blob` | 文件名、大小、缩略图（图片） | 选择文件 → `app_asset upload` → 存 sha256 |
| `table` | 行数 × 列数 | 小型表格编辑：增删行列、编辑单元格 |
| `list` | “N 项” | 数组里每项按 `items` 的 Schema 生成一组子控件，可增删、上移下移 |

## 验收

- `workbench/tests/widgets.test.ts`：每个控件的显示函数；`number` 空输入返回 `undefined`、`"0"` 返回 `0`；`integer` 拒绝 `1.5`；`date` 往返；`locator` 的 `fragment` 校验；`tags` 去重。
- `workbench/tests/blank.ts`：在人物表单里分别编辑定位（文字）、年龄（整数）、性格（标签），服务端数据正确；清空年龄后字段从数据里消失。
- 表单在 200% 文字缩放下仍可用（在 PR 里附截图）。
- `npm run format:check`、`npm run typecheck`、`npm test`、`npm run test:blank` 全部通过。

## 交接与边界验收

blob/locator 编辑通过宿主注入服务，不让任意自定义视图直接调用工具；清空与 null 分开，嵌套对象/list 编辑遵守 Schema。
