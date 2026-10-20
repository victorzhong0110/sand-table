# problems.md｜修不掉的问题清单

> 维护约定：出现**多轮尝试仍解决不了**的问题就记在这里，一条一个条目，写清症状、复现、
> 已试过什么、影响面、建议方向。解决后**不要删**，改成「已解决」并写清怎么解决的——
> 这份清单的价值一半在问题本身，一半在"哪些坑已经踩平了"。
>
> 最后更新：2026-10-20

---

## P-001｜沙箱内跑不了浏览器端验收，浏览器断言只能靠 CI

**状态**：环境限制（长期存在，非代码缺陷）

**症状**
- `workbench/tests/blank.ts`、`tests/browser.ts`、`tests/local.ts`、`tests/full.ts`
  都需要真实浏览器（Playwright + Chromium）。
- 本地执行直接失败：Playwright 的 Chromium 下载被网络挡在 CDN，提示 `file load failed` 一类错误。
- 结论：**这些测试的通过与否，本地无法判定**，只能以 CI 结果为准。

**已试过什么**
- 换镜像源、换下载源：均被拦。
- 用 `curl` 直接拉浏览器二进制：同样不可达。
- 绕开浏览器只跑 Node 层断言：能覆盖内核，但覆盖不到渲染、交互与布局。

**影响面**
- 改到 `board/**` 的任何一行，都必须等 CI 才能知道有没有打破界面行为。
- 排查界面问题只能靠「在测试里加诊断输出 → 推到 CI → 读日志」，来回一轮约十几分钟。

**建议方向**
- 若长期如此，值得在仓库里放一份 `docs/TESTING.md`，写清哪些测试本地能跑、哪些只能靠 CI，
  免得下次有人把「本地跑不起来」误判成代码坏了。
- 或者引入一个能在容器里跑的无头浏览器镜像（需要 CI 环境配合，本仓库单靠自己做不到）。

**相关**：见 `docs/architecture/dsh-integration.zh-CN.md` 的「未验证项」。

---

## P-002｜DSH 插件包无法在本仓库内做真机验证

**状态**：环境限制 + 宿主侧待确认（不是代码缺陷，但会影响交付可信度）

**症状**
- `workbench/dsh-plugin/` 按 DSH 官方 bundle 规范写（Host 半、Client 半、清单、locale、图标），
  但本沙箱**没有安装 DSH**，也没有浏览器，因此：
  - 插件能不能被 `plugin_manager` 的 `install_bundle` 装上——未验证；
  - 侧栏入口、画布承载槽位在真实 DSH 里长什么样——未验证；
  - Host 半代理 MCP 工具时，Agent 侧能不能真的看到这些工具——未验证。

**已试过什么**
- 查了 DSH 官方仓库的插件开发文档与槽位目录，确认了机制（Host 半 `apply(ctx)`、
  Client 半 `ctx.slots.inject/register`、槽位基数与优先级规则），据此写了符合规范的包。
- 沙箱内只做到：`node --check` 语法可解析、清单结构自检（导出项、files、locale 元数据、图标）。

**影响面**
- `workbench/dsh-plugin/` 的**结构**可信，**运行**未验证。
- issue #18 的阶段 C（真正的白板任务入口）无法在本地端到端跑通。

**已查证的部分（源码层面，2026-10-20）**
- 装载路径：bundle + profile；清单字段 `dsh.bundle.patch` / `dsh.profile.bundles` /
  `dsh.client.{platform,inject,immediately,external}` / `engines.dsh`。
- 挂点：`sidebar.panellist`（list/root）+ `main`（keyed/root），**两个 id 必须一致**。
- Agent 工具：`ctx.tools.register(defineTool(...))`，注册即进系统提示的 schema 汇总。
- 会话命令：`ctx.commands.register({name, description, input?, handler})`。
- iframe 的 CSP：DSH 外壳不设 `frame-ancestors`，**插件自己管**。

**建议方向**
- 在一台装了 DSH 的机器上按 README 装一次，重点验三件事：
  1. `install_bundle` 能否装上（清单与 patch 语法，空 patch 会导致启动失败）；
  2. 侧栏图标与主面板是否成对出现（id 不一致则点开是空白）；
  3. Host 半暴露的 Agent 工具在 DSH 的 Agent 侧是否可调用。
- 完整依据见 `docs/architecture/dsh-integration.zh-CN.md` §1 与 §7。

**相关**：`docs/architecture/dsh-integration.zh-CN.md`
