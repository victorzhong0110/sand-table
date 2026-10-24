# T54 技术验证：图形、交互原型与白板导出

| 项 | 内容 |
|---|---|
| 执行 | grok |
| 依赖 | T41 |
| 分支 | `task/T54-design-spike` |
| 类型 | 技术验证。产出决策记录，不改产品代码 |
| 关联 issue | #42 |

## 要回答的问题

1. **基础图形**（矩形、圆、线、箭头、图标、文字样式）：做成普通组件类型（每个图形一个对象）够不够用？还是需要一个“绘图”组件在内部管理很多图形？比较两种做法在选择、撤销、AI 读写上的差别，给出结论。
2. **交互原型预览**：AI 生成的网页原型（HTML/CSS/JS）放在白板上运行。在现有 CSP 下，用 `sandbox="allow-scripts"`（不加 `allow-same-origin`）的 iframe 运行是否可行？原型里的点击、表单能否工作？如何禁止网络请求、禁止访问宿主？额外测死循环时父 UI 是否仍可取消；只有实测独立进程/终止能力才能承诺资源隔离。怎么区分“编辑模式”和“运行模式”，让原型不抢画布操作？
3. **可调参数**：AI 生成的原型如何暴露“可理解的调整参数”（颜色、文案、尺寸）？候选：原型声明一份参数 Schema，白板用 T35 的控件编辑参数，原型通过消息接收新参数。
4. **白板导出**：把一块白板或选中区域导出为 PNG、PDF、静态 HTML。候选做法：DOM 转图片的库（如 `html-to-image`，MIT）、浏览器打印成 PDF、序列化为只读 HTML。每种做法对 iframe 内容（原型、视频）的处理。
5. 每个依赖的体积和许可证；按 T41 的规则能否按需加载。

## 先读

- `AGENTS.md`
- `docs/kernel-v3/05-delivery-contracts.md`（本阶段公共契约与交接规则）
- issue #42
- `docs/kernel-v3/03-types-and-extensions.md` §7（二级扩展的沙箱规则，原型预览应与它一致）
- `docs/adr/0002-bundle-loading.md`

## 可改文件

- 新建 `docs/adr/0005-design-and-export.md`
- 新建 `workbench/spikes/design/`（不参与构建和测试）

## 不要做

- 不修改产品代码，不往 `workbench/package.json` 加依赖。

## 交付

`docs/adr/0005-design-and-export.md`：上面 5 个问题的实测与结论；`base.shape`、`base.prototype` 两个类型的数据结构建议（JSON Schema 草案）；原型与宿主的消息协议草案；导出的做法与已知限制。架构负责人审过合并后，T55、T56 才开工。
