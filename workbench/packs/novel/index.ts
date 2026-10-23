// 小说内置包：人物 / 事件 / 章节与情节关系。
//
// 领域语义只住在这里：内核只认「对象 / 关系 / 展示 + 一张注册表」。
// 人物没有姓名字段（对象标题就是名字），事件没有参与者名单（参与者是关系）。
//
// 字段限制从 v2 的 workbench/domains/novel/index.ts 搬来；v2 的占位值不留。

import type { PackSpec } from "../../kernel/index.ts";

export const novelPack: PackSpec = {
  id: "novel",
  title: "小说",
  version: 1,
  description: "人物 / 事件 / 章节与情节关系：参与、导致、先于、埋设-回收。",
  types: [
    {
      type: "novel.character",
      title: "人物",
      description: "小说中的一个人物及其基本设定",
      icon: "user",
      version: 1,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          role: {
            type: "string",
            maxLength: 60,
            "x-sand-label": "定位",
            "x-sand-widget": "text",
            "x-sand-placeholder": "主角、配角……",
          },
          age: {
            type: "integer",
            minimum: 0,
            maximum: 10000,
            "x-sand-label": "年龄",
            "x-sand-widget": "integer",
            "x-sand-unit": "岁",
          },
          traits: {
            type: "array",
            maxItems: 20,
            items: { type: "string", minLength: 1, maxLength: 40 },
            "x-sand-label": "性格",
            "x-sand-widget": "tags",
          },
          goal: {
            type: "string",
            maxLength: 200,
            "x-sand-label": "动机",
            "x-sand-widget": "text",
          },
          arc: {
            type: "string",
            maxLength: 20000,
            "x-sand-label": "人物弧光",
            "x-sand-widget": "markdown",
          },
        },
      },
      capabilities: { container: true, cover: true },
      display: {
        material: "paper",
        defaultSize: { width: 260, height: 180 },
        summary: ["role", "age", "goal"],
      },
      relationSlots: [
        {
          key: "events",
          label: "参与的事件",
          kind: "novel.participates",
          direction: "in",
          targetTypes: ["novel.event"],
          many: true,
        },
      ],
    },
    {
      type: "novel.event",
      title: "事件",
      description: "故事里发生的一件事：谁参与、发生在什么时间。",
      icon: "spark",
      version: 1,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["summary"],
        properties: {
          summary: {
            type: "string",
            maxLength: 2000,
            "x-sand-label": "事件概要",
            "x-sand-widget": "markdown",
          },
          storyTime: {
            type: "string",
            maxLength: 100,
            "x-sand-label": "故事时间",
            "x-sand-widget": "text",
          },
          narrativeOrder: {
            type: "integer",
            minimum: 0,
            "x-sand-label": "叙述顺序",
            "x-sand-widget": "integer",
          },
          place: {
            type: "string",
            maxLength: 200,
            "x-sand-label": "地点",
            "x-sand-widget": "text",
          },
        },
      },
      display: {
        material: "paper",
        defaultSize: { width: 280, height: 180 },
        summary: ["summary", "storyTime"],
      },
      relationSlots: [
        {
          key: "participants",
          label: "参与者",
          kind: "novel.participates",
          direction: "out",
          targetTypes: ["novel.character"],
          many: true,
        },
      ],
    },
    {
      type: "novel.chapter",
      title: "章节",
      description: "叙述的切分单位，携带叙述顺序和正文。",
      icon: "book",
      version: 1,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          summary: {
            type: "string",
            maxLength: 2000,
            "x-sand-label": "章节概要",
            "x-sand-widget": "markdown",
          },
          narrativeOrder: {
            type: "integer",
            minimum: 0,
            "x-sand-label": "叙述顺序",
            "x-sand-widget": "integer",
          },
          wordCount: {
            type: "integer",
            minimum: 0,
            "x-sand-label": "字数",
            "x-sand-widget": "integer",
            "x-sand-unit": "字",
          },
          body: {
            type: "string",
            maxLength: 20000,
            "x-sand-label": "正文",
            "x-sand-widget": "markdown",
          },
        },
      },
      display: {
        material: "paper",
        defaultSize: { width: 280, height: 180 },
        summary: ["summary", "wordCount"],
      },
    },
  ],
  relationKinds: [
    {
      kind: "novel.participates",
      title: "参与",
      inverseTitle: "参与者",
      allowsInferred: true,
      sourceTypes: ["novel.event"],
      targetTypes: ["novel.character"],
    },
    {
      kind: "novel.causes",
      title: "导致",
      inverseTitle: "被导致",
      allowsInferred: true,
    },
    {
      kind: "novel.precedes",
      title: "先于",
      inverseTitle: "后于",
      allowsInferred: true,
    },
    {
      kind: "novel.foreshadows",
      title: "埋设",
      inverseTitle: "回收",
      allowsInferred: true,
    },
  ],
  templates: [
    {
      id: "novel.three_act",
      title: "三幕结构",
      description: "三个章节 + 一个转折事件 + 一个主角，先把骨架摆出来。",
      commands: [
        {
          op: "object.create",
          ref: "act1",
          type: "novel.chapter",
          title: "第一幕：铺垫",
          data: { narrativeOrder: 1 },
        },
        {
          op: "presentation.create",
          boardId: "$board",
          objectId: "@act1",
        },
        {
          op: "object.create",
          ref: "act2",
          type: "novel.chapter",
          title: "第二幕：对抗",
          data: { narrativeOrder: 2 },
        },
        {
          op: "presentation.create",
          boardId: "$board",
          objectId: "@act2",
        },
        {
          op: "object.create",
          ref: "act3",
          type: "novel.chapter",
          title: "第三幕：收束",
          data: { narrativeOrder: 3 },
        },
        {
          op: "presentation.create",
          boardId: "$board",
          objectId: "@act3",
        },
        {
          op: "object.create",
          ref: "turn",
          type: "novel.event",
          title: "转折：港口大火",
          data: { narrativeOrder: 4, storyTime: "第三年冬" },
        },
        {
          op: "presentation.create",
          boardId: "$board",
          objectId: "@turn",
        },
        {
          op: "object.create",
          ref: "lead",
          type: "novel.character",
          title: "主角",
          data: { role: "主角" },
        },
        {
          op: "presentation.create",
          boardId: "$board",
          objectId: "@lead",
        },
        {
          op: "relation.create",
          kind: "novel.participates",
          sourceId: "@turn",
          targetId: "@lead",
          status: "confirmed",
        },
        {
          op: "relation.create",
          kind: "novel.precedes",
          sourceId: "@act1",
          targetId: "@act2",
          status: "confirmed",
        },
        {
          op: "relation.create",
          kind: "novel.causes",
          sourceId: "@act2",
          targetId: "@turn",
          status: "confirmed",
        },
        {
          op: "relation.create",
          kind: "novel.foreshadows",
          sourceId: "@act1",
          targetId: "@act3",
          status: "confirmed",
        },
      ],
    },
    {
      id: "novel.character_bio",
      title: "人物小传",
      description: "一个主角 + 他参与的两件事，先把动机与转折理清。",
      commands: [
        {
          op: "object.create",
          ref: "lead",
          type: "novel.character",
          title: "主角",
          data: { role: "主角" },
        },
        {
          op: "presentation.create",
          boardId: "$board",
          objectId: "@lead",
        },
        {
          op: "object.create",
          ref: "leave",
          type: "novel.event",
          title: "启程",
          data: { narrativeOrder: 1, storyTime: "第一年春" },
        },
        {
          op: "presentation.create",
          boardId: "$board",
          objectId: "@leave",
        },
        {
          op: "object.create",
          ref: "back",
          type: "novel.event",
          title: "回乡",
          data: { narrativeOrder: 2, storyTime: "第五年秋" },
        },
        {
          op: "presentation.create",
          boardId: "$board",
          objectId: "@back",
        },
        {
          op: "relation.create",
          kind: "novel.participates",
          sourceId: "@leave",
          targetId: "@lead",
          status: "confirmed",
        },
        {
          op: "relation.create",
          kind: "novel.participates",
          sourceId: "@back",
          targetId: "@lead",
          status: "confirmed",
        },
        {
          op: "relation.create",
          kind: "novel.precedes",
          sourceId: "@leave",
          targetId: "@back",
          status: "inferred",
          basis: "作者笔记：回乡是启程的直接后果",
        },
      ],
    },
  ],
};
