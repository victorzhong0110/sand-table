# 集成契约：#5 + #12 + #16 + #19 合成一个可用版本

> issue #20 的实现规格。本文件是本轮集成的**共同规格**：
> 生产者按这里的 API 与语义写代码；冲突裁决按这里的决策，不各写各的。
> 术语沿用 `docs/architecture/workspace-kernel.zh-CN.md`（内核契约）与 `core/objects.ts`（共享类型）。

---

## 1. 集成基线

| 来源 | PR | 头提交 | 成果 |
|---|---|---|---|
| #5 | 集中设置、悬浮导航、精简文案、镜头 | `d18688e` | 交互基线（设置/导航/镜头/材质） |
| #12 | #6–#10 结案、就地编辑/自动保存/历史交互、组件包协议 | `debf887` | 交互与接入基线（叠在 #5 上） |
| #16 | 持久化、对象与展示分离、通用内核 | `8833770` | **架构基线**（本轮主干） |
| #19 | 折叠标题溢出、改名不同步、缩放条层级 | `120fcd4` | 新架构下的根因修复 |

集成分支：`feat/integration-2026-10`，主干取 **#16**，再并入 #5+#12（`debf887` 一次带入两者），
最后应用 #19。

**冲突裁决总原则**：同一处语义只能有一份权威实现。
冲突时以「新对象模型 + 新历史模型」为准（#16），把 #5/#12 的**交互与连接体验**移植到新模型上，
而不是把旧模型搬回来。

---

## 2. 决策

### D1 历史模型：只保留一套，以新内核的意图分组模型为准

**为什么不用 #12 的「游标 + 整态快照」模型**（这一条要写清楚，避免以后又有人把旧实现搬回来）：

| 维度 | #12：游标 + 整态快照 | 采用：意图分组 + 实体快照 |
|---|---|---|
| 一次撤销单位 | 游标移动一格，粒度是「一步写入」 | 按 `intentId` 合并，粒度是「一个用户意图」 |
| 快照内容 | 整块白板内容（instances/spaces/links/groups/placements/packs/theme） | 只快照被改的实体（object / presentation / relation / board 键） |
| 与对象/展示分离的关系 | **不兼容**：整态快照会把实例上残留的旧内容一起抓回来，等于把「内容在对象」这个前提推翻 | 兼容：内容改动落在对象快照，布局改动落在展示快照 |
| 撤销的副作用 | 一次撤销会把并发的其他修改一起回退（因为快照是整块的） | 只回退被改的实体/键，别人的并发修改保留 |
| 记录历史的成本 | 每次写入克隆整块白板内容（2200 个实例的板很贵） | 只克隆被改的实体 |
| 审计与导航 | 撤销本身是一条记录（flips），混在同一列表里 | 撤销栈与审计日志分开：撤销进审计，不占撤销栈位置 |
| 跳转语义 | 游标可以直接跳到任意下标 | 需要显式实现 `jumpTo`，且双栈插入顺序必须按时间序算 |

关键的一句话：**#12 的模型不是「更简单的实现」，而是「更弱的模型」**——
它能撤销，但撤销的粒度和副作用都更粗，而且和这一轮定下的对象/展示分离不兼容。
保留 #12 的是**行为契约**（撤销/重做不震荡、面板可见可跳转、人与 Agent 同等对待、
审计与导航分开），不是它的实现。

- **采用** #16 的 `core/history.ts`（`History` 类：按 `intentId` 合并的撤销栈 + 重做栈 + 独立审计日志）。
- **弃用** #12 的游标 + 整态快照模型（`steps/flips/cursor`、`captureState` 抓整块白板内容）。
  理由：它与「内容在对象、实例只管展示」不兼容——整态快照会把实例上的旧内容一起抓回来。
- **但保留 #12 已约定的行为**（这是验收口径，不是实现细节）：
  1. 连续 Undo 逐个撤回更早的编辑，Redo 恢复已撤销的编辑，不来回震荡；
  2. 审计日志与 Undo/Redo 导航分开；
  3. 人与 Agent 同等对待，按意图分组；
  4. 历史面板可见、可跳转到某条记录；
  5. 外部源码写入、提案确认等不得由白板撤销冒充回滚。

### D2 补丁目标补一个板级实体，覆盖旧模型可撤销的板级内容

旧模型一次抓取 `instances / spaces / links / groups / placements / packs / theme`，
新模型只覆盖 `object / presentation / relation`——**嵌套白板、组件包导入/移除、主题操作会静默失去撤销能力**，
这是功能倒退，必须补。

**形状**（显式，不复用对象快照，避免「board 快照被兜底分支写成语义关系」那类歧义）：

```ts
// core/objects.ts
export type BoardStateKey =
  | "spaces"
  | "spaceLinks"
  | "groups"
  | "placements"
  | "componentPacks"
  | "theme";

export type EntitySnapshot = {
  target: "object" | "presentation" | "relation" | "board";
  /** board 时为 BoardStateKey，其余为实体 id。 */
  id: string;
  /** board 时为该键的完整值；null 表示删除该键。 */
  value: unknown;
};
```

- 板级快照按**键**记录，不抓整块白板：撤销一次组件包导入不会连带回滚并发发生的主题修改。
- `core/store.ts` 的 `applySnapshot` 增加 `board` 分支：写入 `b[key]`（`value === null` 时删键）。
- 板级内容与展示实例的变更可以落在**同一次意图**里（合并成 batch），
  例如一次拖动同时改 `instances[i].rect` 与 `placements[objectId]`。

### D3 校验入口唯一：`core/spaces.ts` 的 `checkComponentData(type, data)`

- 编辑、MCP 写入、组件包导入**共用这一个实现**。
- 删除 `server/spaces.ts` 里的私有 `checkData`（`server/core` 各留一份必然漂移）。
- 错误信息必须**可读且带路径**，例如：
  `items[1].done 应为 boolean` 而不是 `Checklist values are invalid.`。

### D4 标题真相统一：内容在对象，展示处一律解析

- 所有展示入口（展开卡片、折叠标题、`aria-label`、悬浮提示、属性栏、搜索）都从同一处取值：
  `peekContent(instance, board.contentObjects)`（只读渲染用 `peekContent`，需要可改副本时用 `resolveContent`）。
- 改名后**不同步** `instance.title`：它只是未绑定时的降级值。
- 提供共享助手，避免每个展示点各写一遍解析：

```ts
// core/content.ts
export function displayTitle(c: ComponentInstance, objects: WorkspaceObject[]): string;
```

- **#19 漏掉的两处必须补**：`board/ComponentPanel.tsx` 的
  「选中的展示实例」列表标题与「移动 X 到白板」aria-label。

### D5 自动保存：600ms 防抖 → 走对象写入口，字段级合并

- 停止输入约 600ms、或失焦时提交；失败**保留草稿**并明确提示。
- **只提交实际修改的字段**：客户端带 `baseData`（它编辑时看到的基线）与 `data`（改后的整体）；
  服务端逐字段比较 `baseData[k] !== data[k]` 得到改动集，
  对每个改动字段检查当前值是否仍等于 `baseData[k]`——
  不等则该字段**并发冲突**，报错并指出字段名，**不换新 revision 盲目重放陈旧值**。
  未改动的字段保留当前值（别人的并发修改不被覆盖）。
- 没有 `baseData` 时退化为整份替换（兼容旧调用方与 MCP）。
- 一次编辑会话内的连续保存算**一个**意图（`intentId`），不能被 600ms 防抖拆成一堆历史步骤。
- 拖动同样是一个意图：布局归 `presentation` 快照，内容归 `object` 快照。

### D6 组件包：协议保留，产物进对象模型

- 协议本身（`core/packs.ts`、`core/pack-fetch.ts`、取件边界与 SSRF 校验）**原样保留**。
- 导入的包是白板级内容（`componentPacks`）→ 按 D2 以板级快照记录，**可撤销、可持久化**。
- 「使用预设」创建的是**原生内容对象 + 绑定展示实例**，不是带内联 `data` 的实例。
- 未知类型降级、警告展示、导入提示保留。

### D7 AI 交互入口按真实能力显示

- **能发送任务并接收响应**（宿主提供了 MCP App 桥接）→ 保留直接对话入口，并显示响应。
- **只有 MCP**（没有桥接）→ **不显示**对话输入框，也**不做「复制提示词冒充交给 AI」的兜底**；
  改为显示接入状态与外部对话路径说明（去你的 AI 客户端用沙盘工具），
  并保留「Agent 在哪里」的活动视图。
- 判据：`app`（AppBridge）存在 = 宿主模式；不存在 = 仅 MCP 模式。

### D8 「复制展示」与「复制出独立对象」是两件事

沿用 #16 的语义，不合并：
- 「再放一份」= 同一对象在当前白板新增展示（内容共享、布局独立）；
- 「复制出独立对象」= 内容深拷贝、新对象 id，此后互不影响。

---

## 3. 本轮要改动的 API（生产者按此写）

### core/history.ts

```ts
/** 面板与接口用的历史记录（不含补丁负载）。 */
export type HistoryRecord = {
  id: string;
  label: string;
  at: number;
  author: string;
  authorKind: "human" | "agent";
  kind: "edit" | "undo" | "redo";
  intentId: string;
};

export type HistorySnapshot = {
  boardId: string;
  /** 新到旧。撤销栈在前，重做栈在后（已撤销、待重做）。 */
  records: HistoryRecord[];
  canUndo: boolean;
  canRedo: boolean;
  note: string;
};
```

`History` 类新增：

```ts
/** 跳到某条记录：它在撤销栈就撤销它之后的全部编辑；它在重做栈就重做到它。 */
jumpTo(entryId: string): { undone: HistoryEntry[]; redone: HistoryEntry[] } | undefined;
```

### core/store.ts

```ts
/** 记录板级内容的变化（嵌套白板、关系、分组、布局锚点、组件包、主题）。 */
recordBoardState(
  b: Board,
  key: BoardStateKey,
  before: unknown,
  after: unknown,
  author: string,
  intentId: string,
  kind: string,
  label: string,
): void;

/** 记录一批展示实例的变化（拖动、复制、移除、折叠档位）。 */
recordPresentations(
  b: Board,
  changes: { id: string; before: ComponentInstance | null; after: ComponentInstance | null }[],
  author: string,
  intentId: string,
  kind: string,
  label: string,
): void;

/** 面板与 MCP 用的历史快照。 */
history(id: string): HistorySnapshot;

/** 跳到某条历史记录。 */
jumpTo(id: string, recordId: string, author: string): { board: Board };
```

### server/spaces.ts

- `update` 操作新增可选字段：
  - `baseData?: Record<string, unknown>`：客户端编辑时的基线（用于字段级合并与冲突判定）；
  - `expectedVersion?: number`：对象版本，不匹配时拒绝写入。
- `intent` 一律改叫 `intentId`（新模型的概念；#12 的 `edit-session.ts` 产出的
  `edit:<id>:<token>` / `move:<id>:<token>` 本身就是 intentId）。
- 冲突错误形如：`字段 items[1].done 已被其他修改改动，请重新载入后再试。`

### server/server.ts（MCP 工具面）

- 保留 `sand_undo` / `sand_redo`。
- 新增 `sand_history`（返回 `HistorySnapshot`）与 `sand_undo_to`（`recordId`，跳到某条记录）。
- 组件包工具沿用 #12 的四个：`sand_import_component_pack` / `sand_remove_component_pack` /
  `sand_export_component_pack` / `sand_list_component_packs`。

---

## 4. 文件归属（并行开发期间不得越界）

| 归属 | 文件 | 内容 |
|---|---|---|
| 负责人 | `core/objects.ts` `core/history.ts` `core/store.ts` `core/content.ts` `core/spaces.ts` `core/packs.ts` `core/pack-fetch.ts` `server/spaces.ts` `server/server.ts` `server/packs.ts` `board/CanvasShell.tsx` `board/SpaceCanvas.tsx` `board/ComponentRenderer.tsx` `board/main.tsx` | 内核、接线、主干 UI |
| A | `board/HistoryPanel.tsx` `board/history.css` | 历史面板接到新 `HistorySnapshot` |
| B | `board/edit-session.ts` `board/ComponentPanel.tsx` `board/style.css`（仅编辑相关样式） | 自动保存 + 就地编辑 + 属性栏标题统一 |
| C | `core/packs.ts` `core/pack-fetch.ts` `server/packs.ts` `tests/packs.test.ts` `docs/COMPONENT-PACK-PROTOCOL.md` | 组件包进对象模型 |

**共享文件只有一处权威**：谁都不许改 `core/objects.ts` 的既有类型（要加就找负责人）。

---

## 5. 验收场景归属（issue #20 §7）

| 组 | 场景 | 负责 |
|---|---|---|
| A 旧体验不回退 | 默认空板、设置/导航/材质三档、平滑聚焦、边缘平移默认关闭、就地编辑、自动保存、快捷键 | 负责人 + B |
| B #10/#17 专项 | 长标题 ellipsis、几何量测、按钮在卡内、改名后各态同源、拖卡片盖缩放条后命中 | 负责人 |
| C 交互 × 新内核 | 同对象两处展示、改名/移动分离、一次意图一次撤销、移除展示不删对象、删对象与引用、组件包导入→编辑→撤销→重启、人机交错改不同字段、保存重开、保存失败可见 | 负责人（集成测试） |
| D 自动检查与真人任务 | 类型检查、构建、核心/历史/存储/包测试、浏览器测试、启动冒烟 | 负责人 |

---

## 6. 已知取舍

- 板级内容（嵌套白板、分组、主题、组件包）按**键**粒度撤销，不是整块白板快照：
  代价是同一键上的并发修改会被一起回退，可接受；收益是撤销不会误伤别的键。
- 「撤销到某条」只支持跳到撤销栈或重做栈里的记录，不支持跨栈一次跳到任意时刻。
- 多工作空间管理器仍未做；本轮只保证「保存 / 重开」入口真实可用。
- 并发写没有文件锁（单机单进程可接受）。

---

## 7. 怎么跑起来、怎么验收

**唯一可验收的版本**：本分支 `feat/integration-2026-10` 的最终提交（合入 main 后以 main 为准）。
不要在 #5、#12、#16、#19 四个分支之间拼装——它们各自都不完整。

### 本地启动

```bash
cd workbench
npm ci
npm run build            # 产出 dist/
node dist/local/main.js  # 本地工作台（浏览器打开它给出的地址）
```

- 工作空间默认在 `~/.sand-table/workspaces/default`；换目录用 `--workspace-dir`，
  换工作空间用 `--workspace-id`（**命令行参数**，不要用环境变量：
  MCP 的 stdio 子进程只继承白名单环境变量，自定义变量到不了子进程）。
- 白板**落盘**：关掉再开，恢复的是同一块白板（id 不变），不是新开一张空板。

### 连上你的 AI

- 只有 MCP：白板通过 MCP 工具（`sand_*`）暴露给 AI 客户端。AI 在你那边说话，
  它在这里读写；界面上的「AI」页签只显示接入状态与外部对话路径，
  **不显示**一个发不出去的消息框，也不再做「复制提示词冒充交给 AI」的兜底。
- 宿主提供 MCP App 桥接时，界面才出现直接对话入口（能发能收才算）。

### 一次完整的人机协作

1. 空白启动 → 拖一个组件 → 双击就地编辑 → 停止输入约 600ms 自动保存。
2. 同一个对象「再放一份」到另一块白板 → 改内容，两边一起变；移动/折叠只影响当前这一张。
3. 撤销/重做：一次连续输入算一步；工具箱「历史」页签可看可跳。
4. 关掉重开：内容、关系、嵌套白板、展示与历史都还在。
5. 让 AI 用 MCP 改一处 → 读回确认；人与 AI 改**不同字段**不互相覆盖，
   改**同一字段**会明确报冲突。

### 本轮的已知限制

- 多工作空间管理器没做（只能靠 `--workspace-id` 切换）。
- 并发写没有文件锁：同一个工作空间不要同时开两个进程写。
- 「撤销到某条」只支持跳到撤销栈或重做栈里的记录。
- 领域包（#13）、小说/科研纵向验证（#14）、DSH 宿主集成（#18）不在本轮。
