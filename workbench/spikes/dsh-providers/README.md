# DSH 提供者验证

固定 DSH `0.2.2-rc.1`，需要 Node `>=24.9.0`。这是技术验证目录，不参与产品构建；依赖与 lockfile 独立。结论见 [ADR 0008](../../../docs/adr/0008-dsh-provider-matrix.md)。

在仓库根目录准备已有白板运行依赖与构建，然后安装本目录的固定依赖：

```sh
cd workbench
npm ci
npm run build
cd spikes/dsh-providers
npm ci --ignore-scripts --no-audit --no-fund
```

逐项运行：

```sh
npm run test:api
npm run test:persistence
npm run test:host
npm run test:install
```

| 命令 | 验证什么 |
|---|---|
| test:api | 检查发布版 SlotCore，明确当前白板客户端旧接口需适配；通过表示正确识别缺口 |
| test:persistence | 两个真实 CLI sdk-minimal 进程，JSONL 冷读、单写者、只读、投影/快照/重注册、消息重建 |
| test:host | 真实 CLI web、真实上下文 Host、真实白板插件与 MCP/本地服务，工具直接创建/读回便签；不调用模型 |
| test:install | 独立 profile，用固定 pnpm 安装/卸载/重装上下文插件、链接白板插件，并断言绘图旧版被拒绝 |

每次运行新建自己的临时 DSH_HOME，不连接用户现有会话。探测产生的会话、白板与文件均位于临时目录；脚本退出时清理。不改全局 Node/DSH 安装或凭据。安装测试需要 npm registry 网络；其他命令使用已安装包与本地服务。

`probe.mjs` 是加载到真实 DSH 的最小插件，`verify.mjs` 只负责启动/关闭该宿主；没有在脚本里拼装另一个 Cordis 树。`web-probe.mjs` 在 Host Loader 激活完成后核对服务，避免 preset 的自等待死锁。产出的 checks 任一失败都会非零退出。

本目录的 evidence 是本次实际输出。基础 Mac UI 只证明核心界面可渲染；插件组合 UI、真实模型、Desktop、实际压缩/公网搜索均未测。白板客户端 slots 不兼容和绘图安装拒绝是适配前置条件，不能因为探测脚本通过就把它们改记为产品验收通过。
