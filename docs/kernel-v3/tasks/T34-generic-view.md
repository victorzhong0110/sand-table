# T34 通用视图：卡片、编辑表单、关系槽

| 项 | 内容 |
|---|---|
| 执行 | grok |
| 依赖 | T30、T26 |
| 分支 | `task/T34-generic-view` |
| 关联 issue | #33 |

## 目标

所有类型都按类型声明自动显示和编辑：卡片只显示有值的摘要字段（不再出现“年龄 0”），表单由 Schema 生成，指向其他对象的信息用关系槽显示和编辑。完成后删除 v2 的 `ComponentRenderer.tsx`、`ComponentPanel.tsx` 和 T21 的适配层。

## 先读

- `AGENTS.md`
- `docs/kernel-v3/03-types-and-extensions.md` §2、§3、§4、§5
- `docs/kernel-v3/02-commands-and-tools.md` §1.3（只对本次改动字段严格校验，其余作为警告）
- `workbench/board/canvas/`（T30 产物）
- `workbench/board/edit-session.ts`（现有的意图分组和 600ms 自动保存）
- `workbench/board/ComponentRenderer.tsx`、`ComponentPanel.tsx`（将被替换）

## 开工前核对

确认：`sand_types { types }` 返回完整类型声明（含 Schema、关系槽、能力）；`readObjects` 返回 `migrationError`（T26）。不一致先停下来问。

## 可改文件

- 新建 `workbench/board/views/`（`GenericCard.tsx`、`GenericForm.tsx`、`RelationSlots.tsx`、`OtherFields.tsx`、`UnknownType.tsx`、`registry.ts`、`format.ts`）
- `workbench/board/canvas/nodes.tsx`（节点内容改用通用视图）
- `workbench/board/edit-session.ts`
- 删除 `workbench/board/ComponentRenderer.tsx`、`workbench/board/ComponentPanel.tsx`、T21 的适配层，以及只被它们使用的代码
- `workbench/board/style.css`
- 新建 `workbench/tests/generic-view.test.ts`，修改 `workbench/tests/blank.ts`

## 不要做

- 各种控件只做最简单的文本输入兜底，完整控件是 T35 的事（`format.ts` 和控件接口在本卡定好）。
- 不做富文本编辑器（T43）。
- 不改内置包的类型声明。

## 做法

1. **控件接口**（`views/registry.ts`）：

   ```ts
   export type WidgetProps = { value: unknown; schema: JsonSchema; label: string; readOnly: boolean; onChange(next: unknown | undefined): void };
   export type Widget = { display(value: unknown, schema: JsonSchema): string; Editor: (p: WidgetProps) => JSX.Element };
   export function widgetFor(schema: JsonSchema): Widget; // 按 x-sand-widget，缺省按 type 推断
   ```

   `onChange(undefined)` 表示清空，写入时变成 `unset`。
2. **卡片**（`GenericCard`）：标题 + `display.summary` 里**有值**的字段（`undefined` 不显示，`0` 是真值要显示）+ 关系槽的对象标签。材质按 `display.material`。三档折叠：`full` 显示上述内容；`label` 只显示图标和标题；`icon` 只显示图标。有封面图（`appearance.coverBlob`）且类型声明 `cover` 时，`full` 档以封面为主体、标题叠在下方。
3. **表单**（`GenericForm`，在侧边属性面板里）：按 `properties` 顺序生成控件；必填字段标星；每个字段停止输入 600ms 或失焦时提交，提交只包含改动的键（`set` / `unset`），带 `expectedVersion`。
   - `VERSION_CONFLICT`：保留本地草稿，提示“这个对象刚被别人改过”，提供“用我的覆盖”和“放弃我的修改”。
   - `warnings`：在对应字段下以灰色小字显示，不阻止保存。
   - 迁移失败（`migrationError`）：整个表单只读，顶部显示原因。
4. **关系槽**（`RelationSlots`）：每个槽显示已连接对象的标签；点 × 删除那条关系；点 + 打开搜索框（调用 `sand_query`，按 `targetTypes` 过滤），选中后建关系（方向按 `direction`）。`many: false` 的槽已有一条时，选新的会替换旧的（同一批命令里删旧建新）。
5. **其他字段**：数据里有、Schema 里没有的字段，在表单底部“其他字段”里只读列出。
6. **未知类型**：显示标题、类型名和“此类型来自未启用的包「x」”，数据只读，提供“去设置里启用”。
7. **自定义视图注册**：`display.view` 有值时按名字查内置视图表（本卡只建空表），查不到就用通用视图。自定义视图收到 `03` §5.2 的 `ViewProps`。

## 验收

- `workbench/tests/generic-view.test.ts`：`format.ts` 对各类型的显示（`undefined` 不显示、`0` 显示、列表、枚举中文名、单位）。
- `workbench/tests/blank.ts`：
  1. 新建人物，卡片上没有“年龄”；填 30 后出现“年龄 30 岁”；清空后消失。
  2. 事件的“参与者”槽里加一个人物，服务端多一条 `novel.participates`；点 × 后关系被删除。
  3. 两个浏览器页同时改同一人物的同一字段，后提交的一方看到冲突提示，草稿还在。
  4. 停用小说包后人物卡显示“未启用”提示且只读；重新启用后可编辑。
  5. 折叠成 `label`、`icon` 再展开，存储的宽高不变。
- `npm run format:check`、`npm run typecheck`、`npm test`、`npm run test:blank` 全部通过。
