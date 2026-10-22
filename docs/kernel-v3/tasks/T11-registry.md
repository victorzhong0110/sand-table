# T11 类型注册表与 Ajv 校验

| 项 | 内容 |
|---|---|
| 执行 | grok |
| 依赖 | T10 |
| 分支 | `task/T11-registry` |

## 目标

实现 `kernel/registry.ts`：注册包、查类型和关系类型、校验包声明本身、按类型的 JSON Schema 校验对象数据并给出中文错误。

## 先读

- `AGENTS.md`
- `docs/kernel-v3/03-types-and-extensions.md`（全文）
- `docs/kernel-v3/02-commands-and-tools.md` §1.3（`INVALID_DATA` 的错误格式）
- `workbench/kernel/types.ts`（T10 产物）

## 可改文件

- 新建 `workbench/kernel/registry.ts`、`workbench/kernel/messages.ts`
- `workbench/kernel/index.ts`（加导出）
- 新建 `workbench/tests/kernel-registry.test.ts`
- `workbench/package.json`、`workbench/package-lock.json`（只为加 `ajv` 依赖）

## 不要做

- 不用模块级全局变量保存注册表（v2 的 `core/domains.ts` 是全局 Map，不要照抄）。每次 `createRegistry()` 返回独立实例。
- 不写任何具体的包（T12 的事），测试里自己造小包。
- 不碰数据库。

## 依赖

- `ajv`：用 `npm view ajv version` 查当前 8.x 最新版，写死版本号（不要 `^`）。使用 `import Ajv2020 from "ajv/dist/2020.js"`。

## 做法

### 1. 接口

```ts
export type Registry = {
  registerPack(spec: PackSpec, kind: "builtin" | "data"): void; // 不合格就抛 PackSpecError
  unregisterPack(id: string): void;
  getPack(id: string): { spec: PackSpec; kind: "builtin" | "data" } | undefined;
  listPacks(): { spec: PackSpec; kind: "builtin" | "data" }[];
  getType(type: string): TypeSpec | undefined;
  getRelationKind(kind: string): RelationKindSpec | undefined;
  getTemplate(id: string): TemplateSpec | undefined;
  packIdOf(name: string): string; // 'novel.character' → 'novel'
  validateData(type: string, data: unknown): { ok: true } | { ok: false; errors: { path: string; message: string }[] };
};
export function createRegistry(): Registry;
export class PackSpecError extends Error { problems: { path: string; message: string }[] }
```

`validateData` 不检查包是否启用（启用状态在数据库里，由 T13 检查）。

### 2. 包声明自检（`registerPack` 时执行，全部问题一次性收集后抛出）

按 `03-types-and-extensions.md`：

- §1 命名：包 id、类型名、关系名的格式；类型名和关系名必须以 `<包 id>.` 开头。
- 同一注册表里类型名、关系名、模板 id 不能重复（同一个包重新注册时先移除旧的再检查）。
- §3.1 Schema 规则：顶层 `type: "object"`、有 `properties`、`additionalProperties: false`；整个 Schema 树里不能出现 `default` 关键字；`x-sand-widget` 的取值必须在 §3.2 的列表里。
- `relationSlots[].kind` 必须是本包或已注册包里存在的关系类型。
- `display.summary` 里的字段必须在 `properties` 里。
- `kind === "data"` 时：不能有 `display.view`、`migrations`、`registerTools`；数量上限按 §6（30 个类型、30 个关系类型、50 个预设）。
- 每个 Schema 能被 Ajv 编译；编译失败把 Ajv 的信息放进问题列表。

### 3. Ajv 设置

```ts
const ajv = new Ajv2020({ strict: true, allErrors: true });
for (const k of ["x-sand-label", "x-sand-widget", "x-sand-placeholder", "x-sand-unit", "x-sand-enum-labels", "x-sand-default", "x-sand-hidden"])
  ajv.addKeyword(k);
```

每个类型的 Schema 在注册时编译一次并缓存。

### 4. 中文错误（`kernel/messages.ts`）

把 Ajv 错误转成 `{ path, message }`：`path` 用 Ajv 的 `instancePath`（`additionalProperties` 和 `required` 错误要把具体字段名拼进路径，如 `/age`）。`message` 至少覆盖下列关键字，其余用 Ajv 原文：

| 关键字 | 中文 |
|---|---|
| `type` | 必须是{数字 / 整数 / 文字 / 列表 / 对象 / 是或否} |
| `minimum` / `maximum` | 不能小于 {n} / 不能大于 {n} |
| `minLength` / `maxLength` | 至少 {n} 个字 / 最多 {n} 个字 |
| `minItems` / `maxItems` | 至少 {n} 项 / 最多 {n} 项 |
| `enum` | 只能是：{用 x-sand-enum-labels 的中文名，没有就用原值} |
| `required` | 必须填写 |
| `additionalProperties` | 这个类型没有这个字段 |
| `format` | 格式不对 |

字段名用 Schema 里的 `x-sand-label`，没有就用键名。最终格式例如：`{ path: "/age", message: "年龄：不能小于 0" }`。

## 验收

`workbench/tests/kernel-registry.test.ts`：

1. 一个合格的小包（1 个类型、1 个关系、1 个模板）注册成功，`getType`、`getRelationKind`、`getTemplate` 都能取到。
2. 下列每种不合格的包都抛 `PackSpecError`，且 `problems` 里有指向问题位置的条目：类型名没有包前缀；Schema 缺 `additionalProperties: false`；Schema 某个字段有 `default`；`x-sand-widget: "slider"`；关系槽指向不存在的关系；`summary` 引用不存在的字段；数据包带 `display.view`；数据包带 `registerTools`。
3. 一次注册里有 3 个问题时，`problems` 里正好列出 3 条。
4. `validateData`：合格数据返回 `ok: true`；`age: -1` 返回路径 `/age`、信息含“不能小于 0”；多一个未声明字段返回“这个类型没有这个字段”。
5. 两个 `createRegistry()` 实例互不影响。
6. 同一个包重新注册（版本号变大）成功，旧类型被替换。

命令：`npm run format:check`、`npm run typecheck`、`npm test` 全部通过。
