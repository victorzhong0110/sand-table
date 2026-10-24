// 科研内置包：假设 / 证据 / 结论与支持、反驳关系。
//
// 引用按页码定位并带内容指纹：citation 用 locator 控件，字段形状与内核的
// ExternalLocator 一致（kind、uri 必填，fragment、version、fingerprint 选填）。
// 支持与反驳都必须给依据（requiresBasis），推测关系另外还要有 basis。
//
// 字段限制从 v2 的 workbench/domains/research/index.ts 搬来；v2 的占位值不留。

import type { PackSpec } from "../../kernel/index.ts";
import { registerResearchTools } from "./tools.ts";

export const researchPack: PackSpec = {
  id: "research",
  title: "科研",
  version: 1,
  description:
    "假设 / 证据 / 结论与支持、反驳关系，引用按页码定位并带内容指纹。",
  types: [
    {
      type: "research.hypothesis",
      title: "假设",
      description: "一条可被证据支持或反驳的陈述。",
      icon: "question",
      version: 1,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          statement: {
            type: "string",
            maxLength: 500,
            "x-sand-label": "假设陈述",
            "x-sand-widget": "text",
          },
          scope: {
            type: "string",
            maxLength: 200,
            "x-sand-label": "适用范围",
            "x-sand-widget": "text",
          },
          testable: {
            type: "boolean",
            "x-sand-label": "可检验",
            "x-sand-widget": "boolean",
          },
          variables: {
            type: "array",
            maxItems: 30,
            items: { type: "string", maxLength: 200 },
            "x-sand-label": "涉及变量",
            "x-sand-widget": "tags",
          },
        },
      },
      display: {
        material: "paper",
        defaultSize: { width: 280, height: 180 },
        summary: ["statement", "scope"],
      },
    },
    {
      type: "research.evidence",
      title: "证据",
      description: "支撑或反驳某个陈述的一条材料。",
      icon: "quote",
      version: 1,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          summary: {
            type: "string",
            maxLength: 2000,
            "x-sand-label": "证据摘要",
            "x-sand-widget": "markdown",
          },
          method: {
            type: "string",
            maxLength: 200,
            "x-sand-label": "获取方式",
            "x-sand-widget": "text",
          },
          strength: {
            type: "number",
            minimum: 0,
            maximum: 1,
            "x-sand-label": "强度",
            "x-sand-widget": "number",
          },
          citation: {
            type: "object",
            additionalProperties: false,
            required: ["kind", "uri"],
            properties: {
              kind: {
                type: "string",
                enum: ["file", "git", "pdf", "url", "dataset", "symbol"],
                "x-sand-label": "来源类型",
                "x-sand-widget": "enum",
                "x-sand-enum-labels": {
                  file: "文件",
                  git: "Git 仓库",
                  pdf: "PDF",
                  url: "网页",
                  dataset: "数据集",
                  symbol: "符号",
                },
              },
              uri: {
                type: "string",
                maxLength: 2000,
                "x-sand-label": "来源地址",
                "x-sand-widget": "text",
              },
              fragment: {
                type: "string",
                maxLength: 200,
                "x-sand-label": "定位",
                "x-sand-widget": "text",
              },
              version: {
                type: "string",
                maxLength: 200,
                "x-sand-label": "版本",
                "x-sand-widget": "text",
              },
              fingerprint: {
                type: "string",
                maxLength: 200,
                "x-sand-label": "内容指纹",
                "x-sand-widget": "text",
              },
            },
            "x-sand-label": "引用定位（页码级）",
            "x-sand-widget": "locator",
          },
          quote: {
            type: "string",
            maxLength: 2000,
            "x-sand-label": "原文摘录",
            "x-sand-widget": "markdown",
          },
          status: {
            type: "string",
            enum: ["valid", "stale", "missing"],
            "x-sand-label": "引用状态",
            "x-sand-widget": "enum",
            "x-sand-enum-labels": {
              valid: "有效",
              stale: "已过期",
              missing: "已失效",
            },
          },
        },
      },
      display: {
        material: "paper",
        defaultSize: { width: 280, height: 180 },
        summary: ["summary", "status"],
      },
    },
    {
      type: "research.conclusion",
      title: "结论",
      description: "从假设与证据出发得到的判断。",
      icon: "check",
      version: 1,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          statement: {
            type: "string",
            maxLength: 500,
            "x-sand-label": "结论陈述",
            "x-sand-widget": "text",
          },
          confidence: {
            type: "number",
            minimum: 0,
            maximum: 1,
            "x-sand-label": "置信度",
            "x-sand-widget": "number",
          },
          scope: {
            type: "string",
            maxLength: 200,
            "x-sand-label": "适用范围",
            "x-sand-widget": "text",
          },
        },
      },
      display: {
        material: "paper",
        defaultSize: { width: 280, height: 180 },
        summary: ["statement", "confidence"],
      },
    },
  ],
  relationKinds: [
    {
      kind: "research.supports",
      title: "支持",
      inverseTitle: "被支持",
      allowsInferred: true,
      requiresBasis: true,
      sourceTypes: ["research.evidence"],
      targetTypes: ["research.hypothesis", "research.conclusion"],
    },
    {
      kind: "research.refutes",
      title: "反驳",
      inverseTitle: "被反驳",
      allowsInferred: true,
      requiresBasis: true,
      sourceTypes: ["research.evidence"],
      targetTypes: ["research.hypothesis"],
    },
  ],
  templates: [
    {
      id: "research.hypothesis_evidence",
      title: "假设—证据—结论",
      description: "一个假设、两条证据、一条结论，把论证链先摆出来。",
      commands: [
        {
          op: "object.create",
          ref: "hypothesis",
          type: "research.hypothesis",
          title: "假设",
          data: { statement: "提高剂量能缩短恢复时间", testable: true },
        },
        {
          op: "presentation.create",
          boardId: "$board",
          objectId: "@hypothesis",
        },
        {
          op: "object.create",
          ref: "positive",
          type: "research.evidence",
          title: "证据：阳性结果",
          data: { summary: "120 个样本中恢复时间显著缩短", method: "观察" },
        },
        {
          op: "presentation.create",
          boardId: "$board",
          objectId: "@positive",
        },
        {
          op: "object.create",
          ref: "control",
          type: "research.evidence",
          title: "证据：阴性对照",
          data: { summary: "对照组 20 例无显著差异", method: "观察" },
        },
        {
          op: "presentation.create",
          boardId: "$board",
          objectId: "@control",
        },
        {
          op: "object.create",
          ref: "conclusion",
          type: "research.conclusion",
          title: "结论",
          data: { statement: "剂量与恢复时间存在正相关", confidence: 0.6 },
        },
        {
          op: "presentation.create",
          boardId: "$board",
          objectId: "@conclusion",
        },
        {
          op: "relation.create",
          kind: "research.supports",
          sourceId: "@positive",
          targetId: "@hypothesis",
          status: "confirmed",
          basis: "阳性结果",
        },
        {
          op: "relation.create",
          kind: "research.refutes",
          sourceId: "@control",
          targetId: "@hypothesis",
          status: "confirmed",
          basis: "阴性对照",
        },
        {
          op: "relation.create",
          kind: "research.supports",
          sourceId: "@positive",
          targetId: "@conclusion",
          status: "confirmed",
          basis: "阳性结果",
        },
      ],
    },
  ],
  registerTools: registerResearchTools,
};
