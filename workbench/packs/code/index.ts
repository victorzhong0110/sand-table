// 代码内置包：仓库 / 文件 / 符号，以及改动链路上的意图、提案、验证。
//
// 仓库、文件、符号由源码索引产出：它们的 source.origin 是 derived，不进撤销
// 历史（见 docs/kernel-v3/02-commands-and-tools.md §1.5）。本包声明派生对象
// 的 ID 前缀 code:，前缀由注册表校验不与其他内置包重叠。
//
// 意图、提案、验证是 v3 的对象形态：v2 把它们放在白板级别的数组里，v2 的
// intentId / proposalId 指向别的对象，v3 改成关系槽，不在数据里存对象 id。
//
// 字段限制从 v2 的 workbench/domains/code/index.ts 搬来；v2 的占位值不留。

import type { PackSpec } from "../../kernel/index.ts";

/** 源文件路径：允许空字符串；禁止绝对路径、反斜杠，以及单独的 . / .. 段。 */
const SOURCE_PATH =
  "^(?!/)(?!.*\\\\)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*(?:^|/)\\.(?:/|$)).*$";

/** 工作树路径：不能为空，禁止盘符、绝对路径、反斜杠、空段、. / .. / .git 段。 */
const WORKTREE_PATH =
  "^(?![A-Za-z]:)(?!/)(?!\\.(?:/|$))(?!\\.\\.(?:/|$))(?!\\.[gG][iI][tT](?:/|$))[^/\\\\]+(?:/(?!\\.(?:/|$))(?!\\.\\.(?:/|$))(?!\\.[gG][iI][tT](?:/|$))[^/\\\\]+)*$";

export const codePack: PackSpec = {
  derivedIdPrefix: "code:",
  id: "code",
  title: "代码",
  version: 1,
  description:
    "源码索引产出的代码对象（仓库、文件、符号），以及改动链路上的意图、提案、验证。",
  types: [
    {
      type: "code.repository",
      title: "代码仓库",
      description: "一个被索引的代码仓库。",
      icon: "code",
      version: 1,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          label: {
            type: "string",
            maxLength: 200,
            "x-sand-label": "名称",
            "x-sand-widget": "text",
          },
          head: {
            type: "string",
            maxLength: 200,
            "x-sand-label": "当前提交",
            "x-sand-widget": "text",
          },
          branch: {
            type: "string",
            maxLength: 200,
            "x-sand-label": "分支",
            "x-sand-widget": "text",
          },
        },
      },
      display: {
        material: "document",
        defaultSize: { width: 280, height: 180 },
        summary: ["label", "branch"],
      },
    },
    {
      type: "code.file",
      title: "源文件",
      description: "仓库里的一个文件，路径是仓库内的相对路径。",
      icon: "resource",
      version: 1,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: {
            type: "string",
            maxLength: 500,
            pattern: SOURCE_PATH,
            "x-sand-label": "路径",
            "x-sand-widget": "text",
          },
          hash: {
            anyOf: [
              { type: "string", pattern: "^[0-9a-fA-F]{64}$" },
              { type: "null" },
            ],
            "x-sand-label": "内容指纹",
            "x-sand-widget": "text",
          },
        },
      },
      display: {
        material: "document",
        defaultSize: { width: 280, height: 180 },
        summary: ["path", "hash"],
      },
    },
    {
      type: "code.symbol",
      title: "符号",
      description: "文件里的一个符号：名字和行号范围。",
      icon: "text",
      version: 1,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: {
            type: "string",
            maxLength: 200,
            "x-sand-label": "名字",
            "x-sand-widget": "text",
          },
          startLine: {
            type: "integer",
            minimum: 1,
            "x-sand-label": "起始行",
            "x-sand-widget": "integer",
            "x-sand-unit": "行",
          },
          endLine: {
            type: "integer",
            minimum: 1,
            "x-sand-label": "结束行",
            "x-sand-widget": "integer",
            "x-sand-unit": "行",
          },
        },
      },
      display: {
        material: "document",
        defaultSize: { width: 280, height: 180 },
        summary: ["name", "startLine"],
      },
    },
    {
      type: "code.intent",
      title: "改动意图",
      description: "人明确提出的一次改动请求：改什么，允许动哪些文件。",
      icon: "intent",
      version: 1,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          request: {
            type: "string",
            maxLength: 4000,
            "x-sand-label": "改动请求",
            "x-sand-widget": "markdown",
          },
          allowedFiles: {
            type: "array",
            maxItems: 12,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["workspaceId", "path"],
              properties: {
                workspaceId: {
                  type: "string",
                  maxLength: 500,
                  "x-sand-label": "工作空间",
                  "x-sand-widget": "text",
                },
                path: {
                  type: "string",
                  maxLength: 500,
                  pattern: WORKTREE_PATH,
                  "x-sand-label": "路径",
                  "x-sand-widget": "text",
                },
              },
            },
            "x-sand-label": "允许修改的文件",
            "x-sand-widget": "list",
          },
          arrangement: {
            type: "object",
            "x-sand-label": "冻结布局",
            "x-sand-widget": "list",
            "x-sand-hidden": true,
          },
        },
      },
      display: {
        material: "document",
        defaultSize: { width: 300, height: 180 },
        summary: ["request", "allowedFiles"],
      },
      relationSlots: [
        {
          key: "objects",
          label: "涉及的对象",
          kind: "base.related",
          direction: "out",
          many: true,
        },
      ],
    },
    {
      type: "code.proposal",
      title: "目标版本",
      description: "针对一个意图给出的目标文件版本，等人批准。",
      icon: "proposal",
      version: 1,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: {
            type: "string",
            maxLength: 120,
            "x-sand-label": "标题",
            "x-sand-widget": "text",
          },
          explanation: {
            type: "string",
            maxLength: 4000,
            "x-sand-label": "说明",
            "x-sand-widget": "markdown",
          },
          testPlan: {
            type: "string",
            maxLength: 2000,
            "x-sand-label": "验证计划",
            "x-sand-widget": "markdown",
          },
          digest: {
            type: "string",
            maxLength: 200,
            "x-sand-label": "摘要",
            "x-sand-widget": "text",
          },
          intentVersion: {
            type: "integer",
            minimum: 1,
            "x-sand-label": "意图版本",
            "x-sand-widget": "integer",
          },
          agentId: {
            type: "string",
            maxLength: 500,
            "x-sand-label": "提交者",
            "x-sand-widget": "text",
          },
          decidedAt: {
            type: "integer",
            minimum: 0,
            "x-sand-label": "决定时间",
            "x-sand-widget": "integer",
          },
          decision: {
            type: "string",
            enum: ["pending", "accepted", "rejected", "revise", "stale"],
            "x-sand-label": "决定",
            "x-sand-widget": "enum",
            "x-sand-default": "pending",
            "x-sand-enum-labels": {
              pending: "待决定",
              accepted: "已批准",
              rejected: "已拒绝",
              revise: "要修改",
              stale: "已过期",
            },
          },
          files: {
            type: "array",
            maxItems: 12,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["workspaceId", "path"],
              properties: {
                workspaceId: {
                  type: "string",
                  maxLength: 500,
                  "x-sand-label": "工作空间",
                  "x-sand-widget": "text",
                },
                path: {
                  type: "string",
                  maxLength: 500,
                  pattern: WORKTREE_PATH,
                  "x-sand-label": "路径",
                  "x-sand-widget": "text",
                },
                beforeHash: {
                  type: ["string", "null"],
                  maxLength: 64,
                  "x-sand-label": "改前指纹",
                  "x-sand-widget": "text",
                },
                afterHash: {
                  type: ["string", "null"],
                  maxLength: 64,
                  "x-sand-label": "改后指纹",
                  "x-sand-widget": "text",
                },
                before: {
                  type: ["string", "null"],
                  maxLength: 200000,
                  "x-sand-label": "改前内容",
                  "x-sand-widget": "longtext",
                },
                after: {
                  type: ["string", "null"],
                  maxLength: 200000,
                  "x-sand-label": "改后内容",
                  "x-sand-widget": "longtext",
                },
              },
            },
            "x-sand-label": "改动的文件",
            "x-sand-widget": "list",
          },
          baseline: {
            type: "array",
            items: { type: "object" },
            "x-sand-label": "基线",
            "x-sand-widget": "list",
            "x-sand-hidden": true,
          },
          verification: {
            type: "object",
            "x-sand-label": "核对结果",
            "x-sand-widget": "list",
            "x-sand-hidden": true,
          },
        },
      },
      display: {
        material: "document",
        defaultSize: { width: 300, height: 180 },
        summary: ["title", "decision"],
      },
      relationSlots: [
        {
          key: "intent",
          label: "所属意图",
          kind: "code.contains",
          direction: "in",
          targetTypes: ["code.intent"],
          many: false,
        },
      ],
    },
    {
      type: "code.validation",
      title: "验证结果",
      description: "对一个目标版本跑过验证后的结果。",
      icon: "validation",
      version: 1,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          command: {
            type: "string",
            maxLength: 1000,
            "x-sand-label": "命令",
            "x-sand-widget": "text",
          },
          environment: {
            type: "string",
            maxLength: 1000,
            "x-sand-label": "环境",
            "x-sand-widget": "text",
          },
          outcome: {
            type: "string",
            enum: ["passed", "failed", "not-run"],
            "x-sand-label": "结果",
            "x-sand-widget": "enum",
            "x-sand-enum-labels": {
              passed: "通过",
              failed: "失败",
              "not-run": "没跑",
            },
          },
          output: {
            type: "string",
            maxLength: 8000,
            "x-sand-label": "输出",
            "x-sand-widget": "markdown",
          },
          reportedAt: {
            type: "integer",
            minimum: 0,
            "x-sand-label": "报告时间",
            "x-sand-widget": "integer",
          },
          workspaceId: {
            type: "string",
            maxLength: 500,
            "x-sand-label": "工作空间",
            "x-sand-widget": "text",
          },
          fingerprint: {
            type: "string",
            maxLength: 200,
            "x-sand-label": "内容指纹",
            "x-sand-widget": "text",
          },
          digest: {
            type: "string",
            maxLength: 200,
            "x-sand-label": "摘要",
            "x-sand-widget": "text",
          },
          agentId: {
            type: "string",
            maxLength: 500,
            "x-sand-label": "提交者",
            "x-sand-widget": "text",
          },
          source: {
            type: "string",
            enum: ["agent-report"],
            "x-sand-label": "来源",
            "x-sand-widget": "enum",
            "x-sand-default": "agent-report",
            "x-sand-enum-labels": { "agent-report": "代理自报" },
          },
        },
      },
      display: {
        material: "gauge",
        defaultSize: { width: 300, height: 180 },
        summary: ["outcome", "command"],
      },
      relationSlots: [
        {
          key: "proposal",
          label: "所属提案",
          kind: "code.contains",
          direction: "in",
          targetTypes: ["code.proposal"],
          many: false,
        },
      ],
    },
  ],
  relationKinds: [
    {
      kind: "code.contains",
      title: "包含",
      inverseTitle: "包含于",
      allowsInferred: false,
    },
    {
      kind: "code.imports",
      title: "导入",
      inverseTitle: "被导入",
      allowsInferred: false,
    },
    {
      kind: "code.calls",
      title: "调用",
      inverseTitle: "被调用",
      allowsInferred: true,
    },
  ],
  templates: [
    {
      id: "code.tour",
      title: "代码导览",
      description:
        "从仓库到文件再到符号的三层结构。模板只是起点，用户可以从空白开始。",
      commands: [
        {
          op: "object.create",
          ref: "repo",
          type: "code.repository",
          title: "仓库",
        },
        {
          op: "presentation.create",
          boardId: "$board",
          objectId: "@repo",
        },
        {
          op: "object.create",
          ref: "entry",
          type: "code.file",
          title: "入口文件",
        },
        {
          op: "presentation.create",
          boardId: "$board",
          objectId: "@entry",
        },
        {
          op: "object.create",
          ref: "symbol",
          type: "code.symbol",
          title: "关键符号",
        },
        {
          op: "presentation.create",
          boardId: "$board",
          objectId: "@symbol",
        },
        {
          op: "relation.create",
          kind: "code.contains",
          sourceId: "@repo",
          targetId: "@entry",
          status: "confirmed",
        },
        {
          op: "relation.create",
          kind: "code.contains",
          sourceId: "@entry",
          targetId: "@symbol",
          status: "confirmed",
        },
      ],
    },
    {
      id: "code.change_impact",
      title: "改动影响面",
      description: "一个文件牵出哪些导入与调用：改动之前先看清影响范围。",
      commands: [
        {
          op: "object.create",
          ref: "changed",
          type: "code.file",
          title: "改动的文件",
        },
        {
          op: "presentation.create",
          boardId: "$board",
          objectId: "@changed",
        },
        {
          op: "object.create",
          ref: "imported",
          type: "code.file",
          title: "被导入的文件",
        },
        {
          op: "presentation.create",
          boardId: "$board",
          objectId: "@imported",
        },
        {
          op: "object.create",
          ref: "affected",
          type: "code.symbol",
          title: "受影响的符号",
        },
        {
          op: "presentation.create",
          boardId: "$board",
          objectId: "@affected",
        },
        {
          op: "relation.create",
          kind: "code.imports",
          sourceId: "@changed",
          targetId: "@imported",
          status: "confirmed",
        },
        {
          op: "relation.create",
          kind: "code.contains",
          sourceId: "@imported",
          targetId: "@affected",
          status: "confirmed",
        },
      ],
    },
  ],
};
