# T41 技术验证：界面体积预算与按需加载

| 项 | 内容 |
|---|---|
| 执行 | grok |
| 依赖 | T30 |
| 分支 | `task/T41-bundle-loading-spike` |
| 类型 | 技术验证。产出决策记录，不改产品代码 |

## 要回答的问题

白板界面目前被打包成**一个 HTML 文件**，作为 MCP App 资源发给宿主，本地模式下用 `srcdoc` 装进 iframe，CSP 是 `default-src 'none'; script-src 'unsafe-inline'`。Phase 4 要加富文本编辑器、PDF、图表库，每个都可能有几百 KB。需要回答：

1. 当前 `board.html` 多大？React Flow 接入后多大？
2. 在这套 CSP 和宿主条件下，能不能**按需加载**大组件的代码？候选做法：
   - A：全部内联，只靠体积预算控制；
   - B：把大组件打成单独的 `ui://sand-table/chunks/<名字>.js` MCP 资源，界面需要时通过宿主读取资源，再以内联 `<script>` 注入；
   - C：其他你找到的做法。
3. B 在本地宿主、Claude 桌面版、至少一个其他支持 MCP Apps 的宿主里是否都能工作？哪些宿主会拦截？
4. pdf.js 的 worker 在这种环境里怎么跑？

## 先读

- `AGENTS.md`
- `workbench/vite.config.ts`、`workbench/scripts/build-host.ts`、`workbench/server/server.ts`（UI 资源注册）、`workbench/local/client.ts`（`srcdoc` 与 CSP）
- `docs/kernel-v3/00-decisions.md` K8

## 可改文件

- 新建 `docs/adr/0002-bundle-loading.md`（决策记录）
- 新建 `workbench/spikes/bundle-loading/`（验证用的最小代码，不参与构建和测试）
- `workbench/tests/architecture.test.ts`：**只**把 `"spikes"` 加进 `listSourceFiles` 跳过的目录名列表（与 `node_modules`、`dist`、`artifacts` 并列），让后续所有技术验证代码不受架构规则约束。不做其他修改。

## 不要做

- 不修改产品代码、不改构建配置、不加依赖到 `workbench/package.json`（验证代码可以有自己的临时依赖，但不提交 `node_modules`）。

## 交付

`docs/adr/0002-bundle-loading.md`，包含：

1. 实测数据：当前与接入 React Flow 后 `board.html` 的原始和 gzip 体积。
2. 每种做法在每个宿主里的实测结果（能 / 不能 / 未测及原因），附复现步骤。
3. 结论：选哪种做法；Phase 4 的体积预算（主包上限、每个按需块上限）；pdf.js worker 的做法。
4. 给 T42–T56 的约束：每个组件实现卡必须遵守的规则（例如“新依赖 gzip 超过 50 KB 必须走按需加载”）。

架构负责人审过这份记录、合并后，Phase 4 的实现卡才开工。
