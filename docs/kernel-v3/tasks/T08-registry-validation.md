# T08 包声明校验

承接PR #51，范围：kernel/registry.ts、pack-schema.ts、tests/kernel-registry.test.ts。项目所有者授权本轮修复，不加依赖。

未知输入先经过包元Schema，再做语义检查；缺失字段、版本、数组成员、显示结构统一返回PackSpecError。Schema编译缓存按注册尝试隔离，失败不影响重试/升级；注册内容独立且只读。

验收：畸形输入、失败后同$id重试与升级、输入/返回值修改隔离；format/typecheck/npm test及原注册测试通过。
