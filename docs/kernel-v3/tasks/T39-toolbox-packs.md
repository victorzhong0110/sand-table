# T39 工具箱与数据包管理

| 项 | 内容 |
|---|---|
| 执行 | minimax |
| 依赖 | T34、T37 |
| 分支 | `task/T39-toolbox-packs` |
| 关联 issue | #33、#11 |

## 目标

工具箱完全由注册表生成：按包分组列出可用类型、模板和预设，拖到画布或点击就能新建。数据包可以在界面上导入、启用、停用、导出、移除，错误逐条显示。

## 先读

- `AGENTS.md`
- `docs/kernel-v3/05-delivery-contracts.md`（本阶段公共契约与交接规则）
- `docs/kernel-v3/03-types-and-extensions.md` §2、§6（数据包规则与 v1 转换）
- `docs/kernel-v3/02-commands-and-tools.md` §1.1（`object.create`、`template.apply`、`pack.*`）、§3.4（`app_pack`）
- `workbench/board/Toolbox.tsx`（现有工具箱）
- 外壳的“组件”面板（T37 产物）

## 开工前核对

确认 `sand_types` 不带参数时返回类型、关系类型、模板的精简列表；`app_pack export` 存在。依赖未完成则等待；机械差异按 05 §1 适配，语义冲突只暂停受影响部分。

## 可改文件

- `workbench/board/Toolbox.tsx`，新建 `workbench/board/packs/`（`PackManager.tsx`、`PackErrors.tsx`）
- 外壳“组件”面板挂载处、设置面板里挂包管理的那一处
- `workbench/board/style.css`
- `workbench/tests/blank.ts`

## 不要做

- 不写死任何类型名；工具箱里出现什么完全看注册表。
- 不支持带代码的扩展（二级扩展是 T67）。

## 做法

1. **工具箱**：
   - 分组：每个已启用包一组（基础包在最前），组内按类型声明顺序。每项显示图标、中文名，悬停显示 `description`。
   - 顶部搜索：按中文名和描述过滤。
   - 拖到画布：在放下的位置 `object.create` + `presentation.create`，一次 `app_edit`。点击：放在当前视口中央。
   - “模板”分组：列出所有模板，点击执行 `template.apply` 到当前白板。
   - “预设”分组：数据包里的预设，点击按预设的类型和数据新建。
2. **包管理**（设置 → 组件包）：
   - 列出全部包：名字、版本、内置 / 数据、启用状态、它的类型数。
   - 内置包可启用 / 停用（`base` 不可停用，开关置灰并说明原因）。数据包还可导出、移除。
   - 停用或移除前提示：“这个包的 N 个对象会变成只读，数据不会丢失。”
   - 导入：选择 JSON 文件 → `pack.import`。失败时把 `PackSpecError` 的每个问题（路径 + 中文说明）列成清单；成功后工具箱立刻出现新类型。
   - 所有启停、导入、移除都可撤销。

## 验收

- `workbench/tests/blank.ts`：
  1. 工具箱分组与 `sand_types` 返回的已启用包一致；停用小说包后“人物”从工具箱消失，已有人物卡显示只读提示；撤销后恢复。
  2. 从工具箱拖一个便签到画布指定位置，服务端展示坐标在放下点附近。
  3. 导入一个合格的数据包，工具箱出现新类型并能新建；导入一个有 3 处问题的包，界面列出 3 条错误。
  4. 应用一个模板，画布出现模板里的全部对象和关系。
- `npm run format:check`、`npm run typecheck`、`npm test`、`npm run test:blank` 全部通过。
