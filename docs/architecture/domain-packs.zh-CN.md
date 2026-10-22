# 领域包与连接器

> **历史文档（v2）。** v3 的包与类型契约见 [`docs/kernel-v3/03-types-and-extensions.md`](../kernel-v3/03-types-and-extensions.md)；冲突时以 v3 为准。

> 契约版本 v1（2026-10-20）。本文是 #13（代码领域包与连接器）、
> #14（小说与科研纵向验证）的共同规格。
> 契约文档见 `docs/architecture/domain-packs.zh-CN.md`；上位契约见 `docs/architecture/workspace-kernel.zh-CN.md`。

## 1. 目标

现在「代码」是内核里的特例：`core/spaces.ts` 里有代码类组件，
`server/repository.ts` 做 TS AST 索引，`server/import.ts` 做仓库导入，
`server/worktree.ts` 管真实工作树基线。这些都是**领域语义**，却住在通用层里。

目标：**内核只认对象/关系/展示三类实体 + 一张注册表**。
领域语义（类型、组件、关系、工具、模板）由**领域包**提供；
外部系统（文件夹、Git）由**连接器**提供，并**显式声明能力**。

不硬编码进内核的判据：去掉这个领域语义后，内核不会少任何通用能力，
只是少了一个领域的词汇。

## 2. 领域包机制

### 2.1 包的结构

```
workbench/domains/
  code/            # 代码领域包
    index.ts       # 包定义（类型/组件/关系/工具/模板）
    indexer.ts     # TS AST 索引（原 server/repository.ts）
    python-indexer.ts
  novel/           # 小说领域包（#14）
  research/        # 科研领域包（#14）
```

领域包是**纯数据 + 纯函数**的模块，不依赖 store、不碰文件系统（除了自己的索引器）。

### 2.2 注册表 API

注册表在 `core/domains.ts`（通用层，不含任何领域语义）：

```ts
export function registerDomainPack(pack: DomainPack): void;
export function listDomainPacks(): DomainPack[];
export function getDomainPack(id: string): DomainPack | undefined;
/** 按类型名找对象类型定义（含内置原生类型）。 */
export function findObjectType(type: string): DomainObjectType | undefined;
/** 按类型名找组件定义。 */
export function findComponentType(
  type: string,
): DomainComponentType | undefined;
/** 按关系类型名找定义。 */
export function findRelationType(kind: string): DomainRelationType | undefined;
/** 领域包的校验：没有领域规则时返回空数组。 */
export function checkDomainData(
  type: string,
  data: Record<string, unknown>,
): string[];
/** 列出所有可用模板。 */
export function listTemplates(): { packId: string; template: DomainTemplate }[];
```

`DomainPack` / `DomainObjectType` / `DomainComponentType` / `DomainRelationType` /
`DomainToolSpec` / `DomainTemplate` 的类型定义在 `core/objects.ts`（共享契约，负责人维护），
**生产者不要改那个文件**。

### 2.3 注册时机

注册表是**进程内单例**，由启动代码显式注册：

- 内核启动时注册**内置原生类型**（note / text / checklist / chart / table 等，来自 `core/spaces.ts`）。
- 领域包按需注册：代码包在绑定仓库时注册；小说/科研包在用户选择该领域时注册，
  或默认全部注册但**不强制流程**（模板只是起点，用户可以从空白开始）。

### 2.4 与既有校验入口的关系

统一入口仍是 `core/spaces.ts` 的 `checkComponentData`（集成轮决策 D3）。
本契约要求它**追加**领域规则，而不是并列出第二套：

```
checkComponentData(type, data):
  1. 基础规则（现有实现）
  2. 找到该类型的领域定义 → 追加领域规则
  3. 合并错误文案（领域规则的错误带 "领域规则：" 前缀，便于区分来源）
```

**不允许**出现第二个校验入口。

## 3. 连接器

### 3.1 能力声明

连接器必须显式声明能读什么、能写什么、写入是否需要人确认、外部影响范围。
类型定义在 `core/objects.ts`：

```ts
export type ConnectorCapabilities = {
  read: {
    kinds: ("file" | "git" | "pdf" | "url" | "dataset" | "symbol")[];
    scopes: string[];
  };
  write?: {
    requiresConfirmation: boolean;
    externalScope: string;
    kinds: string[];
  };
};
```

**未声明的能力在调用时被拒绝，并说明原因**——不允许「先做了再说」。
只读连接器不声明 `write`，调用写入方法时必须得到一句明确的拒绝理由
（例如「folder 连接器是只读的：不能写入外部文件」）。

### 3.2 两个连接器

| 连接器 | id       | 读                                     | 写                                                                             |
| ------ | -------- | -------------------------------------- | ------------------------------------------------------------------------------ |
| 文件夹 | `folder` | `kinds: ["file"]`，作用域是普通目录    | 无（只读）                                                                     |
| Git    | `git`    | `kinds: ["file", "git"]`，作用域是仓库 | `kinds: ["file"]`，`requiresConfirmation: true`，`externalScope: "仓库工作树"` |

### 3.3 Git 连接器必须保留的确认链路

既有链路**一字不改地保留**：

```
明确意图 → 具体提案版本与 digest → 人确认 → 宿主写入 → 实际内容与范围核对
```

必须保住的要素：

- **内容指纹**（content hash）：提案针对的具体内容版本。
- **脏工作树基线**：写入前记录工作树状态。
- **范围外路径检查**：提案不允许写到声明范围之外。
- **确认绑定具体提案版本 + digest**，不是笼统的「同意写入」。

### 3.4 文件夹连接器

读普通目录（不需要是 Git 仓库），产出引用与只读内容。
未配置任何仓库时，白板仍可正常使用；文件夹连接器可独立读取普通目录。

## 4. 迁移映射

| 现状                                                          | 目标位置                                      | 归属          |
| ------------------------------------------------------------- | --------------------------------------------- | ------------- |
| `server/repository.ts`（TS AST 索引、content hash、引用校验） | `workbench/domains/code/indexer.ts`           | 生产者 C      |
| `server/python.ts`、`server/python_index.py`                  | `workbench/domains/code/python-indexer.ts`    | 生产者 C      |
| `server/import.ts`（仓库导入）                                | `workbench/connectors/git.ts`                 | 生产者 C      |
| `server/worktree.ts`（工作树基线）                            | `workbench/connectors/git.ts`                 | 生产者 C      |
| `core/spaces.ts` 里的代码类组件类型                           | `workbench/domains/code/index.ts`（注册进包） | 生产者 C      |
| `core/model.ts` 的 `Item`（代码投影）                         | 统一为 `WorkspaceObject`（`kind: "code"`）    | 已完成（#16） |

**硬性架构规则**：`core/` 与 `server/` 的通用部分**不得** import 代码索引实现。
这条要有自动测试守着（见 §6 的 D8）。

## 5. MCP 工具的兼容

既有 `sand_*` 工具的**语义不得静默变化**。
代码领域包与连接器若导致工具改名或参数变化，必须在
`workbench/docs/IMPLEMENTATION.md` 写明兼容说明（旧名 → 新名 → 差异）。

## 6. 不变量

| 编号 | 不变量                                                                    | 怎么验                                              |
| ---- | ------------------------------------------------------------------------- | --------------------------------------------------- |
| D1   | 关闭代码包与 Git 连接器后，通用内核仍可启动、建原生对象、编辑、保存、重开 | 集成测试：只注册内置原生类型的注册表                |
| D2   | 不配置任何仓库，白板仍可正常使用                                          | 集成测试：无 roots 启动                             |
| D3   | 文件夹连接器可独立读取普通目录                                            | 连接器测试                                          |
| D4   | 未声明的能力被拒绝并说明原因                                              | 调用 folder 连接器的写入 → 抛错且错误文案含「只读」 |
| D5   | Git 写入必须经人确认，且确认绑定具体提案版本 + digest                     | 确认链路测试：跳过确认直接写 → 拒绝                 |
| D6   | 范围外路径检查仍然有效                                                    | 提案写到声明范围外 → 拒绝                           |
| D7   | 代码场景无回归：索引、引用、内容指纹、提案确认、实际范围核对              | 既有测试逐项通过（迁移后）                          |
| D8   | `core/` 与 `server/` 通用部分不 import 代码索引实现                       | 架构测试：扫描 import 图                            |
| D9   | 领域包注册后类型、组件、关系、工具、模板都可被查询                        | 注册表测试                                          |
| D10  | 领域校验与基础校验合并成一条错误清单                                      | 校验测试                                            |
| D11  | MCP 工具语义未静默变化                                                    | 工具清单快照对比 + 兼容说明文档                     |

## 7. 交付形态（#13）

| 文件                                 | 归属     | 内容                                                 |
| ------------------------------------ | -------- | ---------------------------------------------------- |
| `workbench/core/domains.ts`          | 生产者 C | 注册表（纯数据，不含领域语义）                       |
| `workbench/domains/code/**`          | 生产者 C | 代码领域包：索引器、Python 索引、类型/组件/关系/模板 |
| `workbench/connectors/folder.ts`     | 生产者 C | 文件夹连接器（只读）                                 |
| `workbench/connectors/git.ts`        | 生产者 C | Git 连接器（含确认链路与工作树基线）                 |
| `workbench/core/spaces.ts`           | 生产者 C | 校验入口追加领域规则；代码类组件移出                 |
| `workbench/tests/domains.test.ts`    | 生产者 C | D1、D4、D8、D9、D10                                  |
| `workbench/tests/connectors.test.ts` | 生产者 C | D3、D5、D6、D7                                       |
| `workbench/docs/IMPLEMENTATION.md`   | 负责人   | 迁移说明与兼容说明                                   |

## 8. 交付形态（#14，纵向场景）

| 文件                                  | 归属     | 内容                                        |
| ------------------------------------- | -------- | ------------------------------------------- |
| `workbench/domains/novel/index.ts`    | 生产者 D | 人物/事件/章节类型、情节关系类型、模板      |
| `workbench/domains/research/index.ts` | 生产者 D | 假设/证据/结论类型、支持/反驳关系、引用类型 |
| `workbench/tests/vertical.test.ts`    | 生产者 D | 小说与科研两个场景的**可重复**自动测试      |

### 8.1 小说场景（必须全自动跑通）

1. 创建人物、事件、章节对象。
2. 同一人物在两块白板各有展示实例：
   - 改人物内容 → 两张卡同时更新；
   - 移动一张 → 另一张不动。
3. 建立情节关系（参与 / 导致 / 先于 / 埋设-回收），
   区分「已确认」与「推测」。
4. 保存 → 关闭 → 重开，作品完整。

### 8.2 科研场景（必须全自动跑通）

1. 导入或引用 PDF 的具体片段（**页码级定位**），引用带来源与指纹。
2. 建立假设、证据、结论对象，标识支持 / 反驳关系及其依据。
3. 外部内容变化或引用失效**可被识别**，不静默覆盖。
4. 保存 → 关闭 → 重开，作品完整。

### 8.3 混合场景

同一工作空间同时存在科研类型与代码类型，互不要求迁移到另一种「项目模式」。

### 8.4 领域包职责 vs 内核职责

出现模型缺口时，**先讨论内核职责**，不在内核里堆场景特例。
本轮暴露的缺口要回写本文与内核契约，并标注是「内核职责」还是「领域包职责」。

- 允许进内核的：对象/关系/展示模型、持久化、历史、权限与确认的**通用形状**。
- 留在领域包的：情节关系词汇、假设与证据的类型定义、引用呈现方式、模板。

## 8.5 纵向验证暴露的模型缺口（2026-10-20 回写）

小说／科研两个场景跑通后，暴露了 8 个缺口。这里逐条记下**归属**——
「内核职责」进内核与本契约，「领域包职责」留在包里。

| #   | 缺口                                                                         | 归属         | 状态                                                                    |
| --- | ---------------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------- |
| 1   | 领域类型过不了统一写路径：`isNativeContent` 只认硬编码名单，领域对象建不出来 | **内核职责** | ✅ 已改：查注册表（内置 ∪ `findObjectType`）                            |
| 2   | 统一校验入口没追加领域规则                                                   | **内核职责** | ✅ 已做：`checkComponentData` 追加 `checkDomainData`                    |
| 3   | 注册表没有关系级校验入口，「推测必须给依据」没有强制点                       | **内核职责** | ✅ 已加 `checkDomainRelation` + 写路径调用                              |
| 4   | 关系写路径不强制「推测不得伪装成已确认」                                     | **内核职责** | ✅ 已做：`status=inferred` 必须给 `basis`，否则拒绝                     |
| 5   | 关系写路径丢 `evidence`（外部定位挂不上）                                    | **内核职责** | ✅ 已做：`relateContent` 与 MCP `relate` 都收 `evidence`                |
| 6   | 资源引用（`ResourceReference`）没有写路径，失效状态不进撤销栈                | **内核职责** | ✅ 已做：`createResource` / `updateResource`，板级键 `resources` 可撤销 |
| 7   | 领域包声明的组件类型没接线，一律用默认尺寸                                   | **内核职责** | ✅ 已做：`findComponentSpec` 查注册表                                   |
| 8   | 领域包没有注册入口，没人调用 `registerDomainPack`                            | **内核职责** | ✅ 已做：`domains/index.ts` 的 `registerAllDomains()`                   |

留在领域包里的（不重复记账）：字段与默认值、领域词汇、引用呈现方式、模板。

**一条通用规则**：凡是「写路径上必须拦住」的东西，都是内核职责——
包里的纯函数只能被自觉调用，拦不住就等于没有。

## 9. 不在本轮范围

公共插件市场、任意第三方代码加载、动态组件 SDK、多用户协作、云同步。

## 2026-10-21：真实 PDF 路径

新增兼容性增量工具（原工具不改名、不改参数）：

- `sand_read_pdf(path, page)`：PDF.js 读取真实本地文件，返回页面文本、页码与完整文件 SHA-256。最大 25 MB，不执行 PDF 脚本、不抓取网络文档；扫描件未提供 OCR。
- `sand_import_pdf_evidence(boardId, viewId, revision, path, page, title, summary?)`：建立证据对象、来源、资源引用与展示；可保存重开及撤销。
- `sand_verify_pdf_citation(citation)`：重新读取文件，对比旧指纹，返回 valid/stale/missing；权限错误和非法格式不会被伪装成“缺失”，不静默改写原记录。

`tests/pdf.test.ts` 生成并实际解析 PDF，验证导入、保存、重开、文件变更与删除。它补充原 `vertical.test.ts` 的模型测试，不等于真人科研任务验收。
