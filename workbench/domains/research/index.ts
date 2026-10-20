// 科研领域包：假设 / 证据 / 结论 + 支持、反驳关系 + 页码级引用。
//
// 领域语义只住在这里：内核只认「对象 / 关系 / 展示 + 一张注册表」，
// 不认识什么是假设、什么是引用。契约见 docs/architecture/domain-packs.zh-CN.md
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
  ResourceReference,
  WorkspaceObject,
} from "../../core/objects.ts";

/** 注册表里的包 id。 */
export const RESEARCH_PACK_ID = "research";

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const asStringList = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((v) => typeof v === "string")
    ? (value as string[])
    : undefined;

/** 假设：可被证据支持或反驳的陈述。 */
const hypothesisType: DomainObjectType = {
  type: "hypothesis",
  title: "假设",
  fields: [
    { key: "statement", label: "假设陈述", kind: "text", required: true },
    { key: "scope", label: "适用范围", kind: "text" },
    { key: "testable", label: "可检验", kind: "boolean" },
    { key: "variables", label: "涉及变量", kind: "list" },
  ],
  defaultData: {
    statement: "",
    scope: "",
    testable: true,
    variables: [],
  },
  check: (data) => {
    const errors: string[] = [];
    const statement = asString(data.statement);
    if (statement === undefined || !statement.trim())
      errors.push("假设必须有陈述。");
    else if (statement.length > 500)
      errors.push("假设陈述过长（上限 500 字）。");
    const scope = asString(data.scope);
    if (data.scope !== undefined && scope === undefined)
      errors.push("适用范围必须是文本。");
    else if (scope !== undefined && scope.length > 200)
      errors.push("适用范围过长（上限 200 字）。");
    if (data.testable !== undefined && typeof data.testable !== "boolean")
      errors.push("「可检验」必须是布尔值。");
    if (data.variables !== undefined) {
      const variables = asStringList(data.variables);
      if (!variables) errors.push("涉及变量必须是文本列表。");
      else if (variables.length > 30)
        errors.push("涉及变量过多（上限 30 个）。");
    }
    return errors;
  },
};

/**
 * 证据：支撑或反驳某个陈述的一条材料。
 *
 * citation 是结构化引用（页码级定位 + 内容指纹），放在 data.citation；
 * 字段声明里只给一个可读入口，具体结构见 ResearchCitation。
 */
const evidenceType: DomainObjectType = {
  type: "evidence",
  title: "证据",
  fields: [
    { key: "summary", label: "证据摘要", kind: "longtext", required: true },
    { key: "method", label: "获取方式", kind: "text" },
    { key: "strength", label: "强度", kind: "number" },
    { key: "citation", label: "引用定位（页码级）", kind: "text" },
  ],
  defaultData: {
    summary: "",
    method: "",
    strength: 0,
    citation: null,
  },
  check: (data) => {
    const errors: string[] = [];
    const summary = asString(data.summary);
    if (summary === undefined || !summary.trim())
      errors.push("证据必须有摘要。");
    else if (summary.length > 2000)
      errors.push("证据摘要过长（上限 2000 字）。");
    const method = asString(data.method);
    if (data.method !== undefined && method === undefined)
      errors.push("获取方式必须是文本。");
    const strength =
      data.strength === undefined ? undefined : asNumber(data.strength);
    if (data.strength !== undefined) {
      if (strength === undefined) errors.push("强度必须是 0 到 1 之间的数。");
      else if (strength < 0 || strength > 1)
        errors.push("强度必须是 0 到 1 之间的数。");
    }
    if (data.citation !== undefined && data.citation !== null) {
      const raw = data.citation as unknown;
      if (typeof raw !== "object" || raw === null)
        errors.push("引用必须是引用对象。");
      else errors.push(...checkCitation(raw as ResearchCitation));
    }
    return errors;
  },
};

/** 结论：从假设与证据出发得到的判断。 */
const conclusionType: DomainObjectType = {
  type: "conclusion",
  title: "结论",
  fields: [
    { key: "statement", label: "结论陈述", kind: "text", required: true },
    { key: "confidence", label: "置信度", kind: "number" },
    { key: "scope", label: "适用范围", kind: "text" },
  ],
  defaultData: {
    statement: "",
    confidence: 0,
    scope: "",
  },
  check: (data) => {
    const errors: string[] = [];
    const statement = asString(data.statement);
    if (statement === undefined || !statement.trim())
      errors.push("结论必须有陈述。");
    else if (statement.length > 500)
      errors.push("结论陈述过长（上限 500 字）。");
    const confidence =
      data.confidence === undefined ? undefined : asNumber(data.confidence);
    if (data.confidence !== undefined) {
      if (confidence === undefined)
        errors.push("置信度必须是 0 到 1 之间的数。");
      else if (confidence < 0 || confidence > 1)
        errors.push("置信度必须是 0 到 1 之间的数。");
    }
    const scope = asString(data.scope);
    if (data.scope !== undefined && scope === undefined)
      errors.push("适用范围必须是文本。");
    return errors;
  },
};

/** 科研领域包声明的对象类型。 */
export const researchObjectTypes: DomainObjectType[] = [
  hypothesisType,
  evidenceType,
  conclusionType,
];

/**
 * 支持 / 反驳。
 *
 * 两种关系都允许推测（「这条证据倾向于支持」也是推测），
 * 但无论确认还是推测，都必须给依据。
 */
export const researchRelationTypes: DomainRelationType[] = [
  { kind: "支持", title: "支持", allowsInferred: true },
  { kind: "反驳", title: "反驳", allowsInferred: true },
];

/** 领域包声明的呈现方式。 */
export const researchComponentTypes: DomainComponentType[] = [
  {
    type: "hypothesis",
    title: "假设",
    icon: "question",
    material: "paper",
    objectType: "hypothesis",
  },
  {
    type: "evidence",
    title: "证据",
    icon: "quote",
    material: "paper",
    objectType: "evidence",
  },
  {
    type: "conclusion",
    title: "结论",
    icon: "check",
    material: "paper",
    objectType: "conclusion",
  },
];

/** 模板：只是起点，不是强制流程。 */
export const researchTemplates: DomainTemplate[] = [
  {
    id: "research-hypothesis-evidence",
    title: "假设—证据—结论",
    description: "一个假设、两条证据、一条结论，把论证链先摆出来。",
    objects: [
      {
        type: "hypothesis",
        title: "假设",
        data: { statement: "提高剂量能缩短恢复时间", testable: true },
      },
      {
        type: "evidence",
        title: "证据：阳性结果",
        data: { summary: "120 个样本中恢复时间显著缩短", method: "观察" },
      },
      {
        type: "evidence",
        title: "证据：阴性对照",
        data: { summary: "对照组 20 例无显著差异", method: "观察" },
      },
      {
        type: "conclusion",
        title: "结论",
        data: { statement: "剂量与恢复时间存在正相关", confidence: 0.6 },
      },
    ],
    relations: [
      {
        source: 1,
        target: 0,
        kind: "支持",
        status: "confirmed",
        basis: "阳性结果",
      },
      {
        source: 2,
        target: 0,
        kind: "反驳",
        status: "confirmed",
        basis: "阴性对照",
      },
      {
        source: 1,
        target: 3,
        kind: "支持",
        status: "confirmed",
        basis: "阳性结果",
      },
    ],
  },
];

/** 领域包声明的工具。实现是本包里的纯函数，工具只是它的入口描述。 */
export const researchTools: DomainToolSpec[] = [
  {
    name: "research_check_citations",
    title: "引用复核",
    description:
      "按观察到的内容指纹复核引用，标出失效（stale）与缺失（missing）的引用，不静默覆盖原记录。实现见 domains/research/index.ts 的 verifyCitation / staleCitations。",
    inputSchema: {
      type: "object",
      properties: {
        observations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              uri: { type: "string" },
              fingerprint: { type: "string" },
              found: { type: "boolean" },
            },
            required: ["uri"],
          },
        },
      },
      required: ["observations"],
    },
  },
];

/** 领域包定义。 */
export const researchPack: DomainPack = {
  id: RESEARCH_PACK_ID,
  title: "科研",
  version: 1,
  description:
    "假设 / 证据 / 结论与支持、反驳关系，引用按页码定位并带内容指纹。",
  objectTypes: researchObjectTypes,
  componentTypes: researchComponentTypes,
  relationTypes: researchRelationTypes,
  templates: researchTemplates,
  tools: researchTools,
};

/** 引用有效性：有效 / 过期 / 缺失。 */
export type CitationStatus = "valid" | "stale" | "missing";

/**
 * 引用：指向外部资源（PDF）里的一段具体内容。
 *
 * fragment 是页码级定位（"p.42" / "p.42 §3.1"），
 * fingerprint 是记录时该片段的内容指纹——外部内容变了，指纹就不一样。
 */
export type ResearchCitation = {
  uri: string;
  fragment: string;
  fingerprint: string;
  status: CitationStatus;
  /** 复核时观察到的指纹：与 fingerprint 不同就说明外部内容变了。 */
  observedFingerprint?: string;
  /** 失效原因。 */
  reason?: string;
  /** 原文摘录。 */
  quote?: string;
  /** 文献标题。 */
  title?: string;
};

/** 页码级定位的格式：p.42、p.42 §3.1。 */
const PAGE_FRAGMENT = /^p\.\d+/;

/** 构造一条页码级 PDF 引用。参数不合法就抛错，不产出半截引用。 */
export function pdfCitation(input: {
  uri: string;
  page: number;
  fingerprint: string;
  quote?: string;
  title?: string;
}): ResearchCitation {
  if (!input.uri.trim()) throw new Error("引用必须有来源地址。");
  if (!Number.isInteger(input.page) || input.page <= 0)
    throw new Error("引用必须定位到具体页码（正整数）。");
  if (!input.fingerprint.trim())
    throw new Error("引用必须带内容指纹，否则无法识别内容变化。");
  const citation: ResearchCitation = {
    uri: input.uri,
    fragment: `p.${input.page}`,
    fingerprint: input.fingerprint,
    status: "valid",
  };
  if (input.quote !== undefined) citation.quote = input.quote;
  if (input.title !== undefined) citation.title = input.title;
  return citation;
}

/** 引用级领域校验。 */
export function checkCitation(citation: ResearchCitation): string[] {
  const errors: string[] = [];
  if (typeof citation.uri !== "string" || !citation.uri.trim())
    errors.push("引用必须有来源地址。");
  if (
    typeof citation.fragment !== "string" ||
    !PAGE_FRAGMENT.test(citation.fragment)
  )
    errors.push("引用必须定位到页码（形如 p.42）。");
  if (typeof citation.fingerprint !== "string" || !citation.fingerprint.trim())
    errors.push("引用必须带内容指纹。");
  if (!["valid", "stale", "missing"].includes(citation.status))
    errors.push("引用状态只能是 valid / stale / missing。");
  if (
    citation.status === "valid" &&
    citation.observedFingerprint &&
    citation.observedFingerprint !== citation.fingerprint
  )
    errors.push("引用内容已经变了，不能仍标为有效。");
  return errors;
}

/** 复核时对外部资源的一次观察。 */
export type CitationObservation = {
  /** 外部资源是否还取得到。 */
  found: boolean;
  /** 取到时观察到的内容指纹。 */
  fingerprint?: string;
};

/**
 * 复核一条引用，返回**新的**引用对象。
 *
 * 规则：
 * - 取不到 → status 变成 "missing"，原指纹保留（失效不等于内容被改写）。
 * - 取到但指纹不同 → status 变成 "stale"，原指纹保留，新指纹记在 observedFingerprint。
 * - 指纹一致 → status 保持 "valid"。
 *
 * 输入对象不被修改：失效要显式写回才算数，不能悄悄把记录改成新样子。
 */
export function verifyCitation(
  citation: ResearchCitation,
  observation: CitationObservation,
): ResearchCitation {
  if (!observation.found) {
    return {
      ...citation,
      status: "missing",
      reason: "外部资源取不到：引用可能已失效。",
    };
  }
  const observed = observation.fingerprint;
  // 取到了资源但没给指纹：无从判断内容变没变，状态保持原样。
  if (!observed) return { ...citation };
  if (observed !== citation.fingerprint) {
    return {
      ...citation,
      status: "stale",
      observedFingerprint: observed,
      reason: "外部内容已变化：指纹与记录时不一致。",
    };
  }
  const next: ResearchCitation = {
    ...citation,
    status: "valid",
    observedFingerprint: observed,
  };
  delete next.reason;
  return next;
}

/** 把引用投影成内核的资源引用条目（uri / fragment / fingerprint / status）。 */
export function citationToResource(
  citation: ResearchCitation,
  id: string,
): ResourceReference {
  const resource: ResourceReference = {
    id,
    kind: "pdf",
    uri: citation.uri,
    fragment: citation.fragment,
    fingerprint: citation.fingerprint,
    status: citation.status,
  };
  if (citation.title !== undefined) resource.title = citation.title;
  return resource;
}

/** 一条失效的引用。 */
export type StaleCitation = {
  objectId: string;
  title: string;
  citation: ResearchCitation;
};

/**
 * 扫出所有失效的引用（过期或缺失）。
 *
 * 只读，不改任何对象：调用方拿到清单后自己决定要不要显式写回。
 */
export function staleCitations(objects: WorkspaceObject[]): StaleCitation[] {
  const out: StaleCitation[] = [];
  for (const object of objects) {
    const citation = object.data?.citation as ResearchCitation | undefined;
    if (!citation || typeof citation !== "object") continue;
    if (citation.status !== "stale" && citation.status !== "missing") continue;
    out.push({ objectId: object.id, title: object.title, citation });
  }
  return out;
}

/** 建立关系时的最小输入。 */
export type ResearchRelationInput = {
  kind: string;
  status: "confirmed" | "inferred";
  basis?: string;
};

/**
 * 关系级领域校验。
 *
 * 支持与反驳都必须给依据：没有依据的「支持」在科研里没有意义。
 * 推测关系另外要求依据，推测不能冒充已确认事实。
 */
export function checkResearchRelation(input: ResearchRelationInput): string[] {
  const errors: string[] = [];
  const spec = researchRelationTypes.find((r) => r.kind === input.kind);
  if (!spec) {
    errors.push(`未知的论证关系类型「${input.kind}」。`);
    return errors;
  }
  if (input.status === "inferred" && !spec.allowsInferred)
    errors.push(`关系「${input.kind}」不允许推测，只能记为已确认。`);
  if (!(input.basis ?? "").trim()) errors.push("支持 / 反驳关系必须给依据。");
  return errors;
}

/** 校验通过后返回可直接写入内核的关系载荷。 */
export function newResearchRelation(input: ResearchRelationInput): {
  kind: string;
  status: "confirmed" | "inferred";
  basis?: string;
} {
  const errors = checkResearchRelation(input);
  if (errors.length) throw new Error(errors.join(" "));
  return {
    kind: input.kind,
    status: input.status,
    ...(input.basis === undefined ? {} : { basis: input.basis }),
  };
}
