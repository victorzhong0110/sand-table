# 清空 open issue 的执行计划（2026-10-20）

目标：把 #6 / #7 / #9 / #10 全部解决并关闭。每一条都必须有**可验证的落点**（代码 + 测试 + issue 里的解决说明），没有根因的缺陷不许靠"看起来对"结案。

分工按**文件不重叠**切分，避免并行写冲突：

| 包 | 范围 | 文件（独占） | 对应验收项 |
|---|---|---|---|
| S（主线） | 撤销/重做 + 读回路径 | `core/history.ts`(新)、`core/store.ts`、`core/results.ts`、`server/spaces.ts`、`server/server.ts`、`board/main.tsx`、`board/Icon.tsx`、`board/HistoryPanel.tsx`(新)、`board/history.css`(新)、`tests/history.test.ts`(新) | #9.5、#6-B、#10 回归断言 |
| L | 本机接入体验 | `local/client.ts`、`local/session.ts`、`local/bridge.ts`、`local/service.ts`、`local/main.ts` | #6-A、#6-C、#6-D |
| B | 画布交互 | `board/SpaceCanvas.tsx`、`board/ComponentPanel.tsx`、`board/CanvasShell.tsx`、`board/style.css` | #9.1 ~ #9.4 |
| C | 组件包协议 | `core/packs.ts`(新)、`core/pack-fetch.ts`(新)、`core/model.ts`、`server/packs.ts`(新)、`board/Toolbox.tsx`、`board/packs.css`(新)、`tests/packs.test.ts`(新) | 新需求：组件包导入协议 |

## #9 画布交互（五条）

1. **边缘平移默认关闭** — `CanvasShell.tsx:35` `useState(true)` → `false`；设置里的开关与速度项保留。
2. **选中即可拖动** — 拖动不再要求 `mode === "arrange"`。
   契约：拖动被固定的组件时，客户端把 `rect.pinned` 置为 `false` 一并提交（服务端 `place` 已有"pinned 且坐标变化就报错"的校验，客户端先解锁即可通过，**服务端不需要改**）；界面上要提示"移动已解除固定"。
3. **就地编辑** — 双击组件进入编辑态；按组件类型编辑正文（text/heading/code/…）或标题；Enter 提交、Esc 取消、blur 提交。
4. **改完即存** — 属性栏内容字段：停止输入 600ms 自动提交、失焦提交、Esc 取消；「保存组件」保留作兜底；提交失败要有可见反馈。
   契约：每次自动保存发一个 `update` op（服务端负责把"同一实例的连续更新"合并成**一步**历史，见 #9.5）。
5. **Word 式回退** — 见下。

## #9.5 Word 式撤销/重做（核心包 S）

**语义（按 issue 第 5、6 条定稿）**

- 撤销**不是弹栈**，而是往同一条历史里**再压一条"撤销了 X"的记录**，每条记录自带正/逆操作。
- 没有"Agent 回退"特权类别：人和 Agent 的写操作进同一条历史，步数按**一次用户意图**计（连续拖动 = 一步、连续输入 = 一步、Agent 一批同意图的调用 = 一步）。
- 回退只回退白板内容，**不绕过"人确认"那道闸**（不触碰 intent/proposal/文件）。

**实现要点：内容状态链 + 游标**

- 内容域（instances / spaces / spaceLinks / groups / placements / packs / theme）每一步存一份完整状态；选中/相机/导航属于视图状态，不进历史。
- 历史挂在 `BoardStore.histories`（独立 Map，不进 Board 模型，不随每次 `store.read()` 膨胀到浏览器）。
- **游标模型**：`steps` 是追加式的写入链，游标指向当前所在的那一步；`flips` 是撤销/重做/跳转的记录（各自带作者与标签）。
  - `Cmd+Z` 游标往回走一步，`Cmd+Shift+Z` 往回走一步（重做）；每一次移动都**压一条记录**进 `flips`，所以撤销本身也在历史面板里、也带作者、也能再被翻回去。
  - **为什么不是"翻转最后一条记录"**：那样连按两次 `Cmd+Z` 会互相抵消，**多次编辑就无法连续撤销**——而 issue 第 1 条要求 `Cmd+Z` 覆盖全部写操作。issue 第 6 条那句"撤销之后再按 `Cmd+Z`，被撤掉的会回来"在本实现里对应的是 `Cmd+Shift+Z`（或历史面板里点那一条）。**这是与 issue 字面表述的一处已知分歧，写在 PR 评论与 issue 结案说明里。**
  - 合并规则：同一条 `intent` token 的连续写入合并成**一步**（保留最早的 before、取最新的 after）。
  - 在被撤销的区域里发生新写入时，游标之后的那几步作废（否则一次撤销会复活已经被放弃的编辑）。
- 对外：`Cmd+Z` / `Cmd+Shift+Z`（Windows 为 Ctrl）；MCP 侧 `sand_undo` / `sand_redo` / `sand_history` / `sand_undo_to`；`sand_edit_space` 增加 `kind:"undo"|"redo"`。
- 历史面板：合并列出 `steps` 与 `flips`（按发生顺序），标出当前位置，可点任意一条"跳到这一步"。

## #6 MCP 接入体验（问题 A/B/C/D）

- **A 凭据自愈** — 接受 `?session=<token>` 作为片段的等价入口；片段/参数都缺失时，页面自动向本机服务取一次凭据（同源 + Origin 校验不放宽），拿到后继续；页面给可点击的恢复入口。
- **B 读回路径唯一** — `sand_read_board` 增 `instanceCount`；`sand_find_objects` 覆盖 space instances（能按标题/type 查到已建组件）；写类工具返回新建实例的 id 与标题。
- **C 错误信息指对方向** — 区分"会话文件读不到"与"读到但请求被拒（token 过期/端口变了）"，错误里带会话文件路径。
- **D 启动不抢浏览器** — 默认不自动打开系统浏览器；输出里给完整链接并说明如何显式打开。`--open` 显式开启保留。

## #10 缩放条「放大」按钮消失

- 现状：当前构建复现不出（PR #5 与 main/PR#4 构建、宽度 600–1512 × 高度 400–900 全档扫描、连点/动画中点击均不复现，`+` 始终在 DOM 且可点）。
- 处理：**加一条回归断言**（测试里断言缩放条 5 个控件在任何视口下都可见可点），把"可见性"锁死成可执行事实；issue 关闭时写明"未复现 + 已加断言锁死"，**不谎称已修**。

## #7 试用体验记录

- 性质是过程记录（documentation）。处理：把过程与踩坑整理进 `workbench/docs/MCP-TRIAL-NOTES.md`（可长期查阅），issue 关闭并指向文档。
- 顺带落地的文档改动：面板写明"装一次就够（前提是 `--session-file` 同一份）""可能需要重开宿主会话""浏览器与 MCP 客户端共享同一张板与 revision 计数"；`connection.json` 增 `link` 字段（**可直接粘贴的完整链接**，`url` 仍不含凭据）；README / QUICKSTART 增「接入与排错」清单，并改成"默认不打开浏览器，用 `--open` 打开"。

## 组件包导入协议（新增需求，非 issue）

- 规范：`workbench/docs/COMPONENT-PACK-PROTOCOL.md`。
- 地基：`docs/DEVELOPMENT_PLAN.zh-CN.md` §5.4「组件类型声明（内部）」与那句"自定义分为配置、组合、代码扩展……未知组件显示可理解的占位与说明，不静默丢弃"，以及 `board/ComponentRenderer.tsx:413-420` 已有的未知类型占位分支。
- 边界：组件包 = **数据**。只引用组件类型 + 预填数据（走既有 `checkData` / `safeUrl` 校验），**不引入渲染器、不写文件、不改源码**；类型未知时保留数据并占位展示 + 一条警告。
- 入口：左侧栏「组件」页（粘贴 JSON / https 链接）＋ MCP 工具 `sand_import_component_pack` / `sand_remove_component_pack` / `sand_export_component_pack` / `sand_list_component_packs`。
- 取件安全：https-only、拒绝回环/私有网段/链路本地、逐跳重校验、5 秒超时、256 KB 上限、JSON Content-Type（`core/pack-fetch.ts`）。
- 导入/移除是白板内容变更 → 进历史、可撤销。

## 验证口径

- 每个包：`npm run typecheck` + `npm run build` 通过；受影响的既有测试（`test:blank`、`test:browser`、`test:local`、`npm test`）通过；新增断言要实跑并留下输出。
- 合并后跑全量，CI 绿，再逐个 issue 写解决说明并关闭。
- **合并的时机与顺序不由这份计划决定。** 早先这里写的「不合并 PR（合并权在 Vic）」是上一版工作方式的遗留写法，现在只保留事实：PR #12 叠在 #5 之上（base 是 `feat/quiet-settings`，所以 diff 只含本次改动），它与新架构方向（#11）的文件重叠面见 `workbench/docs/ARCHITECTURE-HANDOVER.md`。**什么时候合、先合哪个，由新架构那一侧判断**；本仓库这边不代为合并，也不把顺序写成硬性要求。
