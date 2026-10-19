// Scripted integration fixture, never loaded by the product or presented as a model response.
import type { Board, GuideDraft } from "../core/model.ts";
export function fixtureGuide(board: Board): GuideDraft {
  const clsx = board.objects.find(
    (o) => o.title === "clsx" && o.source?.path === "src/index.js",
  );
  const toVal = board.objects.find(
    (o) => o.title === "toVal" && o.source?.path === "src/index.js",
  );
  if (!clsx?.source || !toVal?.source)
    throw Error("Expected external clsx fixture.");
  return {
    title: "条件参数怎样组合成类名",
    purpose:
      "将字符串、数组与对象形式的条件参数整理为空格分隔的字符串。此讲解由测试脚本提供，用于验证交互。",
    inputs: '例如：clsx("button", {active: true}, ["large", false])',
    outputs: '按源码推导得到 "button active large"；本测试没有执行该函数。',
    agentId: "Protocol test client (scripted)",
    steps: [
      {
        title: "接收参数",
        explanation: "clsx 遍历 arguments，只把真值参数交给 toVal。",
        objectIds: [clsx.id],
        evidence: [clsx.source],
        uncertainty: "未执行输入示例；尚未验证所有 JavaScript 类型的边界行为。",
      },
      {
        title: "转换每个值",
        explanation:
          "toVal 保留字符串或数字，递归处理数组，对对象收集值为真的属性名。",
        objectIds: [toVal.id],
        evidence: [toVal.source],
        uncertainty:
          "语法关系不是运行时调用证明；原型属性与异常输入行为需要另行检查。",
      },
      {
        title: "组合结果",
        explanation: "clsx 在非空片段之间添加空格，然后返回字符串。",
        objectIds: [clsx.id],
        evidence: [clsx.source],
        uncertainty:
          "尚未运行行为测试；此步骤与第一步引用同一函数，不代表新增调用关系。",
      },
    ],
  };
}
