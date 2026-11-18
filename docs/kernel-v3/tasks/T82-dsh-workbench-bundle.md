# T82 可安装工作台组合与跨插件验收

| 项 | 内容 |
|---|---|
| 执行 | minimax |
| 依赖 | T81 |
| 分支 | `task/T82-dsh-workbench-bundle` |

## 目标

将验证过的插件、adapter 和工作台组成可安装 bundle；旧白板无损打开，跨资源任务可以恢复。

## 先读

`AGENTS.md`、`05-delivery-contracts.md`、06/07、T77/T54 ADR、T78–T81 接口、dsh-plugin 清单/构建、T25、T66/T69。

## 可改文件

- `workbench/dsh-plugin/` bundle/client、固定清单/lockfile、构建/打包脚本、默认提供者注册。
- 新建组合导出 manifest、服务/界面入口，复用 provider export/import；保留 T25 原有格式。
- 根/插件 README、07、T66/T69；安装/生命周期/迁移/浏览器测试及 CI。

## 做法

1. 用 DSH profile/bundle 声明默认/可选提供者及依赖；发布包含完整运行文件，不能依赖安装目录外的相对 bridge。
2. 工作台经 slots/公开服务装配；React Flow/本地 MCP 继续可用，缺提供者或只读按实提示；不复制插件管理和凭据界面。
3. 旧工作区不批量重写，按 T78 兼容来源；切换清理订阅与草稿归属。
4. 独立组合导出按 06 §7 收集精确资源版本/manifest；缺字节完整模式失败，主动选引用清单才省正文。导入不执行/安装插件。
5. 安装升级卸载服从 DSH 生命周期；产物保留，恢复不会执行旧工具。

## 验收

- 干净 home 安装预构建包，入口/Agent 工具/provider 可用，不依赖源仓库目录。
- 旧白板编辑、撤销、保存重开及原有 T25 往返通过。
- 06 §8 场景：框选实验和图形、比较更新、执行中关页面、恢复后状态/版本/来源正确，无重复任务或产物；真实模型/人工观察写入 T66/T69。
- 完整组合导出/导入、缺提供者/版本失败、引用清单、共享/独立复制和停用/重装分别记录。
- 计划检查、format:check、typecheck、npm test、build、安装检查、test:host、test:blank；未验证 OS/profile 单列。
