# T80 空间选区与跨资源上下文

| 项 | 内容 |
|---|---|
| 执行 | minimax |
| 依赖 | T79 |
| 分支 | `task/T80-spatial-resource-context` |

## 目标

让“左边一组”“这个箭头”“只改选中的三个节点”有可验证的空间与资源上下文；通用计量、压缩和检索由 DSH 插件提供。

## 先读

`AGENTS.md`、`05-delivery-contracts.md`、06 §4、T77 ADR、T78/T79 公开接口、workbench 下 board/ai/context、kernel/read、server 上下文工具、dsh-plugin/index。

## 可改文件

- `workbench/board/ai/context.ts`、目标预览、HostTask 类型、dsh-plugin 上下文适配。
- resources 读取适配、现有 kernel 读接口及 server 工具/导出；02/04 对应契约。
- whiteboard-ai、host-transport、host-browser 与空间选择夹具。

## 做法

1. 固定展示/对象身份及各自版本、board/view、坐标尺寸、分组和关系；正文按对象去重，展示与空间信息保留。
2. 外部资源附 ResourceRef/实际版本，权限内按需读摘要。空/失效选区拒绝，不扩大为全板；超过 200 目标拒绝，有界扩展说明遗漏。
3. 用 T77 验证的持久输入机制提供上下文，不重写通用压缩/计量；全文按需读取。
4. 用户能查看本轮目标/版本。提交后移动/切板/资源更新不改快照；写入仍核对版本，选区不授予外部执行权限。

## 验收

- 同对象多展示的正文去重而位置不丢；分组/箭头、子板、外部不可用、精确版本失效、200 上限。
- 提交后移动/删除/切板和并发改动仍保留输入；压缩/恢复后能定位实际上下文。
- 计划检查、format:check、typecheck、npm test、build、test:host；真实 DSH 中记录输入，不能靠模型自报证明传递成功。
