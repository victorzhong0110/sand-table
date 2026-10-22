# T06 锁冲突后的事务重试

项目所有者要求修复本轮 PR 审查发现的问题。

范围：`workbench/kernel/db.ts`、`workbench/tests/kernel-db.test.ts`。

开始事务失败也必须清除连接上的嵌套标记；只有成功开始过的事务才回滚。保留原始异常，不重试业务回调。

验收：两个真实 SQLite 连接争锁，首次失败后释放锁，同一连接可再次提交；回调异常回滚后仍可再次提交。运行 format:check、typecheck、npm test。
