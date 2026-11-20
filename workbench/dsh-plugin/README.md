# Sand Table 的 DSH 插件

在 DSH 的侧栏打开 Sand Table，在中央列使用画布。模型、会话与凭据仍由 DSH 管理。

## 启动与安装

需要 Node.js 22.18+，DSH `>=0.2.1-rc.2 <0.3.0`。

1. 在 Sand Table 仓库启动工作台。`--embed-origin` 必须是浏览器中 **DSH 页面的精确 origin**，不是白板地址。例如：

   ```bash
   npm start -- --port 4173 --embed-origin http://127.0.0.1:3000
   ```

   `/` 仍禁止嵌入；只有显式启用的 `/embed` 允许配置的宿主 origin。默认不会向任意网站开放画布。

2. 在固定版本 DSH 中链接仓库内的插件目录。保留完整的 workbench 工作树，Host 会同时加载其中的桥接、内核和资源模块。需要独立安装的发布包由 T82 交付。
3. 在同一个 DSH 会话中打开侧栏 Sand Table。插件通过本地 MCP bridge 连接**浏览器正在使用的同一个服务**，不再独立启动一个拥有过期快照的内核。

插件配置（写在 DSH 插件行的 `config`）：

| 键            | 默认值                            | 用途                                                |
| ------------- | --------------------------------- | --------------------------------------------------- |
| `boardUrl`    | `http://127.0.0.1:4173/embed`     | 可嵌入的本地工作台                                  |
| `serverEntry` | 相对插件目录 `../local/bridge.ts` | 共享工作台 MCP bridge；可指向完整工作台中的绝对路径 |
| `sessionFile` | bridge 自己的默认连接描述文件     | 自定义启动 `--session-file` 时必须在此指定相同路径  |
| `nodePath`    | `process.execPath`                | Node 可执行文件                                     |
| `timeoutMs`   | `20000`                           | MCP 请求超时                                        |

`workspaceDir` / `workspaceId` 由工作台启动参数控制，不再用于启动第二个内核。不要将 `serverEntry` 指向 `server/main.ts`；那会重新产生两个互不共享的运行期。

## 数据与任务通道

- Agent 读工具：`sand_table_list_boards`、`sand_table_read_board`、`sand_table_read_object`。
- `sand_table_edit_space`：沿用内核校验、revision 冲突和撤销机制修改组件／布局／关系，不修改真实文件。
- 会话命令 `/sand-table`：`capabilities`、`list_boards`、`read_board`、`read_object`、`submit`、`status`、`cancel`。
- 任务 ID 就是 DSH `sessionController.prompt` 的 `requestId`。按持久用户消息的 `source.rpcId` 关联真实轮次，只接收该任务的回复与插件结果。
- 宿主具有 prompt 和 session/event 通道时才声明任务能力；缺失时隐藏画布对话输入。
- 请求携带 boardId、对象引用与版本；Agent 应先读取最新内容。
- 客户端查询真实事件并转发画布；普通 assistant 回复只显示在协作对话中，不自动创建便签。当前兼容通道只把识别到的结构化工具产物写入内容对象；明确要求创作正文时，Agent 应调用白板编辑工具。未提供指纹的文献不会伪装为已验证引用；原始来源仍保留。
- `cancel` 只取消该任务正在执行的宿主轮次，避免取消无关会话任务。收到取消回执不等于完成，等待实际 `turn/end`。
- 跨源消息验证窗口和 origin。请求有超时，断开时明确显示失败。

## 验证边界

已提供：插件清单／语法测试、真实 requestId 和事件关联测试，以及 `npm run test:host` 跨源浏览器集成测试。后者运行真正的本地服务、Host 插件、Client 插件与嵌套画布，DSH 执行器由按官方 API 形状实现的脚本夹具驱动；验证回复留在对话、表格落板、追问与取消。

## 插件组合迁移

正式方向见 [DSH 插件组合契约](../../docs/kernel-v3/06-plugin-composition.md) 和 [复用清单](../../docs/kernel-v3/07-plugin-reuse.md)。T77 验证了固定版本的本地链接。T79 已把会话关联与任务状态交给 DSH 持久记录，作品由 Host 写入白板并核对回执。

组合界面的官方槽位、真实模型和第三方插件执行由 T66 在实机验收。若目标 DSH 的 API 变化，应重新检查 `sessionController.prompt/cancel`、`session/event`、`sidebar.panellist` 和 `main`。

### 原生资源提供者

DSH 插件注入 `sandTableResources` 后，在自己的生命周期中注册能力：

```js
ctx.effect(() => ctx.sandTableResources.register(provider));
```

`provider` 遵循 `workbench/resources/types.ts`，按 `providerId + namespace` 隔离。read/open 必须自行验证权限并返回实际版本；固定版本不可读须返回 version_unavailable，不能回退当前版。注册表不加载插件、不保存资源正文。白板保存的 ObjectSource.resource 是唯一绑定；UI 预览与 sand_table_read_object 在读取前后核对本地引用版本。

默认白板提供者复用 MCP/内核；外部提供者停用后显示缺失并保留本地说明。原生编辑适配的幂等范围目前为 process，未知结果不自动重试。完整组合分发与跨重启操作确认分别由 T82/T79 验收。


### 白板会话恢复

恢复接口已按 `@deepseek-ai/dsh-session@0.2.2-rc.1` 验证。CLI 安装从当前 DSH 解析会话模块，其他宿主须提供清单中声明的 peer。请将 `workspaceDir` 指向本地工作台的实际存储目录。白板使用 DSH 选中的会话接收请求并查询历史。停机后回到原 DSH 会话可读已保存记录。若作品处于「待核对」，选择「核对交付」查询原事务回执。

真实 DSH 的隔离重启验证可从 `workbench/spikes/dsh-providers` 运行 `node verify.mjs --workbench-recovery`。脚本驱动事件及产物，使用真实 DSH 日志、投影和白板数据库。

### 绘图提供者

绘图的固定组合为 DSH `0.2.2-rc.1` 和 `dsh-diagram@0.6.1-sand-table.1`。兼容包沿用上游 MIT 许可及 Excalidraw 第三方许可，生成时校验上游 npm 制品 SHA-256。补丁保留上游的会话校验、储存和画布，补充精确图稿深链接及一次写入的可编辑导入。源码见 [dsh-diagram v0.6.1](https://github.com/hanzhangzzz/dsh-diagram/tree/v0.6.1)。

从源码部署时，在 `workbench/` 运行下面的命令，并在同 profile 启用已连接本地工作台的 Sand Table 插件。

```bash
node dsh-plugin/drawing/prepare.mjs artifacts/drawing
dsh plugin --profile web add "$PWD/artifacts/drawing/dsh-diagram-0.6.1-sand-table.1.tgz"
```

用 `diagram_create` 创建图稿，在 DSH 绘图编辑器手动修改后，用 `diagram_read` 读取保存内容和实际版本。`sand_table_drawing_replace_label` 可以按读到的版本修改一个唯一匹配的文本标签。发生冲突时工具返回当前版本与候选文字。

将 `sand_table_drawing_reference` 返回的 `ref` 作为 `sand_table_publish_artifact` 的 `resource` 发布，可在发起任务的白板打开同一图稿。白板引用固定到交付时的版本。绘图插件只保留当前记录，若原图已编辑，请确认后交付新版本。复制引用卡的展示共享同一资源。执行 `sand_table_drawing_export` 和 `sand_table_drawing_import` 可以创建另一份可编辑图稿。导出的图稿只包含生成来源和当前场景。白板原有的工作区导出仍保留资源引用，组合导出见 T82。

停用绘图插件后，白板仍显示引用，重装回同一个 DSH profile 后可重新打开。永久删除图稿需要在 DSH 确认，并检查提交时版本。白板引用仍保留为失效状态。

隔离宿主检查使用 `npm run build`、`npm --prefix spikes/dsh-providers ci` 和 `CHROMIUM_PATH=/path/to/chromium node --experimental-strip-types dsh-plugin/drawing/verify.mjs`。验证自动化使用固定版本真实插件和 Chromium，Agent 调用由脚本驱动。
