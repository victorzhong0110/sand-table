# 内核 v3 任务总览

设计依据：`docs/kernel-v3/00-decisions.md` 到 `04-canvas.md`。

## 角色

| 角色 | 谁 | 做什么 |
|---|---|---|
| 项目所有者 | 你 | 真人使用、反馈问题、决定合并 |
| 架构负责人 | 设计与审查模型 | 写设计和任务卡；在 PR 评论里审查；不写实现代码 |
| 编码（强） | grok 4.7 档 | 卡片标“grok”的任务：跨文件、需要判断、需要排查 |
| 编码（标准） | minimax m3.1 档 | 卡片标“minimax”的任务：边界清楚、照规格实现 |

## 一张卡怎么流转

1. 你把卡片交给对应的编码模型，提示词用下面这段（替换卡片路径）：

   ```text
   你是 sand-table 仓库的编码 Agent。先完整读 AGENTS.md，再读 docs/kernel-v3/tasks/T10-kernel-db.md，严格按卡片执行。
   卡片里没写的事不要做；拿不准就停下，在 PR 描述里写“需要架构确认：……”。完成后开 PR。
   ```

2. 编码模型建分支 `task/Txx-…`，实现，跑完卡片“验收”里的全部命令，开 PR（标题 `Txx: …`，描述按 `.github/pull_request_template.md`）。
3. 你让架构负责人审查这个 PR。审查意见写在 PR 评论里，结论是“通过”或“需修改”。
4. 需修改：把 PR 链接交回同一个编码模型，提示“读 PR 里的审查评论并逐条修改”。
5. 通过且 CI 全绿：你合并。

### 附加规则

- **开工前核对**：Phase 2 之后的卡片写于它依赖的代码完成之前。卡片里有“开工前核对”一节的，编码模型必须先确认那些接口在 `main` 上存在且形状一致；不一致就停下来，在 PR 里写“需要架构确认：卡片与 main 不一致：……”，由架构负责人修订卡片后再做。
- **技术验证卡**（标“类型：技术验证”）只产出 `docs/adr/` 下的决策记录和 `workbench/spikes/` 下的验证代码，不改产品代码。决策记录由架构负责人审查合并后，依赖它的实现卡才开工；实现卡与决策记录冲突时以决策记录为准。
- **执行者是“项目所有者”的卡**（T66、T69）是需要你亲自操作的检查清单，结果写在对应 issue 的评论里。

## 阶段与任务

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
| [T17](T17-import-v2.md) | v2 工作空间导入器 | grok | T12、T13 |

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
| [T20](T20-tools-v3.md) | v3 工具面（8 个核心 + 界面专用） | grok | T15、T17 |
| [T21](T21-ui-switch.md) | 界面数据层切到 v3 | grok | T20 |
| [T22](T22-code-pack.md) | 代码包迁移 | grok | T20 |
| [T23](T23-research-folder-dsh.md) | 科研包工具、文件夹连接器、DSH 插件迁移 | minimax | T20 |
| [T25](T25-export-import.md) | 工作空间导出与导入（含附件） | grok | T20、T17 |
| [T26](T26-type-migrations.md) | 类型版本迁移运行时 | grok | T15 |
| [T24](T24-switch-default.md) | 默认切到 v3，删除 v2 内核 | grok | T21、T22、T23、T25，以及你用 `SAND_KERNEL=v3` 实际使用后同意 |

T21、T22、T23、T25 可以并行；T26 可以在 T15 合并后随时做。T24 合并后执行一次 [T69](T69-release-acceptance.md) 发布验收。

### Phase 3：画布与外壳（T24 之后，只面对 v3 一套代码）

| 卡 | 标题 | 执行 | 依赖 | issue |
|---|---|---|---|---|
| [T30](T30-react-flow-canvas.md) | React Flow 画布接入 | grok | T24 | #29、#30 |
| [T31](T31-selection-clipboard-keys.md) | 选择、剪贴板与快捷键 | grok | T30 | #30 |
| [T32](T32-arrange-context-menu.md) | 对齐、层级、锁定、成框与右键菜单 | minimax | T30 | #30 |
| [T33](T33-enter-return-navigation.md) | 进入与返回 | grok | T30 | #25 |
| [T34](T34-generic-view.md) | 通用视图：卡片、编辑表单、关系槽 | grok | T30、T26 | #33 |
| [T35](T35-widgets.md) | 表单控件 | minimax | T34 | #33 |
| [T37](T37-shell.md) | 外壳与信息架构 | grok | T30 | #25、#28、#31 |
| [T36](T36-history-panel-v3.md) | 历史面板 v3（一级入口） | minimax | T37 | #26、#27 |
| [T38](T38-appearance.md) | 外观：主题与外观设置 | minimax | T37 | #25 |
| [T39](T39-toolbox-packs.md) | 工具箱与数据包管理 | minimax | T34、T37 | #33、#11 |

T30 之后，T31、T32、T33、T34、T37 可以并行。

### Phase 4：功能组件

| 卡 | 标题 | 执行 | 依赖 | issue |
|---|---|---|---|---|
| [T40](T40-bindings-runtime.md) | 受控绑定运行时 | grok | T34 | #33 |
| [T41](T41-bundle-loading-spike.md) | 技术验证：界面体积预算与按需加载 | grok | T30 | — |
| [T42](T42-text-spike.md) | 技术验证：富文本编辑器 | grok | T41 | #37 |
| [T43](T43-text.md) | 富文本、公式、代码块与对象链接 | grok | T42、T35 | #37 |
| [T44](T44-media.md) | 图片、音视频、文件与链接 | minimax | T41、T35 | #38 |
| [T45](T45-pdf.md) | PDF 查看与页级引用 | grok | T41、T44 | #38、#41 |
| [T46](T46-charts-spike.md) | 技术验证：图表库 | grok | T41 | #39 |
| [T47](T47-table-charts.md) | 可编辑表格与基础图表 | grok | T46、T40、T26 | #39 |
| [T48](T48-data-analysis.md) | 数据分析与联动 | grok | T47 | #39 |
| [T49](T49-relation-graph.md) | 关系图视图 | grok | T40、T41 | #40 |
| [T50](T50-timeline.md) | 时间轴视图 | grok | T40、T26 | #40 |
| [T51](T51-comments.md) | 评论与局部批注 | minimax | T34 | #41 |
| [T52](T52-compare-diff.md) | 并排比较与差异 | minimax | T40 | #41 |
| [T53](T53-anchors.md) | 精确锚点与失效重定位 | grok | T43、T45、T51 | #38、#41 |
| [T54](T54-design-spike.md) | 技术验证：图形、交互原型与白板导出 | grok | T41 | #42 |
| [T55](T55-shapes-prototype.md) | 图形与交互原型 | grok | T54、T35 | #42 |
| [T56](T56-board-export.md) | 白板导出为图片、PDF 和静态网页 | minimax | T54、T37 | #42 |

T41 是所有带新依赖的组件的前提，Phase 3 一开始就可以做。四张技术验证卡（T41、T42、T46、T54）可以先行，不占实现人手。

### Phase 5：情境、规则与扩展

| 卡 | 标题 | 执行 | 依赖 | issue |
|---|---|---|---|---|
| [T60](T60-intersection-context.md) | 交叉情境 | grok | T34、T49 | #35 |
| [T61](T61-time-change-spike.md) | 技术验证：时间、变化、分支与观察者 | grok | T60、T50 | #35、#40 |
| [T62](T62-rules-contract.md) | 规则：契约与运行记录 | grok | T34、T40 | #36 |
| [T63](T63-controls.md) | 输入控件组件 | minimax | T62 | #36 |
| [T66](T66-dsh-device-check.md) | DSH 真机验证 | **项目所有者** | T23 | #18 |
| [T64](T64-rule-execution.md) | 规则执行与宿主接入 | grok | T62、T63、T66 | #36、#18 |
| [T65](T65-rule-reliability.md) | 规则可靠性 | grok | T64 | #36 |
| [T67](T67-sandboxed-views.md) | 二级扩展：沙箱里的自定义视图 | grok | T40、T39、T55 | — |
| [T68](T68-prototype-feedback-to-agent.md) | 原型元素批注交给宿主 Agent 修改 | grok | T53、T55、T64 | #41、#42 |
| [T69](T69-release-acceptance.md) | 发布验收 | **项目所有者** | 每次发布前 | #15 |

T66 只依赖 T23，Phase 2 一结束你就可以做，越早做越好：T64 和 T68 都依赖它的结论。T61 的决策记录合并后，架构负责人再写时间与变化的实现卡。

### 没有写成卡片的部分

以下内容在 issue 里本身就写明“按实际需求再定”，等你真用到时再开卡：#37 的长文排版与混合内容、#40 的日历视图与回放、#25 的工具栏拖动与导航重排、地图与 3D、可执行代码与 notebook、第三方组件市场。

## v2 期间的新问题怎么处理

Phase 1、2 期间你继续用 v2，发现问题照常开 issue（用 `.github/ISSUE_TEMPLATE/bug.md`，写现象、步骤、期望就够）。架构负责人分流：

- **阻塞使用**（丢数据、无法继续操作、白屏）：开 Phase 0 风格的小卡，在 v2 上修。
- **落在将被替换的代码里**（`core/store.ts`、`core/workspace.ts`、`board/SpaceCanvas.tsx` 等）且不阻塞：打标签 `v3-covered`，在对应 v3 卡片的验收里加一条，不在 v2 上修。
- **新需求**：归到 Phase 3 以后的对应卡片；没有对应卡片的，架构负责人新开一张。

## 架构负责人的审查清单

1. 只改了卡片“可改文件”里的文件。
2. 卡片“验收”里的每条都有对应测试或明确的手工核对记录。
3. 没有把测试改松。
4. 没有引入卡片没点名的依赖；版本写死。
5. 命名与 `01-data-model.md` 术语表一致，没有用被禁用的 v2 名词。
6. 错误信息是中文、具体、能指导下一步。
7. PR 描述如实写了没做到的部分。
