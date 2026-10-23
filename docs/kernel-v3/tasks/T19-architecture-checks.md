# T19 架构检查边界

项目所有者授权修复PR #50边界问题。范围：tests/architecture.test.ts、T16规格。不加依赖，使用现有TypeScript。

防止./../逃逸和ajv前缀误放行，允许内核内部上级相对引用；真实AST导入不误读正文代码；包裸依赖显式检查，扫描TSX与SQL OR变体。

验收：原六条检查与新探针、format/typecheck/npm test。
