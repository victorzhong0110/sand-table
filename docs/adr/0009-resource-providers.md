# ADR 0009：资源引用与提供者接入

日期：2026-11-17。责任卡：T78。依赖：T77 / PR #103。

资源身份保存在 ObjectSource.resource；白板原生对象继续由 kernel 管理。base.resource_reference 的 data 只含 note，外部摘要按需读取，不落成正文副本。旧 source.external 仍可读；双绑定、越界字段、导入损坏引用都会拒绝。来源修改使用 object.update、expectedVersion 和现有历史；T25 往返保留 ResourceRef，不执行插件代码。

默认白板提供者在 MCP 服务中注册，以存储根哈希 + 工作空间区分实例。read/open/edit 复用 kernel；精确历史版本不可读返回 version_unavailable。edit 使用 operationId + expectedRevision，在本次提供者实例中去重，明确标记 idempotency=process。未知结果没有自动重试，重启后的确认仍属 T79。

DSH 适配通过原生 ctx.provide / ctx.effect 暴露 sandTableResources，供外部 native 插件注册其资源能力。白板原生资源读写转发给 MCP 默认提供者。声明式数据包不能注册宿主能力。界面与 sand_table_read_object 从已保存的引用解析相同版本；异步前后核对本地对象与工作空间。停用不删引用，重装可恢复；订阅和 iframe 请求带生命周期保护。UI 当前使用 5 秒预览轮询，打开原生资源可定位其展示；它不承诺通用的远程编辑器或图形共同编辑。

## 验证

- 全量 npm test：483 通过，3 项外部夹具跳过；后续资源/桥接/声明/插件定向回归通过。
- format:check、typecheck、build、76 张任务卡计划检查通过。
- 固定 DSH 0.2.2-rc.1 的真实 web Host：资源服务注入、提供者注册、Agent 工具解析、停用后 provider_missing、重装恢复通过。提供者是脚本夹具，不计真实绘图场景。输出见 resource-services-2026-11-17.json。
- 新增 test:blank 场景：本地说明、原生预览/打开、缺提供者、固定版本不可读。Cloud 缺默认 Playwright 浏览器；显式使用系统 Chromium 后因 Unix socket 权限失败。Mac 设备离线，组合 UI 仍需实机验证；本 PR 的界面回归交由 CI 检查。
- 更正 ADR 0008：ctx.slots 是 SlotRegistry，保留 inject。已加载精确发布包的客户端工厂核对，保留 11-16 原始证据；不因此改写现有槽位调用。

## 剩余边界

真实模型、真实第三方绘图资源、Desktop、Host 重启后的工作区绑定与产物去重、完整组合导出和自足安装包仍按 T79–T82 / T66–T69 验收。提供者必须自行验证读取与编辑权限，保存引用不授予访问权。现有插件包依赖仓库相对文件，尚不作为独立发布包交付。
