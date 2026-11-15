# T78 资源契约与默认白板提供者

| 项 | 内容 |
|---|---|
| 执行 | minimax |
| 依赖 | T77 |
| 分支 | `task/T78-resource-provider-contract` |

## 目标

实现 06 §3 的资源引用与提供者注册；现有 kernel 成为默认白板提供者，外部正文由外部插件管理。

## 先读

`AGENTS.md`、`05-delivery-contracts.md`、06/07、T77 ADR、`kernel/types.ts`、来源 Schema/命令/读/导入导出调用点、`packs/base/`、`board/views/`、`server/app-tools.ts`（代码均在 workbench 下）。

## 可改文件

- 新建 `workbench/resources/{types.ts,registry.ts,board-provider.ts}`；dsh-plugin 注册适配。
- kernel 共享类型、来源校验/命令/导出、packs/base；server 来源适配、board/data-client、资源引用视图及挂载点。
- 01/02/03 的 ResourceRef、ObjectSource 与来源操作契约；来源/导入导出/资源测试。

## 做法

1. 契约独立于运行库，DSH 注册使用 T77 接口。资源身份、namespace、版本和 unavailable 分类严格按 06。
2. ObjectSource.resource 为唯一绑定；同步元 Schema、创建/更新/导入导出，拒绝 resource/external 双绑定。来源修改走同一命令、expectedVersion 和历史；必要时扩展命令并补 02，不开旁路写库。
3. 注册 base.resource_reference、只读预览/打开与能力提示；data 不复制引用或正文。卸载保留数据，重装恢复。数据包不能注册宿主 provider。
4. 默认 provider 复用 kernel 读写/历史；精确历史版本不可读返回 unavailable。registry 只管理注册/dispose；图形具体适配留 T81。

## 验收

- 字段上限、缺省旧数据、双绑定拒绝、namespace 隔离、精确版本失效行为测试。
- 原生/引用对象保存重开、撤销、T25 往返保留身份；缺提供者保留本地说明，导入不执行代码。
- 卸载/重装、过期响应、工作区切换释放订阅；Agent/UI 同源同版本。
- 计划检查、format:check、typecheck、npm test、build、test:blank。
