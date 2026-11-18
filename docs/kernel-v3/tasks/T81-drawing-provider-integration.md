# T81 外部绘图插件与白板资源联通

| 项 | 内容 |
|---|---|
| 执行 | minimax |
| 依赖 | T54、T80 |
| 分支 | `task/T81-drawing-provider-integration` |

## 目标

接入 T54/T77 选定的现成绘图提供者，完成生成、人工编辑、Agent 读取、白板引用、恢复、复制与资源导出。

## 先读

`AGENTS.md`、`05-delivery-contracts.md`、06 §3/6/7、07、T54/T77 ADR、T78–T80 公开接口、目标绘图插件的精确源码。

## 可改文件

- 新建 `workbench/resources/providers/drawing.ts`，dsh-plugin 注册/配置、资源视图及挂载点。
- 仅在 T54 明确范围新增 adapter 或固定版本 fork/patch；注明许可证、来源、构建方式。
- 资源/浏览器测试、07、插件 README、资源导出接口文档。

## 做法

1. 使用公开扩展点，绘图正文留在绘图提供者；白板存资源引用和展示布局。创建语义 spec 不与手工改后的 scene 并列为当前文档。
2. 创建、人工保存、Agent read/修改均返回实际 revision；冲突保留草稿/候选。
3. 第一版为完整图形资源；无稳定元素 API 不提供元素级选区。图形箭头不自动成为事实关系。
4. 验证停用保留引用、重装恢复、会话重开/分叉；共享引用和独立副本有明确入口，无复制能力时禁用。
5. 精确版本 export/import 缺口由授权 adapter 补齐；完整导出不支持明确失败，引用清单可单独提供，不伪称多媒体支持。

## 验收

- 固定真实 DSH/插件：Agent 生成图 → 人工改标签 → Agent 读到新标签/版本 → 继续修改 → 白板引用同一资源。
- 重开、Host 重启、删除、停用/重装、并发冲突、共享/独立复制；原始资源导出再导入仍可编辑。
- 计划检查、format:check、typecheck、npm test、build、test:host；07 只更新实际通过项。
