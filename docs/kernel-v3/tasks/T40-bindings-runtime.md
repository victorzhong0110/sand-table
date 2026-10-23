# T40 受控绑定运行时

| 项 | 内容 |
|---|---|
| 执行 | grok |
| 依赖 | T34 |
| 分支 | `task/T40-bindings-runtime` |

## 目标

实现 `03-types-and-extensions.md` §9 的受控绑定：功能组件（图表、比较、关系图……）只能读取自己通过关系槽绑定的对象，能订阅它们的变化，能读取某个对象的指定历史版本。读不到的给出原因，未绑定的一律拒绝。Phase 4 的数据、比较、关系图都建在这上面。

## 先读

- `AGENTS.md`
- `docs/kernel-v3/05-delivery-contracts.md`（本阶段公共契约与交接规则）
- `docs/kernel-v3/03-types-and-extensions.md` §4、§5.2、§9
- `docs/kernel-v3/01-data-model.md` §7.1（历史快照里有每次修改前后的完整行）
- `workbench/kernel/read.ts`、`workbench/board/views/registry.ts`（`ViewProps`）

## 开工前核对

确认 `ViewProps` 在 `main` 上与 `03` §5.2 一致，通用视图已支持按 `display.view` 挂自定义视图（T34）。依赖未完成则等待；机械差异按 05 §1 适配，语义冲突只暂停受影响部分。

## 可改文件

- 新建 `workbench/kernel/bindings.ts`；`workbench/kernel/index.ts`
- `workbench/server/app-tools.ts`（加 `app_bindings`）
- 新建 `workbench/board/views/bindings.ts`（界面侧订阅）；`workbench/board/views/registry.ts`（`ViewProps` 加 `bindings`）
- `docs/kernel-v3/02-commands-and-tools.md`（§3.4 加一行 `app_bindings`）、`docs/kernel-v3/03-types-and-extensions.md`（§5.2 的 `ViewProps` 加 `bindings`）
- 新建 `workbench/tests/kernel-bindings.test.ts`，修改 `workbench/tests/blank.ts`

## 不要做

- 不给绑定开写权限：组件写自己的数据走 `dispatch`，跨对象写入不在本卡。
- 不在界面里拼 SQL 或直接读别的对象。

## 做法

1. **内核**（`kernel/bindings.ts`）：

   ```ts
   export function readBindings(db: Db, registry: Registry, input: {
     objectId: string;        // 发起读取的组件对象
     slot: string;            // 它类型里声明的关系槽 key
     ids?: string[];          // 只读其中一部分；必须都在已绑定集合里
     fields?: string[];       // 只要这些数据字段
     limit?: number;          // 默认 50，最大 200
     cursor?: string;
   }): { revision: number; items: { id: string; type: string; title: string; version: number; data: Record<string, unknown>; unavailable?: string }[]; nextCursor: string | null };

   export function readObjectVersion(db: Db, registry: Registry, input: { objectId: string; slot: string; targetId: string; version: number }):
     { ok: true; row: ObjectRow } | { ok: false; reason: string };
   ```

   - 槽必须在发起对象的类型里声明；否则 `FORBIDDEN`。
   - `ids` 里任何一个不是该槽已绑定的对象：整个请求 `FORBIDDEN`，错误里列出这些 id。
   - 绑定目标已删除、所属包停用：仍返回条目，`data` 为空，`unavailable` 写明原因。
   - `readObjectVersion`：当前版本直接读；旧版本从历史记录的 before 和 after 快照里找对象 id 与 version 都相等的版本；找不到（被裁剪了）返回原因“这个版本的记录已被清理”。
2. **工具**：`app_bindings`（界面专用）包装上面两个函数；版本读取同样执行槽授权，不能提供任意 ID 读取旁路。
3. **界面订阅**（`board/views/bindings.ts`）：

   ```ts
   type Bindings = {
     read(slot: string, opts?: { ids?: string[]; fields?: string[]; limit?: number; cursor?: string }): Promise<...>;
     readVersion(slot: string, id: string, version: number): Promise<...>;
     subscribe(slot: string, onChange: () => void): () => void; // 返回取消订阅函数
   };
   ```

   `subscribe` 基于界面已有的增量同步：任何一次增量里出现了该组件的关系变化、或已绑定对象的变化，就调用 `onChange`。组件卸载时自动取消。结果带 `revision`，比当前已显示的旧的结果直接丢弃。

## 验收

`workbench/tests/kernel-bindings.test.ts`（测试包自造：一个“读者”类型带槽 `source`，一个“表格”类型）：

1. 绑定两个表格后读取，返回两个；读第三个未绑定的表格 `FORBIDDEN`。
2. 读一个没声明的槽 `FORBIDDEN`。
3. 删除一个已绑定表格后读取，该条目带 `unavailable`；撤销后恢复。
4. 修改表格 3 次后，能分别读到版本 1、2、3、4；历史被裁剪后读旧版本返回原因。
5. `fields` 只返回指定字段；`limit` 和 `cursor` 分页正确。

`workbench/tests/blank.ts`：一个测试用自定义视图订阅绑定的表格，在另一个浏览器页修改表格后，视图在 2 秒内更新。

命令：`npm run format:check`、`npm run typecheck`、`npm test`、`npm run test:blank`。

## 交接与边界验收

完整落实 05 §4；加跨槽越权、未绑定历史版本拒绝、before-only 版本、墓碑/包停用、取消订阅和乱序响应测试。只扫描现存历史时版本不可用明确提示，不保证无限历史。

## 交接与边界验收

删除目标导致的关系墓碑仅用于失效展示；手动删除槽关系后再次读该目标必须拒绝。目标与关系物理裁剪后返回不可用，不恢复访问。
