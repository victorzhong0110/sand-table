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

## 阶段与任务

所有者要求约 80% 的实现交给 minimax。T15 与 T24 仍由 grok 做。

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

### Phase 2：新工具面与切换

| 卡 | 标题 | 执行 | 依赖 |
|---|---|---|---|
| [T20](T20-tools-v3.md) | v3 工具面（8 个核心 + 界面专用） | minimax | T15、T17 |
| [T21](T21-ui-switch.md) | 界面数据层切到 v3 | minimax | T20 |
| [T22](T22-code-pack.md) | 代码包迁移 | minimax | T20 |
| [T23](T23-research-folder-dsh.md) | 科研包工具、文件夹连接器、DSH 插件迁移 | minimax | T20 |
| [T24](T24-switch-default.md) | 默认切到 v3，删除 v2 内核 | grok | T21、T22、T23，以及你用 `SAND_KERNEL=v3` 实际使用后同意 |

### Phase 3 以后（卡片在前一阶段收尾时编写）

- Phase 3 画布与外壳：React Flow 接入（`04-canvas.md`）、历史面板 v3、外壳翻新（#25）、快捷键与右键菜单（#30）、通用视图——卡片、表单、关系槽（#33）、数据包安装界面。
- Phase 4 功能组件：文字（#37）、媒体（#38）、数据（#39）、时间与关系视图（#40）、批注与比较（#41）、设计作品（#42）。每个组件先做一次技术验证卡，再做实现卡。
- Phase 5：交叉情境（#35）、规则与操作（#36）、二级代码扩展（`03-types-and-extensions.md` §7）、DSH 真机验证（#18）。

## v2 期间的新问题怎么处理

Phase 1、2 期间你继续用 v2，发现问题照常开 issue（用 `.github/ISSUE_TEMPLATE/bug.md`，写现象、步骤、期望就够）。架构负责人分流：

- **阻塞使用**（丢数据、无法继续操作、白屏）：开 Phase 0 风格的小卡，在 v2 上修。
- **落在将被替换的代码里**（`core/store.ts`、`core/workspace.ts`、`board/SpaceCanvas.tsx` 等）且不阻塞：打标签 `v3-covered`，在对应 v3 卡片的验收里加一条，不在 v2 上修。
- **新需求**：归到 Phase 3 以后的对应主线。

## 架构负责人的审查清单

1. 只改了卡片“可改文件”里的文件。
2. 卡片“验收”里的每条都有对应测试或明确的手工核对记录。
3. 没有把测试改松。
4. 没有引入卡片没点名的依赖；版本写死。
5. 命名与 `01-data-model.md` 术语表一致，没有用被禁用的 v2 名词。
6. 错误信息是中文、具体、能指导下一步。
7. PR 描述如实写了没做到的部分。
