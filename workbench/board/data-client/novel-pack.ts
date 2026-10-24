// 小说领域包：人物 / 事件 / 章节 + 情节关系。
//
// 领域语义只住在这里：内核只认「对象 / 关系 / 展示 + 一张注册表」，
// 不认识什么是人物、什么是章节。契约见 docs/architecture/domain-packs.zh-CN.md
// 第 2、8 节（issue #14）。
//
// 本文件是纯数据 + 纯函数：不依赖 store、不碰文件系统、不读时钟。
// 包之间也不互相 import——每个包要能单独搬走。

import type {
  DomainComponentType,
  DomainObjectType,
  DomainPack,
  DomainRelationType,
  DomainTemplate,
  DomainToolSpec,
} from "./objects.ts";

/** 注册表里的包 id。 */
export const NOVEL_PACK_ID = "novel";

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const asStringList = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((v) => typeof v === "string")
    ? (value as string[])
    : undefined;

/** 人物：姓名是唯一必填项，其余都是可选维度。 */
const characterType: DomainObjectType = {
  type: "character",
  title: "人物",
  fields: [
    { key: "name", label: "姓名", kind: "text", required: true },
    { key: "role", label: "定位", kind: "text" },
    { key: "age", label: "年龄", kind: "number" },
    { key: "traits", label: "性格", kind: "list" },
    { key: "goal", label: "动机", kind: "text" },
    { key: "arc", label: "人物弧光", kind: "longtext" },
  ],
  defaultData: {
    name: "",
    role: "",
    age: 0,
    traits: [],
    goal: "",
    arc: "",
  },
  check: (data) => {
    const errors: string[] = [];
    const name = asString(data.name);
    if (name === undefined || !name.trim()) errors.push("人物必须有姓名。");
    else if (name.length > 60) errors.push("人物姓名过长（上限 60 字）。");
    const age = data.age === undefined ? undefined : asNumber(data.age);
    if (data.age !== undefined && age === undefined)
      errors.push("人物年龄必须是非负数。");
    else if (age !== undefined && age < 0) errors.push("人物年龄不能为负。");
    if (data.traits !== undefined) {
      const traits = asStringList(data.traits);
      if (!traits) errors.push("人物性格必须是文本列表。");
      else if (traits.length > 20)
        errors.push("人物性格条目过多（上限 20 条）。");
      else if (traits.some((t) => !t.trim()))
        errors.push("人物性格的每一项都要是非空文本。");
    }
    const goal = asString(data.goal);
    if (data.goal !== undefined && goal === undefined)
      errors.push("人物动机必须是文本。");
    else if (goal !== undefined && goal.length > 200)
      errors.push("人物动机过长（上限 200 字）。");
    const arc = asString(data.arc);
    if (data.arc !== undefined && arc === undefined)
      errors.push("人物弧光必须是文本。");
    else if (arc !== undefined && arc.length > 2000)
      errors.push("人物弧光过长（上限 2000 字）。");
    return errors;
  },
};

/**
 * 事件：故事里发生的一件事。
 *
 * 时间是**可选维度**：storyTime 是故事发生时间，narrativeOrder 是叙述顺序。
 * 两者可以不一致（倒叙），首期只要求能表达，不要求过程回放。
 */
const eventType: DomainObjectType = {
  type: "event",
  title: "事件",
  fields: [
    { key: "summary", label: "事件概要", kind: "longtext", required: true },
    { key: "storyTime", label: "故事时间", kind: "text" },
    { key: "narrativeOrder", label: "叙述顺序", kind: "number" },
    { key: "place", label: "地点", kind: "text" },
    { key: "participants", label: "参与者", kind: "list" },
  ],
  defaultData: {
    summary: "",
    storyTime: "",
    narrativeOrder: 0,
    place: "",
    participants: [],
  },
  check: (data) => {
    const errors: string[] = [];
    const summary = asString(data.summary);
    if (summary === undefined || !summary.trim())
      errors.push("事件必须有概要。");
    else if (summary.length > 2000)
      errors.push("事件概要过长（上限 2000 字）。");
    const storyTime = asString(data.storyTime);
    if (data.storyTime !== undefined && storyTime === undefined)
      errors.push("故事时间必须是文本。");
    else if (storyTime !== undefined && storyTime.length > 100)
      errors.push("故事时间过长（上限 100 字）。");
    const order =
      data.narrativeOrder === undefined
        ? undefined
        : asNumber(data.narrativeOrder);
    if (data.narrativeOrder !== undefined) {
      if (order === undefined || !Number.isInteger(order))
        errors.push("叙述顺序必须是整数。");
      else if (order < 0) errors.push("叙述顺序不能为负。");
    }
    const place = asString(data.place);
    if (data.place !== undefined && place === undefined)
      errors.push("地点必须是文本。");
    if (data.participants !== undefined) {
      const participants = asStringList(data.participants);
      if (!participants) errors.push("参与者必须是文本列表。");
      else if (participants.length > 50)
        errors.push("参与者过多（上限 50 人）。");
    }
    return errors;
  },
};

/** 章节：叙述的切分单位，携带叙述顺序。 */
const chapterType: DomainObjectType = {
  type: "chapter",
  title: "章节",
  fields: [
    { key: "summary", label: "章节概要", kind: "longtext" },
    { key: "narrativeOrder", label: "叙述顺序", kind: "number" },
    { key: "pov", label: "视角人物", kind: "text" },
    { key: "wordCount", label: "字数", kind: "number" },
  ],
  defaultData: {
    summary: "",
    narrativeOrder: 0,
    pov: "",
    wordCount: 0,
  },
  check: (data) => {
    const errors: string[] = [];
    const summary = asString(data.summary);
    if (data.summary !== undefined && summary === undefined)
      errors.push("章节概要必须是文本。");
    else if (summary !== undefined && summary.length > 2000)
      errors.push("章节概要过长（上限 2000 字）。");
    const order =
      data.narrativeOrder === undefined
        ? undefined
        : asNumber(data.narrativeOrder);
    if (data.narrativeOrder !== undefined) {
      if (order === undefined || !Number.isInteger(order))
        errors.push("叙述顺序必须是整数。");
      else if (order < 0) errors.push("叙述顺序不能为负。");
    }
    const pov = asString(data.pov);
    if (data.pov !== undefined && pov === undefined)
      errors.push("视角人物必须是文本。");
    const words =
      data.wordCount === undefined ? undefined : asNumber(data.wordCount);
    if (data.wordCount !== undefined) {
      if (words === undefined) errors.push("字数必须是非负数。");
      else if (words < 0) errors.push("字数不能为负。");
    }
    return errors;
  },
};

/** 小说领域包声明的对象类型。 */
export const novelObjectTypes: DomainObjectType[] = [
  characterType,
  eventType,
  chapterType,
];

/**
 * 情节关系。
 *
 * 四种关系都允许推测：作者还没定下来的伏笔与因果，本来就是「待确认」的。
 * 推测关系必须带依据（basis），不能冒充已确认事实。
 */
export const novelRelationTypes: DomainRelationType[] = [
  { kind: "参与", title: "参与", allowsInferred: true },
  { kind: "导致", title: "导致", allowsInferred: true },
  { kind: "先于", title: "先于", allowsInferred: true },
  { kind: "埋设-回收", title: "埋设-回收", allowsInferred: true },
];

/** 领域包声明的呈现方式。 */
export const novelComponentTypes: DomainComponentType[] = [
  {
    type: "character",
    title: "人物",
    icon: "user",
    material: "paper",
    objectType: "character",
  },
  {
    type: "event",
    title: "事件",
    icon: "spark",
    material: "paper",
    objectType: "event",
  },
  {
    type: "chapter",
    title: "章节",
    icon: "book",
    material: "paper",
    objectType: "chapter",
  },
];

/** 模板：只是起点，不是强制流程。 */
export const novelTemplates: DomainTemplate[] = [
  {
    id: "novel-three-act",
    title: "三幕结构",
    description: "三个章节 + 一个转折事件 + 一个主角，先把骨架摆出来。",
    objects: [
      { type: "chapter", title: "第一幕：铺垫", data: { narrativeOrder: 1 } },
      { type: "chapter", title: "第二幕：对抗", data: { narrativeOrder: 2 } },
      { type: "chapter", title: "第三幕：收束", data: { narrativeOrder: 3 } },
      {
        type: "event",
        title: "转折：港口大火",
        data: { narrativeOrder: 4, storyTime: "第三年冬" },
      },
      {
        type: "character",
        title: "主角",
        data: { name: "主角", role: "主角" },
      },
    ],
    relations: [
      { source: 4, target: 3, kind: "参与", status: "confirmed" },
      { source: 0, target: 1, kind: "先于", status: "confirmed" },
      { source: 1, target: 3, kind: "导致", status: "confirmed" },
      { source: 0, target: 2, kind: "埋设-回收", status: "confirmed" },
    ],
  },
  {
    id: "novel-character-bio",
    title: "人物小传",
    description: "一个主角 + 他参与的两件事，先把动机与转折理清。",
    objects: [
      {
        type: "character",
        title: "主角",
        data: { name: "主角", role: "主角" },
      },
      {
        type: "event",
        title: "启程",
        data: { narrativeOrder: 1, storyTime: "第一年春" },
      },
      {
        type: "event",
        title: "回乡",
        data: { narrativeOrder: 2, storyTime: "第五年秋" },
      },
    ],
    relations: [
      { source: 0, target: 1, kind: "参与", status: "confirmed" },
      { source: 0, target: 2, kind: "参与", status: "confirmed" },
      {
        source: 1,
        target: 2,
        kind: "先于",
        status: "inferred",
        basis: "作者笔记：回乡是启程的直接后果",
      },
    ],
  },
];

/** 领域包声明的工具。实现是本包里的纯函数，工具只是它的入口描述。 */
export const novelTools: DomainToolSpec[] = [
  {
    name: "novel_plot_order",
    title: "情节顺序",
    description:
      "按故事时间或叙述顺序列出事件。两种顺序不一致时说明差异（倒叙）。实现见 domains/novel/index.ts 的 storyOrder / narrativeOrder。",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["story", "narrative"] },
      },
      required: ["mode"],
    },
  },
];

/** 领域包定义。注册进 core/domains.ts 的注册表后，内核就能认出这些词汇。 */
export const novelPack: DomainPack = {
  id: NOVEL_PACK_ID,
  title: "小说",
  version: 1,
  description: "人物 / 事件 / 章节与情节关系：参与、导致、先于、埋设-回收。",
  objectTypes: novelObjectTypes,
  componentTypes: novelComponentTypes,
  relationTypes: novelRelationTypes,
  templates: novelTemplates,
  tools: novelTools,
};

/** 建立关系时的最小输入。 */
export type NovelRelationInput = {
  kind: string;
  status: "confirmed" | "inferred";
  basis?: string;
};

/**
 * 关系级领域校验。
 *
 * 注册表目前只有对象级校验入口（checkDomainData），关系级规则没有地方放，
 * 所以这里自带一份纯函数：内核不认「参与」是什么意思，领域包认。
 */
export function checkNovelRelation(input: NovelRelationInput): string[] {
  const errors: string[] = [];
  const spec = novelRelationTypes.find((r) => r.kind === input.kind);
  if (!spec) {
    errors.push(`未知的情节关系类型「${input.kind}」。`);
    return errors;
  }
  if (input.status === "inferred") {
    if (!spec.allowsInferred)
      errors.push(`关系「${input.kind}」不允许推测，只能记为已确认。`);
    if (!(input.basis ?? "").trim())
      errors.push("推测性关系必须给依据，不能冒充已确认事实。");
  }
  return errors;
}

/**
 * 校验通过后返回可直接写入内核的关系载荷。
 * 校验不过就抛错：推测关系没有依据时不能让它悄悄混进已确认的关系里。
 */
export function newNovelRelation(input: NovelRelationInput): {
  kind: string;
  status: "confirmed" | "inferred";
  basis?: string;
} {
  const errors = checkNovelRelation(input);
  if (errors.length) throw new Error(errors.join(" "));
  return {
    kind: input.kind,
    status: input.status,
    ...(input.basis === undefined ? {} : { basis: input.basis }),
  };
}

/** 参与排序的条目。 */
type Ordered = { id: string };

/**
 * 故事时间顺序：按故事发生时间排。
 * 没有故事时间的排在最后；同值按传入顺序稳定排列，不依赖随机序。
 */
export function storyOrder<T extends Ordered & { storyTime?: string }>(
  events: T[],
): T[] {
  return events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => {
      const left = a.event.storyTime ?? "";
      const right = b.event.storyTime ?? "";
      if (left === right) return a.index - b.index;
      if (!left) return 1;
      if (!right) return -1;
      return left < right ? -1 : 1;
    })
    .map((entry) => entry.event);
}

/** 叙述顺序：按叙述顺序排。同值按传入顺序稳定排列。 */
export function narrativeOrder<T extends Ordered & { narrativeOrder?: number }>(
  items: T[],
): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const left = a.item.narrativeOrder ?? 0;
      const right = b.item.narrativeOrder ?? 0;
      if (left === right) return a.index - b.index;
      return left - right;
    })
    .map((entry) => entry.item);
}
