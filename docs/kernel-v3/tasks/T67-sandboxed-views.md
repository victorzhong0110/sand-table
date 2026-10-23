# T67 二级扩展：沙箱里的自定义视图

| 项 | 内容 |
|---|---|
| 执行 | minimax |
| 依赖 | T40、T39、T55 |
| 分支 | `task/T67-sandboxed-views` |

## 目标

数据包可以带自己的视图代码（HTML + JS），在隔离的 iframe 里运行，只能读自己对象和已绑定对象的数据、只能修改自己这个对象。恶意或写坏的视图不能联网、不能碰宿主页面、不能改别的对象、资源隔离能力按 T54 真机证据决定；未证明 CPU 隔离的宿主禁用第三方代码视图。

## 先读

- `AGENTS.md`
- `docs/kernel-v3/05-delivery-contracts.md`（本阶段公共契约与交接规则）
- `docs/kernel-v3/03-types-and-extensions.md` §5.2、§6、§7、§9（**消息协议以 §7 为准**）
- `docs/adr/0005-design-and-export.md`（原型沙箱的实测结论，本卡沿用）
- `workbench/kernel/registry.ts`（目前拒绝数据包声明 `display.view`）
- `workbench/board/views/bindings.ts`（T40）、`workbench/board/design/sandbox.ts`（T55）

## 开工前核对

确认 `03` §7 的消息协议未被修改；T55 的沙箱工具可复用。依赖未完成则等待；机械差异按 05 §1 适配，语义冲突只暂停受影响部分。

## 可改文件

- `workbench/kernel/registry.ts`、`workbench/kernel/pack-schema.ts`（允许数据包声明 `views`，并允许 `display.view` 引用**本包**的视图；视图 HTML 总大小上限 512 KB）
- `docs/kernel-v3/03-types-and-extensions.md`（§6 规则改为“`display.view` 只能引用本包 `views` 里的名字”）
- 新建 `workbench/board/views/SandboxedView.tsx`、`workbench/board/views/sandbox-protocol.ts`
- `workbench/board/views/registry.ts`、`workbench/board/packs/PackManager.tsx`（安装时提示）
- 新建 `workbench/tests/sandboxed-view.test.ts`，修改 `workbench/tests/blank.ts`、`workbench/tests/kernel-registry.test.ts`

## 不要做

- 不给视图开放任何工具调用、SQL、网络或文件访问。
- 不允许视图修改自己以外的对象，也不允许它建关系。

## 做法

1. **iframe**：`sandbox="allow-scripts"`（不加 `allow-same-origin`），`srcdoc` 注入视图 HTML 并在 `<head>` 前加 CSP：`default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:`。
2. **协议**（`sandbox-protocol.ts`）：按 `03` §7 实现 `sand.init`、`sand.update`、`sand.dispatch`、`sand.result`，另加 `sand.readBindings`（转给 T40 的 `Bindings.read`，按声明逐次校验）。每条消息校验：来源是这个 iframe 的 `contentWindow`、类型在白名单里、`requestId` 是字符串、大小不超过 256 KB。`sand.dispatch` 只放行目标为本对象的 `object.update`。
3. **资源限制**：视图 5 秒内没有回应 `sand.init` 的确认，或任意滚动 1 秒窗口内消息超过 100 条，就停止并显示“这个视图没有响应，已停用”，提供“改用通用视图显示”。
4. **安装提示**：导入带 `views` 的包时，包管理里写明“这个包包含可运行代码，可读取声明绑定的数据，只能修改自身组件；运行隔离能力取决于当前宿主”，用户确认后才启用。

## 验收

- `workbench/tests/sandboxed-view.test.ts`：消息校验（来源、类型、大小、跨对象写入被拒）。
- `workbench/tests/kernel-registry.test.ts`：数据包 `display.view` 引用本包视图通过；引用不存在的视图或内置视图名被拒。
- `workbench/tests/blank.ts`，用几个测试视图：
  1. 正常视图能显示数据并通过 `dispatch` 改自己的字段。
  2. 试图 `fetch`、读 `parent.document`、改别的对象：全部失败，白板正常。
  3. 仅在 T54 已证明可强制终止的隔离宿主上测死循环；其他宿主验证第三方代码不能启动、通用视图可用，记录能力受限，不能算完整代码扩展验收。
- `npm run format:check`、`npm run typecheck`、`npm test`、`npm run test:blank` 全部通过。

## 交接与边界验收

只能在 05 §6 已验证隔离能力与本地明确许可下启用；错误/未知能力退回通用视图。消息含 sand.ready 确认，readBindings 逐次服务端授权，不能直接给第三方 arbitrary ID 读权限。
