# T72 组件资源加载、worker 与宿主运行适配

| 项 | 内容 |
|---|---|
| 执行 | minimax |
| 依赖 | T41 |
| 分支 | `task/T72-component-runtime` |

## 先读

- `AGENTS.md`
- `docs/kernel-v3/05-delivery-contracts.md`
- 本卡依赖任务的交付接口和对应测试

## 目标

把 ADR 0002 从技术验证落到正式构建和宿主，提供后续组件可调用的资源加载器。

## 先读补充

- `docs/adr/0002-bundle-loading.md`
- `workbench/vite.config.ts`、`scripts/build-host.ts`、`server/server.ts`、`local/client.ts`、`dsh-plugin/`

## 可改文件

上述构建/宿主文件；新建 `workbench/board/runtime/resources.ts`；`package.json`/lockfile；新建 `tests/component-runtime.test.ts`、`tests/host-browser.ts`、对应脚本和 CI。

## 做法

1. 实现 `loadComponentResource(name, signal)` 和 `createPdfWorker()`，资源名只来自构建 manifest，不接受任意 URL；成功缓存、失败可重试、切换工作空间取消旧请求。
2. 按 ADR 选定方案统一打包，不允许每张组件卡自行放宽 CSP。内联回退也必须有同一接口；worker 生命周期由使用者释放。
3. 为 host/browser 夹具注册统一脚本 `test:host`；测资源缺失、加载失败、重复加载、离线、worker 释放；产物体积阈值写入构建检查。
4. 在本地宿主实测并记录实际测过的其他宿主；没有设备的宿主列未测，不阻断可验证的本地交付，也不宣称兼容。

## 验收

format:check、typecheck、npm test、test:host、build 通过；PDF fixture 可读取页；断网后内置组件仍可打开；CSP 没有新增任意网络/unsafe-eval；生成主包/chunk 的原始与 gzip 体积报告并检查 ADR 预算。

