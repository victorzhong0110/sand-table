# 内核 v3 任务总览

设计依据：`docs/kernel-v3/00-decisions.md` 到 `05-delivery-contracts.md`。

## 角色

| 角色 | 谁 | 做什么 |
|---|---|---|
| 项目所有者 | 你 | 真人使用、反馈问题、决定合并 |
| 架构负责人 | 设计与审查模型 | 写设计和任务卡；在 PR 评论里审查；不写实现代码 |
| 编码（强） | grok 4.7 档 | 卡片标“grok”的关键内核、执行和技术验证任务 |
| 编码（标准） | minimax m3.1 档 | 卡片标“minimax”的实现与验证任务；按本轮约 80% 分配 |

## 一张卡怎么流转

1. 你把卡片交给对应的编码模型，提示词用下面这段（替换卡片路径）：

   ```text
   你是 sand-table 仓库的编码 Agent。先完整读 AGENTS.md，再读 docs/kernel-v3/tasks/T10-kernel-db.md，严格按卡片执行。
   按公共交付契约处理接口交接与机械差异；真正语义冲突才暂停受影响部分。完成全部验收后开 PR，逐项给出证据。
   ```

2. 编码模型建分支 `task/Txx-…`，实现，跑完卡片“验收”里的全部命令，开 PR（标题 `Txx: …`，描述按 `.github/pull_request_template.md`）。
3. 你让架构负责人审查这个 PR。审查意见写在 PR 评论里，结论是“通过”或“需修改”。
4. 需修改：把 PR 链接交回同一个编码模型，提示“读 PR 里的审查评论并逐条修改”。
5. 通过且 CI 全绿：你合并。

### 附加规则

- **开工前核对**：Phase 2 之后的卡片写于它依赖的代码完成之前。卡片里有“开工前核对”一节的，编码模型必须先确认那些接口在 `main` 上存在且形状一致；机械差异按 05 §1 适配并记录；实质语义冲突才暂停受影响部分。
- **技术验证卡**（标“类型：技术验证”）只产出 `docs/adr/` 下的决策记录和 `workbench/spikes/` 下的验证代码，不改产品代码。决策记录由架构负责人审查合并后，依赖它的实现卡才开工；ADR 只决定授权的技术选择，不覆盖 00–05 的产品与内核契约。
- **执行者是“项目所有者”的卡**（T66、T69）是需要你亲自操作的检查清单，结果写在对应 issue 的评论里。

## 阶段与任务

沿用 main 的所有者分工要求：约 80% 的实现交给 minimax，T15/T24 保留 grok；本轮后续 grok 负责 T24/T30/T40/T54/T61/T64/T65/T70，其余编码卡由 minimax 执行。已合并卡不重做，新增早期契约由 T74 补齐。任务表与卡头必须一致。

### Phase 0：让现有版本能用（与 Phase 1 并行）

| 卡 | 标题 | 执行 | 依赖 | issue |
|---|---|---|---|---|
| [T01](T01-history-flat.md) | 历史面板主链不缩进 | minimax | — | #26 |
| [T02](T02-select-resize-delete.md) | 选中即可调整尺寸、删除键移除、Esc 取消选择 | minimax | — | #30 |
| [T03](T03-copy-agent-message.md) | Agent 消息有独立复制按钮，不被覆盖 | minimax | — | #31 |
| [T04](T04-reopen-blank-screen.md) | 重新打开白板不再沉默白屏 | grok | — | #28 |
| [T05](T05-drag-unmount.md) | 拖动时卡片不被卸载重挂 | grok | — | #29 |

### Phase 1：新内核（只在 `workbench/kernel/` 和 `workbench/packs/` 里新建，不改 v2 代码）

| 卡 | 标题 | 执行 | 依赖 |
|---|---|---|---|
| [T10](T10-kernel-db.md) | 数据库层与全部共享类型 | grok | — |
| [T11](T11-registry.md) | 类型注册表与 Ajv 校验 | grok | T10 |
| [T12](T12-builtin-packs.md) | 内置包类型声明 | minimax | T11 |
| [T13](T13-apply-commands.md) | 统一写入 `applyCommands` 与历史记录 | grok | T11 |
| [T14](T14-history-ops.md) | 撤销、重做、跳转与容量裁剪 | grok | T13 |
| [T15](T15-read-api.md) | 读接口 | grok | T14 |
| [T16](T16-architecture-tests.md) | 架构测试 | minimax | T10 |
| [T17](T17-import-v2.md) | v2 工作空间导入器 | minimax | T12、T13 |

T12 与 T13 可以并行；T16 可以在 T10 合并后随时做。

### 已完成的加固卡（审查中追加，已合并）

| 卡 | 标题 |
|---|---|
| [T06](T06-transaction-retry.md) | 数据库锁冲突后可以重试写入 |
| [T07](T07-kernel-contracts.md) | 内核契约修订：设置与包的墓碑、内部命令、无损导入 |
| [T08](T08-registry-validation.md) | 包声明的元校验与注册失败后的重试 |
| [T09](T09-desktop-reliability.md) | Windows 桌面版的 MCP 配置与便携路径 |
| [T18](T18-ui-reliability.md) | 弹窗按键隔离、工具箱闪变、异步验收 |
| [T19](T19-architecture-checks.md) | 架构检查的路径逃逸与导入漏检 |

### Phase 2：新工具面与切换

| 卡 | 标题 | 执行 | 依赖 |
|---|---|---|---|
| [T20](T20-tools-v3.md) | v3 工具面（8 个核心 + 界面专用） | minimax | T15、T17 |
| [T21](T21-ui-switch.md) | 界面数据层切到 v3 | minimax | T20、T74 |
| [T22](T22-code-pack.md) | 代码包迁移 | minimax | T20 |
| [T23](T23-research-folder-dsh.md) | 科研包工具、文件夹连接器、DSH 插件迁移 | minimax | T20 |
| [T25](T25-export-import.md) | 工作空间导出与导入（含附件） | minimax | T20、T17、T21 |
| [T26](T26-type-migrations.md) | 类型版本迁移运行时 | minimax | T15 |
| [T24](T24-switch-default.md) | 默认切到 v3，删除 v2 内核 | grok | T74、T21、T22、T23、T25 全部合并；项目所有者用 `SAND_KERNEL=v3` 实际使用后明确同意 |

T21、T22、T23 可以并行；T25 等 T21 合并后执行；T26 可以在 T15 合并后随时做。T24 合并后执行一次 [T69](T69-release-acceptance.md) 发布验收。

### Phase 3：画布与外壳（T24 之后，只面对 v3 一套代码）

| 卡 | 标题 | 执行 | 依赖 | issue |
|---|---|---|---|---|
| [T30](T30-react-flow-canvas.md) | React Flow 画布接入 | grok | T24 | #29、#30 |
| [T31](T31-selection-clipboard-keys.md) | 选择、剪贴板与快捷键 | minimax | T30 | #30 |
| [T32](T32-arrange-context-menu.md) | 对齐、层级、锁定、成框与右键菜单 | minimax | T30、T31 | #30 |
| [T33](T33-enter-return-navigation.md) | 进入与返回 | minimax | T30 | #25 |
| [T34](T34-generic-view.md) | 通用视图：卡片、编辑表单、关系槽 | minimax | T30、T26 | #33 |
| [T35](T35-widgets.md) | 表单控件 | minimax | T34 | #33 |
| [T37](T37-shell.md) | 外壳与信息架构 | minimax | T30、T31、T33 | #25、#28、#31 |
| [T36](T36-history-panel-v3.md) | 历史面板 v3（一级入口） | minimax | T37 | #26、#27 |
| [T38](T38-appearance.md) | 外观：主题与外观设置 | minimax | T37 | #25 |
| [T39](T39-toolbox-packs.md) | 工具箱与数据包管理 | minimax | T34、T37 | #33、#11 |

T30 后可开始 T31、T33、T34；T32 等 T31，T37 等 T31 和 T33。同文件改动顺序合并。

### Phase 4：功能组件

| 卡 | 标题 | 执行 | 依赖 | issue |
|---|---|---|---|---|
| [T40](T40-bindings-runtime.md) | 受控绑定运行时 | grok | T34 | #33 |
| [T41](T41-bundle-loading-spike.md) | 技术验证：界面体积预算与按需加载 | minimax | T30 | — |
| [T42](T42-text-spike.md) | 技术验证：富文本编辑器 | minimax | T41 | #37 |
| [T43](T43-text.md) | 富文本、公式、代码块与对象链接 | minimax | T42、T35、T33、T72 | #37 |
| [T44](T44-media.md) | 图片、音视频、文件与链接 | minimax | T72、T35、T26 | #38 |
| [T45](T45-pdf.md) | PDF 查看与页级引用 | minimax | T72、T44 | #38、#41 |
| [T46](T46-charts-spike.md) | 技术验证：图表库 | minimax | T41 | #39 |
| [T47](T47-table-charts.md) | 可编辑表格与基础图表 | minimax | T46、T40、T26、T32、T72 | #39 |
| [T48](T48-data-analysis.md) | 数据分析与联动 | minimax | T47 | #39 |
| [T49](T49-relation-graph.md) | 关系图视图 | minimax | T40、T72、T33 | #40 |
| [T50](T50-timeline.md) | 时间轴视图 | minimax | T40、T26、T33 | #40 |
| [T51](T51-comments.md) | 评论与局部批注 | minimax | T34 | #41 |
| [T52](T52-compare-diff.md) | 并排比较与差异 | minimax | T40、T26、T47、T32 | #41 |
| [T53](T53-anchors.md) | 精确锚点与失效重定位 | minimax | T43、T45、T51、T47 | #38、#41 |
| [T54](T54-design-spike.md) | 技术验证：图形、交互原型与白板导出 | grok | T41 | #42 |
| [T55](T55-shapes-prototype.md) | 图形与交互原型 | minimax | T54、T35、T38、T39、T72 | #42 |
| [T56](T56-board-export.md) | 白板导出为图片、PDF 和静态网页 | minimax | T54、T37、T32、T44、T51、T55、T72、T47 | #42 |

T41 是所有带新依赖的组件的前提，Phase 3 一开始就可以做。T41 先行；T42/T46/T54 等 T41。T72 将 T41 的结论落地，资源加载实现完成后组件才能接入。

### Phase 5：情境、规则与扩展

| 卡 | 标题 | 执行 | 依赖 | issue |
|---|---|---|---|---|
| [T60](T60-intersection-context.md) | 交叉情境 | minimax | T34、T49 | #35 |
| [T61](T61-time-change-spike.md) | 技术验证：时间、变化、分支与观察者 | grok | T60、T50 | #35、#40 |
| [T62](T62-rules-contract.md) | 规则：契约与运行记录 | minimax | T34、T40 | #36 |
| [T63](T63-controls.md) | 输入控件组件 | minimax | T62 | #36 |
| [T66](T66-dsh-device-check.md) | DSH 真机验证 | **项目所有者**（需要一台装了 DeepSeek Harness 的机器；遇到问题可以让 grok 在那台机器上协助排查） | T23（DSH 插件已改接 v3 工具面） | #18 |
| [T64](T64-rule-execution.md) | 规则执行与宿主接入 | grok | T62、T63、T66（至少在一个真实宿主上确认了任务提交能用） | #36、#18 |
| [T65](T65-rule-reliability.md) | 规则可靠性 | grok | T64 | #36 |
| [T67](T67-sandboxed-views.md) | 二级扩展：沙箱里的自定义视图 | minimax | T40、T39、T55 | — |
| [T68](T68-prototype-feedback-to-agent.md) | 原型元素批注交给宿主 Agent 修改 | minimax | T53、T55、T64、T65、T52 | #41、#42 |
| [T69](T69-release-acceptance.md) | 发布验收 | **项目所有者**做真人任务；发现的文档不一致交给 minimax 按本卡最后一节修正 | 每次准备发布时执行一次。第一次在 T24 合并后（v3 成为默认），之后每个阶段收尾各一次 | #15 |

T66 只依赖 T23，Phase 2 一结束你就可以做，越早做越好：T64 和 T68 都依赖它的结论。T61 验证固定模型后直接执行 T70、T71、T73；研究记录不代替实现验收。

### 补齐的实现与集成卡

| 卡 | 标题 | 执行 | 依赖 |
|---|---|---|---|
| [T70](T70-temporal-records.md) | 时间与关系状态：存储和查询 | grok | T61、T26、T60 |
| [T71](T71-temporal-editor.md) | 时间、分支与观察者编辑和建议 | minimax | T70、T50、T51 |
| [T72](T72-component-runtime.md) | 组件资源加载、worker 与宿主运行适配 | minimax | T41 |
| [T73](T73-process-range.md) | 过程白板与观察范围 | minimax | T50、T71 |
| [T74](T74-existing-contract-backfill.md) | 已合并内核与工具面的契约补齐 | minimax | T17、T20 |

### 没有写成卡片的部分

本轮完成范围以下表为准；下列候选不纳入本轮“完成”承诺，不能将其误记成已实现：#37 的长文排版与混合内容、#40 的日历视图与回放、#25 的工具栏拖动与导航重排、地图与 3D、可执行代码与 notebook、第三方组件市场。

## v2 期间的新问题怎么处理

Phase 1、2 期间你继续用 v2，发现问题照常开 issue（用 `.github/ISSUE_TEMPLATE/bug.md`，写现象、步骤、期望就够）。架构负责人分流：

- **阻塞使用**（丢数据、无法继续操作、白屏）：开 Phase 0 风格的小卡，在 v2 上修。
- **落在将被替换的代码里**（`core/store.ts`、`core/workspace.ts`、`board/SpaceCanvas.tsx` 等）且不阻塞：打标签 `v3-covered`，在对应 v3 卡片的验收里加一条，不在 v2 上修。
- **新需求**：归到 Phase 3 以后的对应卡片；没有对应卡片的，架构负责人新开一张。

## 架构负责人的审查清单

1. 修改限于卡片“可改文件”和 05 §1 公共集成范围。
2. 卡片“验收”里的每条都有对应测试或明确的手工核对记录。
3. 没有把测试改松。
4. 没有引入卡片没点名的依赖；版本写死。
5. 命名与 `01-data-model.md` 术语表一致，没有用被禁用的 v2 名词。
6. 错误信息是中文、具体、能指导下一步。
7. PR 描述如实写了没做到的部分。

## 完成范围与交付对应

| 能力 | 实现卡 | 最终验收 |
|---|---|---|
| v3 读写、迁移、代码/科研/文件夹工具、工作空间导入导出 | T17、T20–T26 | T69 保存重开与往返 |
| 画布、复制、导航、表单、主题、历史、组件包 | T30–T39 | T69 无 Git/AI 创作 |
| 文字、公式、媒体、PDF、批注、锚点、比较 | T43–T45、T51–T53 | T69 来源回跳与失效 |
| 表格、图表、指标、筛选计算与联动 | T47–T48 | T69 同源更新 |
| 关系图、时间轴、交叉、时间状态/关系、分支、观察者、过程范围 | T49–T50、T60、T70–T71、T73 | T69 同一事实多入口与范围不改历史 |
| 图形、交互原型、分享、候选修改 | T55–T56、T68 | T69 草图→真机修改→分享 |
| 规则、控件、实际运行与可靠性 | T62–T65 | T66 真机能力 + T69 实际任务 |
| 资源加载、第三方视图 | T72、T67 | T69 宿主能力与受限项明示 |

T41/T42/T46/T54/T61 是验证，不算对应功能完成。最终运行能力需要 T66 真实宿主，体验需要 T69 真人；没有设备时记录阻塞，不能用“所有卡写完”替代完成。运行 `python3 docs/kernel-v3/check_plan.py` 核对卡片编号、执行者、依赖无环、索引一致与文档链接。
