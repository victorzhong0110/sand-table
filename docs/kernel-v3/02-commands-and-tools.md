# 内核 v3：统一写入与 MCP 工具

依据：`00-decisions.md` 的 K3、K6。表结构见 `01-data-model.md`。

## 1. 统一写入：`applyCommands`

位置：`workbench/kernel/commands.ts`，由 `workbench/kernel/index.ts` 导出。界面、MCP 工具、包、导入器的所有写入都调用它。

### 1.1 类型

```ts
export type CommandBatch = {
  actor: Actor; // 见 01-data-model.md §5
  intentId?: string; // 相同 intentId 的连续写入合并成一步撤销；缺省时自动生成
  label?: string; // 历史里显示的一句话；缺省时按 §1.4 自动生成
  commands: Command[]; // 1 到 200 条
  record?: boolean; // 默认 true。false 表示不进历史，只允许包初始化和代码索引（derived 对象）使用，工具层不得暴露
};

// 字段值里的字符串 "@名字" 表示引用本批次前面某条命令用 ref: "名字" 创建的实体 id。
export type Command =
  | { op: "object.create"; ref?: string; type: string; title?: string; data?: Record<string, unknown>; source?: ObjectSource }
  | { op: "object.update"; id: string; expectedVersion?: number; title?: string; set?: Record<string, unknown>; unset?: string[]; source?: ObjectSource }
  | { op: "object.delete"; id: string; expectedVersion?: number }
  | { op: "object.clone"; ref?: string; id: string } // 复制出独立对象（新 id，不复制展示和关系）。数据先迁到当前类型版本再落盘；迁移失败则整条拒绝，不写出半新的副本
  | {
      op: "presentation.create";
      ref?: string;
      boardId: string;
      objectId: string;
      x?: number; // 缺省时由内核放在白板当前内容右侧的空位
      y?: number;
      width?: number; // 缺省用类型的 display.defaultSize
      height?: number;
      parentId?: string;
      appearance?: Appearance;
    }
  | { op: "presentation.update"; id: string; x?: number; y?: number; width?: number; height?: number; z?: number; locked?: boolean; parentId?: string | null; appearance?: Appearance }
  | { op: "presentation.delete"; id: string }
  | {
      op: "relation.create";
      ref?: string;
      kind: string;
      sourceId: string;
      targetId: string;
      status?: "confirmed" | "inferred"; // 缺省 confirmed
      basis?: string;
      attributes?: Record<string, unknown>;
      evidence?: ExternalLocator[];
    }
  | { op: "relation.update"; id: string; expectedVersion?: number; status?: "confirmed" | "inferred"; basis?: string | null; attributes?: Record<string, unknown>; evidence?: ExternalLocator[] }
  | { op: "relation.delete"; id: string }
  | { op: "setting.set"; key: string; value: unknown }
  | { op: "pack.enable"; id: string }
  | { op: "pack.disable"; id: string }
  | { op: "pack.import"; manifest: Record<string, unknown> } // 数据包，见 03 文档 §6
  | { op: "pack.remove"; id: string } // 只能移除数据包
  | { op: "template.apply"; templateId: string; boardId: string; x?: number; y?: number };

export type CommandResult = {
  revision: number;
  historyId: string | null; // 不进历史时为 null
  created: Record<string, string>; // ref（没有 ref 时用命令下标字符串）→ 新 id
  changed: { table: string; id: string; version: number }[];
  warnings: { commandIndex: number; message: string; path?: string }[];
};

export class CommandError extends Error {
  code: ErrorCode;
  commandIndex: number | null;
  details?: Record<string, unknown>;
}
```

`applyCommands(db, registry, batch): CommandResult`，失败时抛 `CommandError`，数据库里什么都没变。

内容导入例外之一是 v2 导入器（`kernel/legacy/import-v2.ts`）：它需要保留旧 id 和时间戳，所以在 `kernel/` 内部直接写行，不经过 `applyCommands`，也不做 Schema 校验（见 `01-data-model.md` §10）。T25 的 `kernel/bundle.ts` 也可在尚未发布的新临时库中恢复内容行，须按 `05-delivery-contracts.md` §3 全量校验并原子发布。在线内容不能走这两个入口。运行状态专用内核接口只可修改其对应表，不写内容表。

### 1.2 处理顺序

1. `BEGIN IMMEDIATE`。
2. 读出当前修订号 R，新修订号为 R + 1。
3. 按顺序处理每条命令：把 `"@名字"` 换成真实 id → 校验（§1.3）→ 写入 → 记下 `Change`（before/after 快照）。
4. 全部成功后：写 `meta.revision = R + 1`；`record !== false` 且有需要记录的变化时，按 `01-data-model.md` §7.2 新建或合并历史记录，更新 `meta.history_cursor`；写一条审计 `apply`；执行历史和审计的容量裁剪。
5. `COMMIT`。任何一步出错就 `ROLLBACK` 并抛出 `CommandError`。

### 1.3 校验

| 情况 | 规则 | 错误码 |
|---|---|---|
| 类型不存在或所属包未启用 | 拒绝创建；拒绝修改数据（可以改标题） | `UNKNOWN_TYPE` |
| `object.create` 的数据 | 必须完整通过类型的 JSON Schema | `INVALID_DATA` |
| `object.update` 的数据 | 先迁到当前类型版本，再把 `set` / `unset` 合并进去做整体校验。迁移失败则拒绝改数据（信息里带原因），只改标题时保留旧 `data` / `type_version`。迁成之后，错误路径属于本次 `set` / `unset` 的键时报错；其余错误（旧数据遗留问题）放进 `warnings`，不阻止保存 | `INVALID_DATA` |
| 数据序列化后超过 1 MB | 拒绝 | `LIMIT` |
| 标题超过 300 字 | 拒绝 | `LIMIT` |
| 带 `expectedVersion` 且与当前版本不同 | 拒绝，`details` 里给出当前版本 | `VERSION_CONFLICT` |
| id 不存在或已删除 | 拒绝 | `NOT_FOUND` |
| 展示所在白板的类型没有 `container` 能力 | 拒绝 | `NOT_CONTAINER` |
| 展示会让白板出现在自己内部（含间接） | 拒绝 | `CYCLE` |
| 修改 `locked` 为真的展示的位置或尺寸，且同一批次里没有先解锁 | 拒绝 | `LOCKED` |
| 关系类型 allowsInferred 为 false，创建或更新后的状态为 inferred | 拒绝 | `INVALID_DATA` |
| 关系的 `status = inferred` 但没有 `basis` | 拒绝 | `INVALID_DATA` |
| 关系类型声明了 `requiresBasis` 但没有 `basis` | 拒绝 | `INVALID_DATA` |
| 关系类型声明了 `sourceTypes` / `targetTypes`，两端类型不符 | 拒绝 | `INVALID_DATA` |
| `pack.remove` 的目标是内置包 | 拒绝 | `FORBIDDEN` |
| `pack.disable` 的目标是 `base` | 拒绝 | `FORBIDDEN` |
| 批次为空或超过 200 条 | 拒绝 | `LIMIT` |

错误码全集：`UNKNOWN_TYPE`、`INVALID_DATA`、`LIMIT`、`VERSION_CONFLICT`、`NOT_FOUND`、`NOT_CONTAINER`、`CYCLE`、`LOCKED`、`FORBIDDEN`、`HISTORY_CONFLICT`、`INTERNAL`。

`INVALID_DATA` 的 `details` 必须带 Ajv 的错误路径和中文说明，例如 `{ path: "/age", message: "必须是非负整数" }`。

### 1.4 自动生成的历史标签

调用方没给 `label` 时，按批次里的命令生成（标题用「」括起，超过 20 字截断加…）：

| 批次内容 | 标签 |
|---|---|
| 只有 1 条 `object.create`（可带展示） | 新建「标题」 |
| 只有 `presentation.update` 且只改位置 | 移动 N 个组件（N = 1 时：移动「标题」） |
| 只有 `presentation.update` 且改了尺寸 | 调整「标题」的大小 |
| 只有 `object.update` 一个对象 | 修改「标题」 |
| `object.delete` | 删除「标题」（多个时：删除 N 个对象） |
| `presentation.delete` | 移除 N 个展示 |
| `relation.create` | 连接「源」→「目标」 |
| `setting.set` 的 `theme` | 修改外观 |
| `pack.*` | 启用 / 停用 / 导入 / 移除组件包「包名」 |
| 其他组合 | 编辑 N 处 |

### 1.5 受信任内核命令

公共 Command 不接受任意 ID 或内置包初始化。T13 另实现 `applySystemCommands(db, registry, batch)`，与 applyCommands 复用同一个私有事务/校验/修订/审计实现：

- `pack.sync_builtin { id, version, enabledByDefault }`：核实注册表同 ID/version 的 builtin；不存在才插入，已有行保留 enabled；拒绝覆盖同 ID 数据包。
- `object.upsert_derived { packId, id, type, title, data, source }`：只允许 derived 来源和内置包的 ID 命名空间策略；已存在必须为同包 derived，不覆盖人工内容；创建/刷新保留稳定 ID，仍校验 Schema。
- 两者不进撤销历史，但更新修订号与审计。命名空间策略为 PackSpec.derivedIdPrefix，由 Registry.getPack(packId) 读取，校验规则见03的派生身份策略。内核不硬编码领域前缀。
- MCP、UI、模板和数据包解析器只接受公共 Command，拒绝这两个内部 op；不能由调用者伪造 actor 获得权限。
- `@ref` / `$board` 只在实体引用槽 id/boardId/objectId/parentId/sourceId/targetId 解析；正文、URL、代码和其他用户数据不扫描替换，`@alice` 保持原文。

## 2. 读接口

位置：`workbench/kernel/read.ts`。都是纯查询，不写库（`context` 例外，它会更新 `agent_reads`）。

| 函数 | 作用 |
|---|---|
| `status(db)` | 工作空间 id、标题、修订号、首页白板、白板列表（最多 50）、包列表 |
| `listTypes(db, filter?)` | 已启用包的类型、关系类型、模板；带过滤时返回完整声明 |
| `query(db, registry, filter)` | 按白板、类型、文字、关系查对象，分页，返回精简行。摘要和 `typeVersion` 用迁移后的数据；失败时带 `migrationError` |
| `readObjects(db, registry, ids, options)` | 读完整对象，附带展示位置和关系。`data` 与 `typeVersion` 是迁到当前类型版本后的结果；失败时带 `migrationError`，库里的行不变 |
| `boardContents(db, registry, boardId)` | 同一只读事务快照中的白板、展示、对象、关系、有效 settings/packs 及 revision。白板和对象的 `data` / `typeVersion` 同样是迁移后的结果，失败时带 `migrationError` |
| `changesSince(db, registry, rev)` | 修订号大于 rev 的所有行（含墓碑），或 `{ reset: true }`。对象行的 `data` / `typeVersion` 是迁移后的结果，失败时带 `migrationError` |
| `historyList(db, limit)` | 历史记录列表，标出当前位置、当前路径、旧分支 |
| `context(db, actor, viewId?)` | 人当前在看什么、选中了什么、该 Agent 上次读取之后人做了哪些修改 |

boardContents 和 changesSince 的 revision 必须与返回内容来自同一只读事务，避免多进程写入期间跳过更新。删除/撤销创建 settings/packs 必须返回墓碑；普通全量读取只返回有效行。

## 3. MCP 工具

### 3.1 约定

- 工具实现只做三件事：解析参数 → 调用 `kernel` 的读接口或 `applyCommands` → 把结果整理成精简输出。不在工具层写业务规则。
- 给模型的输出（`content` 文本）是精简 JSON，通常不超过 4 KB；**永远不把整块白板返回给模型**。界面需要的完整数据放在 `_meta.data`（沿用 v2 `server/server.ts` 的做法）。
- 出错时返回 `isError: true`，文本为 `{"code": "...", "message": "...", "hint": "..."}`。`hint` 告诉模型下一步该做什么，例如 `VERSION_CONFLICT` 的 hint 是 “Call sand_read to get the current version, then retry.”。
- 调用者身份：模型可见工具的 `actor = { id: <MCP clientInfo.name，取不到时为 "agent">, kind: "agent" }`；界面专用工具的 `actor = { id: "human", kind: "human" }`。
- 只有 `sand_status` 带 MCP Apps 的 UI 资源（`_meta.ui.resourceUri`），宿主支持 MCP Apps 时调用它就会显示白板。其余模型可见工具不带。
- 界面专用工具用 `visibility: ["app"]` 注册（v2 `server/server.ts` 里 `tool()` 的 `appOnly` 参数已经支持）。
- 工具描述用英文，按下文原样使用，不要自行扩写。

### 3.2 模型可见的 8 个核心工具

#### `sand_status`

描述：`Show the current Sand Table workspace: boards, enabled packs and revision. Call this first. Opens the board UI in hosts that support MCP Apps.`

参数：无。

输出：

```json
{
  "workspace": { "id": "novel-1", "title": "我的小说", "revision": 128 },
  "homeBoardId": "…",
  "boards": [{ "id": "…", "title": "人物", "presentations": 12 }],
  "packs": [{ "id": "novel", "title": "小说", "enabled": true }],
  "host": { "taskSubmit": false },
  "tips": [
    "Call sand_types before creating objects of a type you have not used.",
    "Call sand_context to see what the person is looking at."
  ],
  "frameCoords": { "state": "ok", "count": 0, "message": "…" }
}
```

`frameCoords` 是框内坐标的体检结论（`state` 是 `ok` 或 `needs-review`）。
`needs-review` 表示库里有说不准是相对还是绝对的框内坐标——数据没被动过，但要人来确认。
这时同一条提示也会出现在 `tips` 里：人和模型一调 `sand_status` 就看得见。

#### `sand_types`

描述：`List object types, relation kinds and templates. Pass types to get the full JSON Schema and relation slots of specific types before creating or editing them.`

参数：`{ types?: string[] (≤20), pack?: string }`

输出：不带参数时只给精简列表 `{ types: [{type, title, description, pack, container, icon, capabilities, presets}], relationKinds: [{kind, title, inverseTitle, allowsInferred, requiresBasis, sourceTypes?, targetTypes?}], templates: [{id, title, pack}] }`；带 `types` 时给这些类型的完整声明（见 `03-types-and-extensions.md` §2）。关系种类声明了端点类型时，精简列表带上 `sourceTypes` / `targetTypes`，没有限制的不出现这两项。

精简项里的 `icon` 是内置图标名，`capabilities` 是 `{container?, cover?}`（没声明的键不出现），`presets` 是这个类型在工具箱里的预填条目 `{key, title, width?, height?, data?}`——工具箱画按钮要用的就是这三样。

#### `sand_query`

描述：`Find objects by board, type, text or relation. Returns short rows with ids; use sand_read for full content.`

参数：

```ts
{
  boardId?: string;          // 只要展示在这块白板上的对象
  types?: string[];          // ≤20
  text?: string;             // 在标题和数据的文字里查找，不区分大小写
  relatedTo?: { id: string; kind?: string; direction?: "out" | "in" | "both" };
  order?: "updated" | "title"; // 缺省 updated（最近修改在前）
  limit?: number;            // 缺省 20，最大 50
  cursor?: string;           // 上一页返回的 nextCursor
}
```

输出：`{ rows: [{id, type, title, summary, version, updatedAt, typeVersion, typeAvailable, migrationError?}], nextCursor: string | null, total: number }`。`summary` 取类型 `display.summary` 的第一个有值字段，用迁移后的数据，去掉 Markdown 标记后截取 160 字。`typeVersion` 是数据结构版本，不是对象的编辑版本 `version`。迁移失败时带 `migrationError`，`typeVersion` 仍是库里的旧版本。

#### `sand_read`

描述：`Read full objects by id, including where they are placed and how they relate to other objects. Long text fields are cut; use textOffset to read more.`

参数：

```ts
{
  ids: string[];             // 1 到 20
  include?: ("presentations" | "relations")[]; // 缺省两者都要
  textLimit?: number;        // 每个文字字段最多返回的字数，缺省 8000，最大 20000
  textOffset?: { id: string; field: string; offset: number };
}
```

输出：`{ objects: [{ id, type, title, data, source, version, typeVersion, typeAvailable, migrationError?, truncated: [{field, totalLength}], presentations: [{id, boardId, boardTitle}], relations: [{id, kind, direction, otherId, otherTitle, status, basis}] }], missing: string[] }`。`data` 和 `typeVersion` 是迁到当前类型版本后的结果；迁移失败时这两项保持库里的原文，并带 `migrationError`。`typeVersion` 不是编辑版本 `version`。读不写库。每个对象最多返回 50 条关系。

#### `sand_edit`

描述：`Create, change, place, relate or delete objects in one atomic batch. Every batch is one undo step. Check sand_types for the data schema first. Use "@name" to refer to an object created earlier in the same batch via ref: "name".`

参数：`{ intentId?: string, label?: string, commands: Command[] }`（`Command` 见 §1.1；`record` 不暴露）。

输出：`{ revision, historyId, created, changed, warnings }`。

示例（AI 新建一个人物并放到人物白板上）：

```json
{
  "commands": [
    { "op": "object.create", "ref": "lin", "type": "novel.character", "title": "林舟", "data": { "role": "主角" } },
    { "op": "presentation.create", "boardId": "<人物白板 id>", "objectId": "@lin" }
  ]
}
```

#### `sand_history`

描述：`List, undo, redo or jump in the board history. Undo and redo move one step along the current path; jump goes to any recorded step, including old branches.`

参数：`{ action: "list" | "undo" | "redo" | "jump", entryId?: string, limit?: number }`（`jump` 必须给 `entryId`；`list` 的 `limit` 缺省 20，最大 100）。

输出：`list` 返回 `{ cursorId, entries: [{id, parentId, seq, label, actorKind, at, current, onCurrentPath}] }`；其余返回 `{ revision, cursorId }`。

#### `sand_context`

描述：`See what the person is looking at now: the open board, the selection, and what they changed since you last called this.`

参数：`{ viewId?: string }`（缺省取最近更新的视图）。

输出：

```json
{
  "board": { "id": "…", "title": "第五章" },
  "selection": [{ "presentationId": "…", "objectId": "…", "type": "novel.character", "title": "林舟" }],
  "recentHumanEdits": [{ "label": "修改「林舟」", "at": 1761100000000, "objectIds": ["…"] }],
  "otherAgents": [{ "actor": "codex", "state": "running", "task": "检查第五章时间线" }],
  "revision": 131
}
```

`recentHumanEdits` 是该 Agent 上次调用之后、`actor_kind = 'human'` 的历史记录，最多 20 条。调用后更新 `agent_reads`。

#### `sand_activity`

描述：`Tell the person what you are working on and which objects you are looking at. This is shown on the board; it never moves the person's view.`

参数：`{ state: "running" | "waiting" | "done" | "unknown", task: string (≤300), action: string (≤200), objectIds?: string[] (≤30), boardId?: string }`

输出：`{ ok: true }`。同一 Agent 只保留最新一条；10 分钟后过期，`done` 状态 2 分钟后过期。

### 3.3 领域包工具（只在包启用时注册）

| 包 | 工具 | 动作 | 来源 |
|---|---|---|---|
| code | `code_repo` | `import`（导入本机仓库）、`refresh`（重新索引）、`read_source`（读源码片段） | v2 `connectors/git.ts`、`domains/code/index.ts` |
| code | `code_change` | `create_intent`、`read_intents`、`read_target`、`publish_proposal`、`read_proposal`、`prepare_apply`、`read_approved_file`、`verify`、`report_validation` | v2 `server/changes.ts`，参数语义不变，id 改为对象 id |
| research | `research_pdf` | `read`、`import_evidence`、`verify_citation` | v2 `domains/research/tools.ts` |
| （文件夹连接器） | `folder_read` | 读取已绑定文件夹 | v2 `connectors/tools.ts` 的 `sand_read_folder`；只在绑定了文件夹时注册 |

`code_change` 里**没有**批准提案的动作。批准只能由人在界面上做，见 §3.4 的 `code_decide`。

### 3.4 界面专用工具（`visibility: ["app"]`，模型看不见）

| 工具 | 参数要点 | 作用 |
|---|---|---|
| `app_board` | `{ boardId }` | 返回 `boardContents` 的完整结果（对象数据是迁移后的投影），给画布渲染 |
| `app_changes` | `{ since }` | 返回 `changesSince`（对象数据是迁移后的投影），界面每秒调用一次 |
| `app_edit` | 同 `sand_edit` | 人的写入，`actor` 为 human |
| `app_history` | 同 `sand_history` | 人的撤销、重做、跳转 |
| `app_view` | `{ action: "get" \| "select" \| "camera" \| "navigate", viewId, boardId?, ... }` | 视角、选区、进入或返回白板；不进历史。`get` 返回 `navStack`；`select` 与 `camera` 也接受 `boardId`，第一次调用就能登记视角，不用先 `navigate` 一次 |
| `app_asset` | `{ action: "upload", name, mime, base64 }` / `{ action: "read", sha256 }` | 上传返回 sha256；建 `base.media` 对象由界面再调 `app_edit` |
| `app_workspace` | `{ action: "list" \| "create" \| "switch" \| "rename" \| "delete" \| "export" \| "import", ... }` | 管理工作空间。`export`、`import` 由 T25 实现，T20 只做前五个 |
| `app_pack` | `{ action: "export", id }` | 导出数据包；导入走 `app_edit` 的 `pack.import` |
| `app_activity` | `{ action: "list", limit? }` | 列出还没过期的活动，至多 100 条，带 `truncated` 标记。**只读：不推进 `agent_reads`**，界面读活动不会挪走 Agent 的读取游标 |
| `code_decide` | `{ proposalId, decision: "approve" \| "reject", digest }` | 代码包注册；人批准或拒绝提案 |

#### 读接口怎么认过期结果

界面每一秒都在拉数据，切换工作空间时旧请求可能晚回来。读接口的返回值都带 `workspaceId`（这次读的是哪个工作空间）和 `revision`（读到的是第几代）。界面按「工作空间编号 + 自己发的请求代号 + 修订号」三样一起判：三样对不上就丢掉这次结果，不合进当前白板。

`app_board` 和 `app_changes` 还接受一个可选的 `workspaceId` 参数：请求里带的编号和当前打开的不一样时直接报错，不给数据——旧工作空间的增量不会混进新库。

### 3.5 工具数量规则

- 只启用 `base` 时：模型可见工具**正好 8 个**。
- 每个启用的领域包最多增加 2 个模型可见工具；文件夹连接器 1 个。
- 新工作空间默认启用 `base`、`novel`、`research`，`code` 在第一次导入仓库时启用。所以默认情况下模型看到 9 个工具（8 + `research_pdf`）。
- 包在运行中启用或停用时，它的工具随之启用或停用，客户端会收到工具列表变化的通知。
- 别的进程改了包的启停，这一边也要跟着改：服务端每秒读一次 `packs` 表的修订号，变了才刷新工具句柄；服务退出时收掉计时器。
- 这些数字由架构测试强制（见 `tasks/T16-architecture-tests.md`）。

## 4. 旧工具 → 新工具

| v2 工具 | v3 |
|---|---|
| `sand_open_board` | 删除。工作空间启动时打开；`sand_status` 显示白板 |
| `sand_list_boards` | `sand_status` |
| `sand_read_board` | 模型：`sand_status` + `sand_query`；界面：`app_board` |
| `sand_refresh_board` | `code_repo` `refresh` |
| `sand_find_objects` | `sand_query` |
| `sand_list_objects` | `sand_query` |
| `sand_read_object` | `sand_read` |
| `sand_read_component` | `sand_read` |
| `sand_read_spaces` | 模型：`sand_query { boardId }`；界面：`app_board` |
| `sand_workspace_status` | `sand_status` |
| `sand_read_arrangement` | `sand_context` |
| `sand_read_context` | `sand_context` |
| `sand_read_source` | `code_repo` `read_source` |
| `sand_focus` | `sand_activity`（只显示 Agent 在看哪里，不移动人的视角） |
| `sand_report_activity` | `sand_activity` |
| `sand_report_space_activity` | `sand_activity` |
| `sand_explain` | `sand_edit`：建 `base.note`（`source.origin = "ai-generated"`）+ `base.about` 关系 |
| `sand_publish_guide` | `sand_edit`：建 `base.tour` |
| `sand_edit_view` | `app_view` |
| `sand_open_view` | `app_view` |
| `sand_end_board` | 删除（不再有会话级白板） |
| `sand_edit_space` | 内容操作 → `sand_edit` / `app_edit`；`select` / `camera` / `navigate` → `app_view`；`undo` / `redo` → `sand_history` / `app_history` |
| `sand_rename_board` | `sand_edit`：`object.update` 白板对象的 `title` |
| `sand_history` | `sand_history` `list` |
| `sand_undo` | `sand_history` `undo` |
| `sand_redo` | `sand_history` `redo` |
| `sand_undo_to` | `sand_history` `jump` |
| `sand_attach_asset` | `app_asset` `upload` |
| `sand_read_asset` | `app_asset` `read` |
| `sand_import_component_pack` | `sand_edit` / `app_edit`：`pack.import` |
| `sand_remove_component_pack` | `sand_edit` / `app_edit`：`pack.remove` |
| `sand_export_component_pack` | `app_pack` `export` |
| `sand_list_component_packs` | `sand_status`（包列表）+ `sand_types` |
| `sand_import_repository` | `code_repo` `import` |
| `sand_create_intent` | `code_change` `create_intent` |
| `sand_read_intents` | `code_change` `read_intents` |
| `sand_read_intent_arrangement` | `code_change` `read_intents`（结果里包含相关布局） |
| `sand_read_target` | `code_change` `read_target` |
| `sand_publish_proposal` | `code_change` `publish_proposal` |
| `sand_read_proposal` | `code_change` `read_proposal` |
| `sand_decide_proposal` | `code_decide`（界面专用，只有人能批准） |
| `sand_prepare_apply` | `code_change` `prepare_apply` |
| `sand_read_approved_file` | `code_change` `read_approved_file` |
| `sand_verify_proposal` | `code_change` `verify` |
| `sand_report_validation` | `code_change` `report_validation` |
| `sand_read_folder` | `folder_read` |
| `sand_read_pdf` | `research_pdf` `read` |
| `sand_import_pdf_evidence` | `research_pdf` `import_evidence` |
| `sand_verify_pdf_citation` | `research_pdf` `verify_citation` |
| `sand_list_workspaces` | `app_workspace` `list` |
| `sand_create_workspace` | `app_workspace` `create` |
| `sand_switch_workspace` | `app_workspace` `switch` |
| `sand_rename_workspace` | `app_workspace` `rename` |
| `sand_delete_workspace` | `app_workspace` `delete` |

DSH 插件（`workbench/dsh-plugin/`）的 4 个工具改为转调 `sand_status`、`sand_query`、`sand_read`、`sand_edit`，在切换阶段一并修改。

## 后续阶段契约补充

新增评论/引用、运行、时间/分支/观察者及组件接口的正式约束见 [05-delivery-contracts.md](05-delivery-contracts.md)。各责任卡实现时同步本文件的具体类型/表/工具签名；不能仅根据旧的基础清单拒绝已经授权的扩展。
