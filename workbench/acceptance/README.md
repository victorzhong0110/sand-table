# 验收材料工具

为规划 D19／D20／D29 准备可审阅材料，不运行模型，不自动给产品打通过分，也不向外部仓库提交内容。输出放在独立验收目录；不能把 private/ 给求解 Agent 或评分者。

## 封存新任务

由没有参与求解的出题者提供 JSON：

~~~json
{
  "repository": "https://github.com/owner/external-repo",
  "baseCommit": "完整40位提交",
  "task": "可观察的问题和预期行为，不包含答案",
  "setup": "固定依赖、环境和测试命令",
  "constraints": "可改范围、预算和禁止读取的材料",
  "license": "代码与题目来源许可",
  "publicDate": "原始问题公开日期",
  "contaminationDisclosure": "已阅读内容、公开答案可能被模型见过的风险",
  "criteria": [
    {"id":"behavior","description":"独立回归验证通过","weight":2},
    {"id":"explanation","description":"维护者能理解理由与边界","weight":1}
  ],
  "reference": "历史 PR 或参考答案，只给组织者",
  "graderNotes": "独立检查与评分锚点，只给评分者"
}
~~~

~~~bash
npm run acceptance -- seal /absolute/task-input.json /absolute/new-sealed-task
~~~

solver/task.json 只有题目、版本、约束和预注册标准；private/seal.json 保存参考材料。摘要用于核对材料；这是流程隔离而非加密，不能证明模型没见过公开答案。不要把占位 JSON 当成外部题库。

clsx 和 Hugging Face 已用于开发，不能充当未读答案的新题。历史 PR 仅作参考，不要求复现同一补丁。

## 分配交互条件

输入包含 operators 和 tasks 两个字符串数组，至少两位操作者和两道匹配任务。

~~~bash
npm run acceptance -- assign /absolute/assignment-input.json
~~~

每个操作者只在一个条件下做同一道题，避免记住解法后重复。生成交叉条件；组织者仍需固定模型、材料、权限、时间、token 预算，记录代码经验并平衡顺序。先用独立练习题熟悉界面。

## 匿名产物

每份候选准备原始 git diff（不含作者邮件头）和单独维护者说明。输入：

~~~json
{
  "taskDigest": "封存摘要",
  "candidates": [
    {"patch":"/absolute/a.diff","explanation":"/absolute/a.txt","condition":"board","operator":"甲"},
    {"patch":"/absolute/b.diff","explanation":"/absolute/b.txt","condition":"chat","operator":"乙"}
  ]
}
~~~

~~~bash
npm run acceptance -- blind /absolute/candidates.json /absolute/new-blind-review
~~~

只给评分者 review/；private/key.json 保留到评分冻结以后。工具随机化顺序和 ID，不会理解或移除文字中的身份线索，需人工抽查。与参考相似不等于正确，必须独立验证行为。

## 冻结评分

输入 task 为封存 task.json 内容；reviews 每条包含 candidateId、taskDigest、scorer、scores（各标准 0–4）、evidence，不含 condition。评分锚点：0 未完成／错误，1 重大缺口，2 部分达成，3 达成且有依据，4 达成且边界与回归充分。

~~~bash
npm run acceptance -- score /absolute/scores.json
~~~

工具计算加权均分，拒绝重复评分者、错误摘要、越界分数。它不执行隐藏测试；由隔离环境和独立验收者运行，把命令、版本和输出写入证据。评分冻结后揭盲，比较完成质量、时间、理解和求助次数，报告失败与缺失；不从小样本推导泛化结论。

真人路径见 [HOST_ACCEPTANCE.md](../docs/HOST_ACCEPTANCE.md)。首次使用任务检查能否理解入口和数据流、指出依据与未知项、表达并审核小改动；不能只问“好不好看”。记录首次成功时间、错误、求助、能否复述架构及修改影响。

本工具测试只证明材料隔离和评分计算，不证明评估已经执行。
