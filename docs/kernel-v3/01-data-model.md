# 内核 v3：数据模型

依据：`00-decisions.md` 的 K2、K4。本文的表结构、字段名和规则是实现依据，不要自行增删字段；需要改，先在 PR 里提“需要架构确认”。

## 1. 术语

| 术语 | 英文（代码里用） | 含义 |
|---|---|---|
| 工作空间 | workspace | 一份作品集合，对应一个 `workspace.db` 文件 |
| 对象 | object | 内容的唯一单位，有类型（如 `base.note`、`novel.character`） |
| 白板 | board | 类型声明了 `container` 能力的对象，内部有一块画布 |
| 展示 | presentation | 某个对象在某块白板上的一次摆放：位置、尺寸、外观 |
| 关系 | relation | 两个对象之间的语义连接，类型名来自注册表 |
| 包 | pack | 提供类型、关系词表、模板；内置包还可以注册工具 |
| 意图 | intent | 一组被当成“一步”撤销的写入，用 `intentId` 标识 |
| 修订号 | revision | 工作空间级计数器，每次成功写入加 1 |

v3 代码里**禁止使用**下列 v2 名词：`Space`、`SpaceLink`、`ComponentInstance`、`Board`（指容器时）、`Item`、`Projection`、`placements`、`Workspace`（指 Git 仓库时；v3 里 Git 仓库叫 `repository`）。

v2 → v3 对照：

| v2 | v3 |
|---|---|
| `Board`（会话容器，装着一切） | 工作空间（数据库）本身 |
| `Space`（板内分区，可嵌套） | `base.board` 类型的对象 |
| `ComponentInstance` / `Presentation` | `presentations` 表的一行 |
| 展示的本地内容 `instance.data` | 取消；内容一律在对象里 |
| `contentObjects` | `objects` 表 |
| `spaceLinks` 与 `objectRelations` | `relations` 表（只有一套） |
| `Item`（代码文件、符号） | `code.file`、`code.symbol` 对象 |
| `intents` / `proposals` / `validations` | `code.intent`、`code.proposal`、`code.validation` 对象 |
| `explanations` | `base.note` 对象，`source.origin = "ai-generated"`，用 `base.about` 关系指向被讲解对象 |
| `guides` | `base.tour` 对象 |
| `groups` | `base.frame` 对象 + 子展示的 `parent_id` |
| `assets`（dataUrl 内联） | `blobs` 目录 + `base.media` 对象 |
| `theme` | `settings` 表的 `theme` 键 |
| `componentPacks` | `packs` 表（数据包） |
| `history`（JSON 内时间线） | `history` 表 |
| `audit`（JSON 数组） | `audit` 表 |

## 2. 文件布局

```text
<根目录>/                       默认 ~/.sand-table/workspaces，可由 --workspace-dir 或 SAND_WORKSPACE_DIR 指定
  <工作空间 id>/
    workspace.db                SQLite 数据库（唯一权威）
    workspace.db-wal            SQLite 自动生成
    workspace.db-shm            SQLite 自动生成
    blobs/<sha256>              附件原始字节，文件名是内容的 sha256（小写十六进制）
    workspace.json              v2 旧文件（如果有）。只读，导入后保留不动
```

工作空间 id 规则沿用 v2：`^[a-z0-9][a-z0-9-]{0,62}$`。

## 3. 打开数据库

每次打开连接后依次执行：

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = NORMAL;
```

`workbench/package.json` 里调用 `node` 的脚本加 `--disable-warning=ExperimentalWarning`，避免 `node:sqlite` 的实验性警告混进测试输出。其他启动点出现的这条警告只写到 stderr，不影响功能，不需要改。

## 4. 表结构（当前 schema 版本 2）

`meta` 表的 `schema_version` 记录当前版本。以后改表结构，在 `kernel/schema.ts` 里追加一段迁移，版本号加 1，不修改已发布的建表语句。

```sql
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- 必有的键：
--   schema_version   '2'
--   workspace_id     工作空间 id
--   title            工作空间标题
--   created_at       毫秒时间戳（文本形式）
--   home_board_id    首页白板对象 id
--   revision         当前修订号（文本形式的整数，从 '0' 开始）
--   history_cursor   当前历史游标（history.id），没有历史时为 ''
--   tombstone_floor  最早还保留墓碑的修订号，见 §6
--   imported_from    从 v2 导入时写 'workspace.json@<v2 revision>'，否则不写

CREATE TABLE objects (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,               -- '<包 id>.<类型名>'，如 'base.note'
  type_version INTEGER NOT NULL DEFAULT 1,
  title        TEXT NOT NULL DEFAULT '',
  data         TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data)),
  source       TEXT CHECK (source IS NULL OR json_valid(source)),
  version      INTEGER NOT NULL DEFAULT 1,  -- 每次内容变化加 1，用于冲突检测
  created_at   INTEGER NOT NULL,
  created_by   TEXT NOT NULL,
  updated_at   INTEGER NOT NULL,
  updated_by   TEXT NOT NULL,
  rev          INTEGER NOT NULL,            -- 最后一次变化时的工作空间修订号
  deleted_rev  INTEGER                      -- 软删除：删除时的修订号；NULL 表示存在
);
CREATE INDEX objects_type ON objects(type) WHERE deleted_rev IS NULL;
CREATE INDEX objects_rev  ON objects(rev);

CREATE TABLE presentations (
  id          TEXT PRIMARY KEY,
  board_id    TEXT NOT NULL REFERENCES objects(id),
  object_id   TEXT NOT NULL REFERENCES objects(id),
  parent_id   TEXT REFERENCES presentations(id),   -- 所在框（base.frame 的展示）；NULL 表示直接在白板上
  x           REAL NOT NULL,
  y           REAL NOT NULL,
  width       REAL NOT NULL CHECK (width  > 0),
  height      REAL NOT NULL CHECK (height > 0),
  z           INTEGER NOT NULL DEFAULT 0,
  locked      INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1)),
  appearance  TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(appearance)),
  version     INTEGER NOT NULL DEFAULT 1,
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT NOT NULL,
  rev         INTEGER NOT NULL,
  deleted_rev INTEGER,
  CHECK (board_id <> object_id)
);
CREATE INDEX presentations_board  ON presentations(board_id)  WHERE deleted_rev IS NULL;
CREATE INDEX presentations_object ON presentations(object_id) WHERE deleted_rev IS NULL;
CREATE INDEX presentations_rev    ON presentations(rev);

CREATE TABLE relations (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,                 -- '<包 id>.<关系名>'，如 'base.related'
  source_id   TEXT NOT NULL REFERENCES objects(id),
  target_id   TEXT NOT NULL REFERENCES objects(id),
  status      TEXT NOT NULL CHECK (status IN ('confirmed', 'inferred')),
  basis       TEXT,
  attributes  TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(attributes)),
  evidence    TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence)),
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  created_by  TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT NOT NULL,
  rev         INTEGER NOT NULL,
  deleted_rev INTEGER,
  CHECK (source_id <> target_id)
);
CREATE INDEX relations_source ON relations(source_id) WHERE deleted_rev IS NULL;
CREATE INDEX relations_target ON relations(target_id) WHERE deleted_rev IS NULL;
CREATE INDEX relations_rev    ON relations(rev);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,                    -- 例如 'theme'
  value TEXT NOT NULL CHECK (json_valid(value)),
  rev   INTEGER NOT NULL,
  deleted_rev INTEGER
);

CREATE TABLE packs (
  id       TEXT PRIMARY KEY,                 -- 'base'、'novel'、'my-pack'……
  kind     TEXT NOT NULL CHECK (kind IN ('builtin', 'data')),
  version  INTEGER NOT NULL,
  enabled  INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  manifest TEXT CHECK (manifest IS NULL OR json_valid(manifest)),  -- 数据包存完整清单；内置包为 NULL
  rev      INTEGER NOT NULL,
  deleted_rev INTEGER
);

CREATE TABLE history (
  id         TEXT PRIMARY KEY,
  parent_id  TEXT REFERENCES history(id),    -- 发生在哪条记录之上；NULL 表示起点
  seq        INTEGER NOT NULL UNIQUE,        -- 全局递增序号
  intent_id  TEXT NOT NULL,
  label      TEXT NOT NULL,                  -- 给人看的一句话，如 '移动 3 个组件'
  kind       TEXT NOT NULL,                  -- 'edit' | 'create' | 'delete' | 'move' | 'pack' | 'setting'
  actor      TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'agent')),
  at         INTEGER NOT NULL,               -- 最后一次合并进来的时间
  changes    TEXT NOT NULL CHECK (json_valid(changes)),   -- 见 §7.1
  bytes      INTEGER NOT NULL                -- changes 的字节数，用于容量裁剪
);
CREATE INDEX history_parent ON history(parent_id);

CREATE TABLE audit (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  at           INTEGER NOT NULL,
  actor        TEXT NOT NULL,
  actor_kind   TEXT NOT NULL CHECK (actor_kind IN ('human', 'agent', 'system')),
  action       TEXT NOT NULL,                -- 'apply' | 'undo' | 'redo' | 'jump' | 'import' | 'pack.enable' ……
  history_id   TEXT,                         -- 相关的历史记录
  detail       TEXT CHECK (detail IS NULL OR json_valid(detail))
);

CREATE TABLE activities (
  actor       TEXT PRIMARY KEY,              -- 每个 Agent 只保留最新一条
  state       TEXT NOT NULL CHECK (state IN ('running', 'waiting', 'done', 'unknown')),
  task        TEXT NOT NULL,
  action      TEXT NOT NULL,
  board_id    TEXT,
  object_ids  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(object_ids)),
  reported_at INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);

CREATE TABLE views (
  id         TEXT PRIMARY KEY,               -- 界面会话的视图 id
  board_id   TEXT NOT NULL,
  camera     TEXT NOT NULL CHECK (json_valid(camera)),     -- {x, y, zoom}
  selection  TEXT NOT NULL CHECK (json_valid(selection)),  -- 展示 id 数组
  nav_stack  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(nav_stack)),  -- 进入子白板的路径
  updated_at INTEGER NOT NULL
);

CREATE TABLE agent_reads (
  actor       TEXT PRIMARY KEY,
  history_seq INTEGER NOT NULL,              -- 这个 Agent 上次 sand_context 看到的最大历史序号
  at          INTEGER NOT NULL
);

CREATE TABLE blobs (
  sha256     TEXT PRIMARY KEY,
  mime       TEXT NOT NULL,
  bytes      INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
```

版本1迁移保持不变；版本2追加 ALTER TABLE。设置与包的删除、撤销创建同样更新 rev/deleted_rev；普通读取过滤墓碑，增量返回 deleted: true，恢复清除墓碑。新库执行全部迁移。

## 5. 行类型（TypeScript）

放在 `workbench/kernel/types.ts`。数据库里的 JSON 文本列在读出时解析成对象，`0/1` 转成布尔值。

```ts
export type Actor = { id: string; kind: "human" | "agent" };

export type ExternalLocator = {
  kind: "file" | "git" | "pdf" | "url" | "dataset" | "symbol";
  uri: string;
  fragment?: string; // 页码、行号、符号名、数据范围
  version?: string; // 提交号或版本
  fingerprint?: string; // 内容指纹，用来识别外部内容变化
};

export type ObjectSource = {
  origin: "human" | "imported" | "ai-generated" | "ai-inferred" | "derived";
  basis?: string; // ai-inferred 必填
  external?: ExternalLocator;
};

export type ObjectRow = {
  id: string;
  type: string;
  typeVersion: number;
  title: string;
  data: Record<string, unknown>;
  source: ObjectSource | null;
  version: number;
  createdAt: number;
  createdBy: string;
  updatedAt: number;
  updatedBy: string;
  rev: number;
  deleted: boolean; // deleted_rev !== null
};

export type Appearance = {
  detail?: "full" | "label" | "icon"; // 缺省为 full
  coverBlob?: string; // 封面图的 sha256
  accent?: string; // 局部强调色
};

export type PresentationRow = {
  id: string;
  boardId: string;
  objectId: string;
  parentId: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  locked: boolean;
  appearance: Appearance;
  version: number;
  updatedAt: number;
  updatedBy: string;
  rev: number;
  deleted: boolean;
};

export type RelationRow = {
  id: string;
  kind: string;
  sourceId: string;
  targetId: string;
  status: "confirmed" | "inferred";
  basis: string | null;
  attributes: Record<string, unknown>;
  evidence: ExternalLocator[];
  version: number;
  createdAt: number;
  createdBy: string;
  updatedAt: number;
  updatedBy: string;
  rev: number;
  deleted: boolean;
};
```

`source.origin = "derived"` 表示可以从外部重新算出来的对象（例如代码索引产生的 `code.file`）。这类对象的写入**不进历史**（见 §7.4）。

## 6. 修订号与增量同步

- `meta.revision` 是工作空间级计数器。`applyCommands` 每次成功提交，修订号加 1；这次改到的每一行，`rev` 都写成新修订号。
- 删除一律软删除：`deleted_rev` 写成当前修订号，`rev` 也更新。读接口默认过滤掉已删除的行。
- 界面不再整板轮询。它记住自己看到的修订号 N，每秒问一次当前修订号；变了就取 `rev > N` 的所有行（含墓碑），合并进本地状态。
- 墓碑保留：软删除超过 10,000 个修订号的行可以物理删除，同时把 `meta.tombstone_floor` 提高到对应修订号。客户端请求的 N 小于 `tombstone_floor` 时，返回 `{ reset: true }`，客户端重新全量读取当前白板。

## 7. 历史

### 7.1 一条历史记录的 `changes`

```ts
type Snapshot = Record<string, unknown> | null; // 该行除 rev / deleted_rev 外的全部字段，外加 alive: boolean；null 表示这一行在当时还不存在

type Change = {
  table: "objects" | "presentations" | "relations" | "settings" | "packs";
  id: string; // settings 用 key，packs 用包 id
  before: Snapshot;
  after: Snapshot;
};
```

`changes` 是 `Change[]`，顺序就是写入顺序。

### 7.2 记录与合并

- 新记录的 `parent_id` 是当前游标，写入后游标指向新记录。游标之后原来的记录不删除，成为旧分支，仍然可以跳回去。
- 合并条件（全部满足才合并进游标所在记录，否则新建一条）：
  1. `intentId` 与游标记录相同；
  2. 游标记录没有子记录；
  3. `actor` 相同；
  4. 距游标记录的 `at` 不超过 15 分钟。
- 合并时，同一实体保留最早的 `before` 和最新的 `after`；`after` 与 `before` 内容完全相同的实体从 `changes` 里去掉；`changes` 变空时删除这条记录，游标回到它的父记录。

### 7.3 撤销、重做、跳转

- **撤销**：对游标记录的 `changes` 倒序应用 `before`，游标移到 `parent_id`。
- **重做**：游标的子记录里，取 `seq` 最大的一条，按顺序应用 `after`，游标移到这条。
- **跳转**到任意记录：找到游标和目标的最近公共祖先，先沿游标一路撤销到公共祖先，再沿路径一路重做到目标。中途任何一步失败，整个跳转回滚。
- 应用快照时：
  - 快照为 `null` → 软删除这一行；
  - 快照 `alive: false` → 软删除这一行；
  - 其他 → 写回快照里的字段，并清除删除标记。
  - 不论哪种，`version` 都在当前值上加 1，`rev` 写新修订号。
- **冲突检查**：撤销前，比较每个实体当前的内容和这条记录的 `after`；重做前，比较当前内容和 `before`。比较时忽略 `version`、`rev`、`updated_at`、`updated_by`。不一致就拒绝，返回错误码 `HISTORY_CONFLICT` 和不一致的实体 id，不做任何修改。
- 撤销、重做、跳转本身不新建历史记录；它们修改数据（修订号加 1），并各写一条审计（`action` 为 `undo` / `redo` / `jump`）。

### 7.4 不进历史的写入

- `source.origin = "derived"` 的对象，以及只涉及这些对象的展示和关系。
- `applyCommands` 带 `record: false` 的写入（只有包初始化和代码索引能用，工具层不暴露）。
- v2 导入器的写入（它在 `kernel/` 内部直接写行，见 §10）。
- `views`、`activities`、`agent_reads` 表。

### 7.5 容量

- 上限：2,000 条记录，或 `bytes` 合计 64 MB，先到为准。
- 超过时反复执行：删除 `seq` 最小、`parent_id` 为 NULL 且不是游标的记录，把它的子记录的 `parent_id` 置为 NULL。直到不超限。
- 审计保留最近 20,000 条，超过时删除最旧的。审计记录本身永不修改。

## 8. 删除语义

- **移除展示**（`presentation.delete`）：只软删除这一个展示。
- **删除对象**（`object.delete`）：同一事务里软删除这个对象、它的全部展示、所有以它为起点或终点的关系。全部记在同一条历史里，一次撤销全部恢复。
- 删除一块白板对象时，它内部的展示随之删除，但那些展示指向的对象不删除。

## 9. 不变量

| 编号 | 规则 | 在哪里保证 |
|---|---|---|
| V1 | 对象、展示、关系的 id 全局唯一且永不复用 | 主键 + `crypto.randomUUID()` |
| V2 | 每个展示都绑定一个对象，且所在白板是 `container` 类型 | `NOT NULL` 外键 + `applyCommands` 检查 |
| V3 | 白板不能直接或间接展示在自己内部 | `applyCommands` 用递归查询检查，违反返回 `CYCLE` |
| V4 | 关系类型、对象类型必须在注册表里且所属包已启用 | `applyCommands` 检查，违反返回 `UNKNOWN_TYPE` |
| V5 | 对象数据必须通过类型的 JSON Schema 校验 | Ajv，违反返回 `INVALID_DATA` 和字段路径 |
| V6 | 带 `expectedVersion` 的写入，版本不符就拒绝 | `applyCommands`，返回 `VERSION_CONFLICT` 和当前版本 |
| V7 | 一次 `applyCommands` 全部成功或全部失败 | 单个 `BEGIN IMMEDIATE` 事务 |
| V8 | 所有写入只经过 `applyCommands`（唯一例外：`kernel/legacy/import-v2.ts`） | 架构测试：`kernel/` 以外不得出现 SQL 写语句 |
| V9 | 撤销栈只包含白板内容；外部效果（发布、运行、写文件）不进历史 | 外部效果不走 `applyCommands`；代码包的写文件流程只写 `code.*` 对象的状态字段 |
| V10 | 推测关系（`inferred`）必须有 `basis` | `applyCommands` 检查 |
| V11 | 停用的包，其对象和关系保留，可读不可改数据 | `applyCommands` 检查；读接口照常返回并标 `typeAvailable: false` |
| V12 | 数据库不可读或迁移失败时明确报错，不当成空工作空间 | `kernel/db.ts` 打开流程 |

## 10. 从 v2 导入

触发：打开工作空间时 `workspace.db` 不存在而 `workspace.json` 存在。导入在一个事务里完成，失败则删除半成品 `workspace.db` 并报错，旧文件不动。

映射规则：

| v2 数据 | v3 结果 |
|---|---|
| `objects[]`（原生内容对象） | `objects`，id 不变；类型按 §10.1 改名 |
| `boards[0].spaces[]` | 每个空间一个 `base.board` 对象，id 不变；根空间 `overview` 成为首页白板 |
| `presentations[]` 绑定了对象的 | `presentations`，`board_id` = 原 `spaceId`，id 不变 |
| `presentations[]` 带本地内容的（未绑定） | 先用本地 `type/title/data` 建一个对象，再建展示指向它 |
| `presentations[]` 类型为 `board` / `space-link` 的 | 展示指向 `data.spaceId` 对应的白板对象 |
| `presentations[]` 代码投影（`objectId` 指向代码条目） | 建 `code.file` 或 `code.symbol` 占位对象，id 保持原代码条目 id，`source.origin = "derived"`；代码包下次刷新时按同一 id 更新 |
| `spaceLinks[]` | `relations`，两端是展示所绑定的对象；`related`→`base.related`，`depends-on`→`base.depends_on`，`supports`→`base.supports`，`compares`→`base.compares`，`belongs-to`→`base.belongs_to`；`description` 存进 `basis` |
| `relations[]`（v2 对象关系） | `relations`，`kind` 按 §10.1 改名 |
| `groups[]` | 每个组一个 `base.frame` 对象 + 一个包住组内展示的框展示，组内展示的 `parent_id` 指向它 |
| `notes{}` | 每条备注一个 `base.note` 对象，放在目标旁边，并建 `base.about` 关系 |
| `assets[]` | 字节写入 `blobs/`，每个附件一个 `base.media` 对象 |
| `intents` / `proposals` / `validations` | `code.intent` / `code.proposal` / `code.validation` 对象，原数据放进 `data`；超过 1 MB 的基线文件内容写入 `blobs/` 并以 sha256 引用 |
| `guides[]` | `base.tour` 对象（`purpose` 取原 `purpose`）；每一步的每个 `objectIds` 建一条 `base.tour_stop` 关系，`attributes = { order: 步序号, title, explanation }`；没有对象的步骤存进 `data.legacySteps` |
| `theme` | `settings.theme` |
| `componentPacks[]` | `packs`（`kind = 'data'`），清单按 `03-types-and-extensions.md` §6 转换 |
| `audit[]` | `audit`，`action` 原样保留 |
| `history`（v2 时间线） | **不导入**。导入完成后写一条审计 `import`，界面提示“升级前的撤销记录未保留” |

### 10.1 类型改名

| v2 类型 | v3 类型 |
|---|---|
| `text` | `base.note`（`text` 字段改名为 `body`） |
| `heading` | `base.heading` |
| `resource` | `base.link`（有 `url` 时）或 `base.media`（引用附件时） |
| `code` | `base.code_snippet` |
| `metric` / `status` / `chart` / `table` / `events` / `task` / `reasoning` / `comparison` | `base.<同名>`（`events` → `base.events`） |
| `character` / `event` / `chapter` | `novel.<同名>` |
| `hypothesis` / `evidence` / `conclusion` | `research.<同名>` |
| 其他未知类型 | 原样加前缀 `legacy.`，数据保留，界面用通用降级视图显示 |

导入时不按新 Schema 拒绝旧数据，原值保存。字段改名必须保留原意，旧值未知不能静默删除：

- 0、空字符串、空数组和未知字段全部保留；无法证明某个 0 是旧占位时，只报告供用户检查。
- 文本 participants 名单保留原文（可附 legacyParticipants），名字匹配只产生迁移建议。重复同名/未匹配分别报告，不自动创建 confirmed 关系。原始稳定 ID 关系可以保留；人工确认后再将名单转为关系。
- 不迁移旧撤销历史的决定不变，但原 workspace.json 保留。不能将升级成功当作允许丢正文、值、关联或附件。

之后仅对本次编辑字段严格校验，其他遗留问题作为警告，不阻止保存。
