# 内核 v3：类型契约与扩展

依据：`00-decisions.md` 的 K1、K5、K9。对应 issue #33。

一句话：**每个类型用一份声明说清楚它的数据长什么样、怎么显示、怎么编辑、能和谁建立什么关系。** 内核、界面、AI 都只看这份声明，不在别处猜字段形状。

## 1. 命名

- 包 id：`^[a-z][a-z0-9-]{1,40}$`，例如 `base`、`novel`、`my-reading-kit`。不允许点号。
- 类型名、关系名：`<包 id>.<名字>`，名字为 `^[a-z][a-z0-9_]{0,40}$`，例如 `novel.character`、`base.depends_on`。
- 一个包只能声明以自己 id 为前缀的类型和关系。

## 2. 类型声明 `TypeSpec`

位置：`workbench/kernel/types.ts`。内置包用 TypeScript 对象写；数据包用同样结构的 JSON（不能含函数）。

```ts
export type TypeSpec = {
  type: string; // 'novel.character'
  title: string; // 中文显示名：'人物'
  description: string; // 一句话，给人和 AI 看：'小说中的一个人物及其基本设定'
  icon: string; // 内置图标名，见 board/Icon.tsx
  version: number; // 数据结构版本，从 1 开始
  schema: JsonSchema; // data 的 JSON Schema，见 §3
  capabilities?: {
    container?: boolean; // 可以进入：它是一块白板，内部可以摆放展示
    cover?: boolean; // 可以设置封面图
  };
  display: {
    material: "paper" | "document" | "screen" | "gauge" | "container" | "media";
    defaultSize: { width: number; height: number };
    summary?: string[]; // 卡片上按顺序显示的字段；缺失的字段不显示
    view?: string; // 自定义视图名，只有内置包能用；缺省用通用视图（§5）
  };
  relationSlots?: RelationSlot[]; // 见 §4
  migrations?: { from: number; migrate: (data: Record<string, unknown>) => Record<string, unknown> }[]; // 只有内置包能用；何时执行见 T26
};

export type RelationKindSpec = {
  kind: string; // 'novel.participates'
  title: string; // '参与'
  inverseTitle: string; // '参与者'（从目标方向看时的名字）
  allowsInferred: boolean;
  requiresBasis?: boolean; // 必须写依据，例如“支持 / 反驳”
  sourceTypes?: string[]; // 限定起点类型；缺省不限
  targetTypes?: string[]; // 限定终点类型；缺省不限
};

export type TemplateSpec = {
  id: string; // '<包 id>.<名字>'
  title: string;
  description?: string;
  commands: Command[]; // 一段命令；用 "@名字" 互相引用；"$board" 会被替换成目标白板 id
};

export type PackSpec = {
  derivedIdPrefix?: string; // 仅内置包，如 code:；数据包禁止
  id: string;
  title: string;
  version: number;
  description?: string;
  types?: TypeSpec[];
  relationKinds?: RelationKindSpec[];
  templates?: TemplateSpec[];
  presets?: PresetSpec[]; // 工具箱里的预填条目，见 §6
  registerTools?: (server: ToolRegistrar) => void; // 只有内置包能用；最多 2 个模型可见工具
};
```

注册表：`workbench/kernel/registry.ts`。启动时注册内置包；数据包从 `packs` 表读出后注册。注册时先用元 Schema 校验 `PackSpec` 本身，不合格就拒绝并给出具体原因。

## 3. 数据 Schema 规则

使用 JSON Schema 2020-12 的子集，由 Ajv 校验（`new Ajv2020({ strict: true, allErrors: true })`，并把下表的 `x-sand-*` 注册为注解关键字）。

### 3.1 必须遵守

1. 顶层是 `{"type": "object", "properties": {...}, "additionalProperties": false}`。
2. **内容字段不写 `default`。** 没填就是字段不存在。只有配置类枚举可以有默认值（例如图表的 `kind`），写在 `x-sand-default` 里，由界面在新建时填入，校验器不使用它。
3. **不在数据里存其他对象的 id。** 指向对象的语义一律用关系槽（§4）。正文允许 `sand://object/<编码后的 id>` 导航链接；链接是文字内容，不是关系槽，不产生 `base.mentions` 或其他持久关系。UI 与 AI 均只写正文，目标不存在时原文保留并显示失效。见 `05-delivery-contracts.md` §2。
4. 能用 `required` 的地方慎用：创作草稿允许缺项。只把“没有它这个对象就没有意义”的字段设为必填（例如人物的 `name` 也**不**必填，标题已经承担名字的作用）。
5. 数字字段写明 `type: "number"` 或 `"integer"`，需要时加 `minimum`；不要用字符串存数字。
6. 长文本用 `{"type": "string", "x-sand-widget": "markdown"}`，存 Markdown。

### 3.2 界面提示关键字

| 关键字 | 取值 | 含义 |
|---|---|---|
| `x-sand-label` | 字符串 | 字段显示名 |
| `x-sand-widget` | `text`、`longtext`、`markdown`、`number`、`integer`、`boolean`、`enum`、`tags`、`date`、`url`、`color`、`locator`、`blob`、`table`、`list` | 编辑控件和显示方式 |
| `x-sand-placeholder` | 字符串 | 输入框占位提示（只是提示，不是值） |
| `x-sand-unit` | 字符串 | 数字单位，例如“岁”“字” |
| `x-sand-enum-labels` | 对象 | 枚举值 → 中文显示名 |
| `x-sand-default` | 任意 | 新建时界面预填的配置值 |
| `x-sand-hidden` | 布尔 | 不在卡片和表单里显示（例如内部状态） |

`locator` 控件对应 `ExternalLocator`（见 `01-data-model.md` §5），`blob` 控件存附件的 sha256。

### 3.3 例子：`novel.character`

```ts
{
  type: "novel.character",
  title: "人物",
  description: "小说中的一个人物及其基本设定",
  icon: "user",
  version: 1,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      role: { type: "string", maxLength: 60, "x-sand-label": "定位", "x-sand-widget": "text", "x-sand-placeholder": "主角、配角……" },
      age: { type: "integer", minimum: 0, maximum: 10000, "x-sand-label": "年龄", "x-sand-widget": "integer", "x-sand-unit": "岁" },
      traits: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 40 }, "x-sand-label": "性格", "x-sand-widget": "tags" },
      goal: { type: "string", maxLength: 200, "x-sand-label": "动机", "x-sand-widget": "text" },
      arc: { type: "string", maxLength: 20000, "x-sand-label": "人物弧光", "x-sand-widget": "markdown" }
    }
  },
  capabilities: { container: true, cover: true },
  display: { material: "paper", defaultSize: { width: 260, height: 180 }, summary: ["role", "age", "goal"] },
  relationSlots: [
    { key: "events", label: "参与的事件", kind: "novel.participates", direction: "in", targetTypes: ["novel.event"], many: true }
  ]
}
```

注意：v2 的 `name` 字段取消（用对象标题），`age: 0` 占位取消，人物声明了 `container`（双击进入人物档案白板）。

## 4. 关系槽

关系槽让“参与者”“支持的证据”这类指向其他对象的信息，像字段一样显示和编辑，但**存储是关系**。

```ts
export type RelationSlot = {
  key: string; // 槽名，界面和 AI 用来指代
  label: string; // 中文显示名
  kind: string; // 关系类型
  direction: "out" | "in"; // out：本对象是起点；in：本对象是终点
  targetTypes?: string[]; // 另一端允许的类型
  many: boolean; // 能否连多个
};
```

- 界面在卡片和表单里把槽显示成“标签列表”，点 × 删除关系，点 + 选择对象建立关系。
- AI 通过 `sand_edit` 的 `relation.create` / `relation.delete` 操作，不存在“写字段”这条路。
- `sand_types` 返回类型声明时带上关系槽，AI 因此知道“人物的参与事件是关系 `novel.participates` 的反向”。

## 5. 视图

### 5.1 通用视图（所有类型默认）

- **卡片**：标题 + `display.summary` 里有值的字段（按控件格式化）+ 关系槽的标签。缺失字段不显示，绝不显示占位值。
- **编辑表单**：按 Schema 的 `properties` 顺序生成控件；关系槽排在后面。
- **其他字段**：数据里有、Schema 里没有的字段（旧数据、停用包遗留），只读显示在表单底部“其他字段”里，不丢弃。
- **未知类型**（包停用或缺失）：显示标题、类型名和“此类型来自未启用的包「x」”，数据只读。

### 5.2 自定义视图（只有内置包）

签名固定如下，将来第三方视图在沙箱里用同一套数据（§7）：

```ts
export type ViewProps = {
  object: ObjectRow;
  spec: TypeSpec;
  presentation: PresentationRow;
  detail: "full" | "label" | "icon";
  readOnly: boolean;
  dispatch: (commands: Command[], options?: { intentId?: string }) => Promise<CommandResult>;
};
```

自定义视图通过 dispatch 只更新自身对象；跨对象用户操作由 05 §4 的外壳动作服务处理，通过下述受控绑定读取关联数据，不能直接调用工具、SQL 或任意网络。

## 6. 数据包（一级扩展）

数据包是一个 JSON 文件，取代 v2 的组件包协议。

```json
{
  "format": "sand-table-pack",
  "formatVersion": 2,
  "id": "reading-kit",
  "title": "读书笔记包",
  "version": 1,
  "description": "摘录、观点与书目",
  "types": [
    {
      "type": "reading-kit.quote",
      "title": "摘录",
      "description": "书里的一段原文",
      "icon": "quote",
      "version": 1,
      "schema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "text": { "type": "string", "maxLength": 5000, "x-sand-label": "原文", "x-sand-widget": "markdown" },
          "page": { "type": "integer", "minimum": 1, "x-sand-label": "页码", "x-sand-widget": "integer" }
        }
      },
      "display": { "material": "paper", "defaultSize": { "width": 280, "height": 160 }, "summary": ["text", "page"] }
    }
  ],
  "relationKinds": [
    { "kind": "reading-kit.quotes_from", "title": "摘自", "inverseTitle": "摘录", "allowsInferred": false }
  ],
  "presets": [
    { "key": "question", "type": "base.note", "title": "我的疑问", "data": { "body": "这一章没讲清楚的是……" } }
  ]
}
```

规则：

- 只能包含数据，不能有 `view`、`migrations`、`registerTools`。
- `types` 里每个类型的 `schema` 必须满足 §3.1，`display.view` 必须缺省。
- 升级同 id 的数据包时，新 Schema 必须能接受旧数据（只能加可选字段、放宽限制）；做不到就换一个类型名。
- 导入、启用、停用、移除都是 `applyCommands` 命令，进历史，可以撤销。
- 移除数据包后，它类型的对象保留，按“未知类型”显示，数据只读；重新导入后恢复可编辑。
- 清单大小上限 256 KB；最多 30 个类型、30 个关系类型、50 个预设。

### 6.1 v1 组件包转换

v1 清单（`{version: 1, id, name, components: [...]}`）导入时自动转换：

- `id` 转小写，非 `[a-z0-9-]` 字符换成 `-`，截到 41 个字符。
- `name` → `title`。
- `components[]` → `presets[]`：`key`、`title`、`width`、`height`、`data` 原样保留；`type` 按 `01-data-model.md` §10.1 改名；`data` 里的占位值按同一节规则清理。

## 7. 代码扩展（二级，组件阶段之后实现）

这里只定接口，v3 内核阶段**不实现**。

- 数据包可以带 `views: [{ "name": "...", "html": "..." }]`，类型的 `display.view` 指向它。
- 视图在 `sandbox="allow-scripts"`（不加 `allow-same-origin`）的 iframe 里运行，CSP 禁止一切网络请求。
- 宿主发给视图：`{ type: "sand.init", object, spec, presentation, detail, readOnly }`，数据变化时发 `{ type: "sand.update", ... }`。
- 视图发给宿主：`{ type: "sand.dispatch", requestId, commands }`；宿主只放行目标是这个对象本身的 `object.update`，其余拒绝；结果以 `{ type: "sand.result", requestId, result | error }` 回传。
- 这与 §5.2 的 `ViewProps` 一一对应：`dispatch` 就是 `sand.dispatch`。

## 8. 内置包清单

### 8.1 `base`（通用）

| 类型 | 说明 | container | 主要字段 |
|---|---|---|---|
| `base.board` | 白板 | 是 | 无（标题即白板名） |
| `base.frame` | 画布上的框，用来分组 | 否 | 无 |
| `base.note` | 便签 / 文字 | 否 | `body`（markdown） |
| `base.heading` | 标题 | 否 | `text`、`level`（1–3，`x-sand-default: 1`） |
| `base.link` | 超链接 | 否 | `url`、`description` |
| `base.media` | 图片 / 音频 / 视频 | 否 | `blob`、`mime`、`caption`、`alt` |
| `base.code_snippet` | 代码片段 | 否 | `language`（`x-sand-default: "text"`）、`text` |
| `base.metric` | 指标 | 否 | `value`、`unit`、`description` |
| `base.status` | 状态 | 否 | `state`、`description`、`sourceUrl` |
| `base.table` | 表格 | 否 | `columns`、`rows` |
| `base.chart` | 图表 | 否 | `kind`（`x-sand-default: "bar"`）、`points` |
| `base.events` | 事件流 | 否 | `events` |
| `base.task` | 任务清单 | 否 | `goal`、`items` |
| `base.reasoning` | 推理 | 否 | `question`、`evidence`、`options`、`decision`、`unknowns` |
| `base.comparison` | 比较 | 否 | `left`、`right`、`conclusion` |
| `base.tour` | 导览 | 否 | `purpose`（markdown）。每一站是一条 `base.tour_stop` 关系（导览 → 站点对象），`attributes` 里存 `order`、`title`、`explanation` |

关系类型：`base.related`（相关）、`base.depends_on`（依赖）、`base.supports`（支持，`requiresBasis`）、`base.compares`（比较）、`base.belongs_to`（从属）、`base.about`（关于，用于便签和讲解指向被讲解对象）、`base.tour_stop`（导览站点，`attributes.order` 为整数，`attributes.title`、`attributes.explanation` 为字符串）。

字段的具体限制（长度、条目数）沿用 v2 `core/spaces.ts` 里 `checkComponentData` 的数字，改写成 Schema。

### 8.2 `novel`（小说）

类型：`novel.character`（见 §3.3）、`novel.event`（`summary`、`storyTime`、`narrativeOrder`、`place`；参与者是关系槽）、`novel.chapter`（`summary`、`narrativeOrder`、`wordCount`、`body`）。
关系：`novel.participates`（事件 → 人物，参与）、`novel.causes`（导致）、`novel.precedes`（先于）、`novel.foreshadows`（埋设 → 回收）。

### 8.3 `research`（科研）

类型：`research.hypothesis`、`research.evidence`（`citation` 用 `locator` 控件，`quote`、`status`）、`research.conclusion`。
关系：`research.supports`（支持，`requiresBasis`）、`research.refutes`（反驳，`requiresBasis`）。

### 8.4 `code`（代码）

类型：`code.repository`、`code.file`、`code.symbol`（这三个 `source.origin = "derived"`，不进历史）、`code.intent`、`code.proposal`、`code.validation`。
关系：`code.contains`、`code.imports`、`code.calls`（推测，`allowsInferred`）。
工具：`code_repo`、`code_change`（模型可见），`code_decide`（界面专用）。


## 9. 功能组件的受控绑定（组件阶段验收）

图表读取表格、比较读取两个对象/版本、关系图读取有界查询，通过持久关系槽声明绑定，不复制源数据。宿主提供 readBindings({slot, ids?, fields?, limit?, cursor?})：仅可访问声明并已绑定的目标，返回版本、来源与失效原因。任意未绑定 ID 拒绝。

subscribeBindings 提供可取消订阅，源对象/关系变化、删除、包停用或权限变化时通知；卸载释放，以 revision/version 拒绝过期结果。沙箱消息携带 requestId 并逐次验证声明与范围；可读不等于可跨对象写。跨对象动作由显式规则/用户操作授权。

首次组件接入前建立任务卡：同一表格驱动两张图、比较读取两个版本、未绑定读取被拒、删除来源不丢引用记录。这是组件阶段接口，T11 不提前实现运行时。


### 派生身份策略

PackSpec.derivedIdPrefix 只允许内置包声明，非空、以冒号结尾、不能与其他内置包前缀重叠；Registry.getPack 返回它。代码包声明 code:。内部 object.upsert_derived 命令携带 packId：注册表必须存在且为 builtin，对象类型属于同包，新建ID匹配该前缀。更新只允许同包原有derived对象；旧导入ID可不匹配新前缀，但必须核实稳定 external URI/fragment 与原对象一致，不覆盖其他来源或其他目标。T17必须为旧派生对象保留外部定位，T22刷新通过定位复用原ID。

## 10. 锚点格式

精确引用、批注、媒体定位共用 `ExternalLocator`（`01-data-model.md` §5），片段写在 `fragment` 里，格式固定如下。多个键用 `;` 分隔，值里的 `;` 和 `=` 用百分号编码。

| 资源 | `fragment` 格式 | 说明 |
|---|---|---|
| 文字（Markdown 正文、代码、纯文本） | `quote=<原文>;prefix=<前 32 字>;suffix=<后 32 字>` | 按原文和上下文重新定位，不依赖字符偏移 |
| PDF | `page=<页码>` 或 `page=<页码>;rect=<x>,<y>,<w>,<h>` | `rect` 是相对页面宽高的 0–1 小数 |
| 图片 | `rect=<x>,<y>,<w>,<h>` | 相对图片宽高的 0–1 小数 |
| 音频、视频 | `t=<开始秒>` 或 `t=<开始秒>,<结束秒>` | 与 Media Fragments 的写法一致 |
| 表格 | `rows=<行 key 列表>;cols=<列 key 列表>` | 用行、列的 key，不用下标 |
| 代码文件 | `lines=<起始行>-<结束行>` | 配合 `version`（提交号）和 `fingerprint` |

`fingerprint` 记录建锚时源内容的指纹。源内容变了，先按 `quote`、`prefix`、`suffix` 重新定位；找不到就把引用标为失效并给出原因，不悄悄挂到别处（T53）。

## 后续阶段契约补充

新增评论/引用、运行、时间/分支/观察者及组件接口的正式约束见 [05-delivery-contracts.md](05-delivery-contracts.md)。各责任卡实现时同步本文件的具体类型/表/工具签名；不能仅根据旧的基础清单拒绝已经授权的扩展。
