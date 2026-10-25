// v3 的行 → 现有组件需要的形状。
//
// 界面这一层不改外观、不改交互：v3 的数据进来以后，先在这里翻译成
// 现有组件认得的结构，组件就不用知道自己接的是哪一套内核。
//
// 类型改名的依据是 01-data-model.md §10.1 的对照表（反查）：
// base.note → text（正文字段 body 也叫 text），base.link / base.media → resource，
// base.code_snippet → code，novel.* / research.* 走现有的领域兜底分支，
// 其余未知类型走现有的「未知组件」占位。

import type { Activity, Board, ComponentPack, SpaceActivity } from "./model.ts";
import { componentTypes, defaultData } from "./spaces.ts";
import type {
  Camera,
  ComponentInstance,
  Space,
  SpaceLink,
  ThemeConfig,
} from "./spaces.ts";
import type { ObjectRelation, WorkspaceObject } from "./objects.ts";
import type {
  V3Cache,
  V3ObjectRow,
  V3PackRow,
  V3PresentationRow,
  V3RelationRow,
} from "./store.ts";

/** v3 类型 → 现有组件类型。 */
const V2_TYPE_BY_V3: Record<string, string> = {
  "base.note": "text",
  "base.heading": "heading",
  "base.link": "resource",
  "base.media": "resource",
  "base.code_snippet": "code",
  "base.metric": "metric",
  "base.status": "status",
  "base.chart": "chart",
  "base.table": "table",
  "base.events": "events",
  "base.task": "task",
  "base.reasoning": "reasoning",
  "base.comparison": "comparison",
  "base.board": "board",
  "novel.character": "character",
  "novel.event": "event",
  "novel.chapter": "chapter",
  "research.hypothesis": "hypothesis",
  "research.evidence": "evidence",
  "research.conclusion": "conclusion",
};

/** 现有组件类型 → v3 类型。 */
const V3_TYPE_BY_V2: Record<string, string> = {
  text: "base.note",
  heading: "base.heading",
  code: "base.code_snippet",
  metric: "base.metric",
  status: "base.status",
  chart: "base.chart",
  table: "base.table",
  events: "base.events",
  task: "base.task",
  reasoning: "base.reasoning",
  comparison: "base.comparison",
  board: "base.board",
  "space-link": "base.board",
  character: "novel.character",
  event: "novel.event",
  chapter: "novel.chapter",
  hypothesis: "research.hypothesis",
  evidence: "research.evidence",
  conclusion: "research.conclusion",
};

/**
 * 关系类型：v3 → 现有的 5 种连线。
 *
 * 现有的连线只有 5 种（相关 / 依赖 / 支持 / 比较 / 从属），
 * 其余关系类型都显示成「相关」——线还是那条线，语义不再细分。
 */
const V2_LINK_BY_V3: Record<string, string> = {
  "base.related": "related",
  "base.depends_on": "depends-on",
  "base.supports": "supports",
  "base.compares": "compares",
  "base.belongs_to": "belongs-to",
};

/** 现有连线类型 → v3 关系类型。 */
const V3_LINK_BY_V2: Record<string, string> = {
  related: "base.related",
  "depends-on": "base.depends_on",
  supports: "base.supports",
  compares: "base.compares",
  "belongs-to": "base.belongs_to",
};

/**
 * 现有界面这一项的类型与内核不一样，写回时要先不写。
 *
 * research.evidence 的 citation：现有界面给的是一段文字，
 * 内核要的是带 kind 与 uri 的对象（packs/research/index.ts）。
 * 硬塞会被内核整条拒绝，所以这一项先不写。
 */
const MISMATCHED_FIELDS: Record<string, string[]> = {
  "research.evidence": ["citation"],
};

/** v3 字段 → 现有字段（读的时候改名）。 */
const FIELD_V3_TO_V2: Record<string, Record<string, string>> = {
  "base.note": { body: "text" },
  "base.media": { caption: "description" },
};

/** 现有字段 → v3 字段（写的时候改名）。 */
const FIELD_V2_TO_V3: Record<string, Record<string, string>> = {
  "base.note": { text: "body" },
  "base.media": { assetId: "blob", description: "caption" },
};

/**
 * v3 类型允许的字段。
 *
 * 与 workbench/packs 目录下各类型的 schema.properties 一一对应
 * （base / novel / research / code 四个包全部列出）：
 * 内核按 schema 校验数据，多一个字段就整条拒绝，
 * 现有界面带的字段比内核多（比如资源的 assetId），
 * 写回去时只留内核认的字段。
 */
export const V3_FIELDS: Record<string, string[]> = {
  "base.board": [],
  "base.frame": [],
  "base.note": ["body"],
  "base.heading": ["level", "text"],
  "base.link": ["description", "url"],
  "base.media": ["alt", "blob", "caption", "mime"],
  "base.code_snippet": ["language", "text"],
  "base.metric": ["description", "unit", "value"],
  "base.status": ["description", "observedAt", "sourceUrl", "state"],
  "base.table": ["columns", "rows"],
  "base.chart": ["kind", "points"],
  "base.events": ["events"],
  "base.task": ["goal", "items"],
  "base.reasoning": ["decision", "evidence", "options", "question", "unknowns"],
  "base.comparison": ["conclusion", "left", "right"],
  "base.tour": ["legacySteps", "purpose"],
  "novel.character": ["age", "arc", "goal", "role", "traits"],
  "novel.event": ["narrativeOrder", "place", "storyTime", "summary"],
  "novel.chapter": ["body", "narrativeOrder", "summary", "wordCount"],
  "research.hypothesis": ["scope", "statement", "testable", "variables"],
  "research.evidence": [
    "citation",
    "method",
    "quote",
    "status",
    "strength",
    "summary",
  ],
  "research.conclusion": ["confidence", "scope", "statement"],
  "code.repository": ["branch", "head", "label"],
  "code.file": ["hash", "path"],
  "code.symbol": ["endLine", "name", "startLine"],
  "code.intent": ["allowedFiles", "arrangement", "request"],
  "code.proposal": [
    "agentId",
    "baseline",
    "decidedAt",
    "decision",
    "digest",
    "explanation",
    "files",
    "intentVersion",
    "testPlan",
    "title",
    "verification",
  ],
  "code.validation": [
    "agentId",
    "command",
    "digest",
    "environment",
    "fingerprint",
    "outcome",
    "output",
    "reportedAt",
    "source",
    "workspaceId",
  ],
};

/**
 * v3 类型 → 现有组件类型。
 *
 * 已知类型按对照表反查；领域类型（novel.* / research.*）去掉包前缀，
 * 交给现有的领域兜底分支；其余类型原样返回，走现有的「未知组件」占位。
 */
export function v2TypeOf(v3Type: string): string {
  const known = V2_TYPE_BY_V3[v3Type];
  if (known) return known;
  if (v3Type.startsWith("novel.") || v3Type.startsWith("research."))
    return v3Type.slice(v3Type.indexOf(".") + 1);
  return v3Type;
}

/**
 * 现有组件类型 → v3 类型。
 *
 * 带附件的资源（assetId）在 v3 里是 base.media 对象，
 * 其余资源是 base.link。
 */
export function v3TypeOf(
  v2Type: string,
  data: Record<string, unknown> = {},
): string {
  if (v2Type === "resource" && data.assetId) return "base.media";
  return V3_TYPE_BY_V2[v2Type] ?? v2Type;
}

/** 现有连线类型 → v3 关系类型。 */
export function v3LinkOf(v2Kind: string): string {
  /* 已经是「包.关系」的名字原样进内核。未知的短名字仍落到「相关」。 */
  if (v2Kind.includes(".")) return v2Kind;
  return V3_LINK_BY_V2[v2Kind] ?? "base.related";
}

/** v3 关系类型 → 现有连线类型。 */
export function v2LinkOf(v3Kind: string): string {
  return V2_LINK_BY_V3[v3Kind] ?? "related";
}

/**
 * 现有组件读得懂的载荷。
 *
 * 改名之外还要换形状：base.media 的附件是 blob，
 * 现有组件认的是 assetId（附件编号）。
 */
export function v2DataOf(
  v3Type: string,
  data: Record<string, unknown>,
  objectId?: string,
): Record<string, unknown> {
  const renames = FIELD_V3_TO_V2[v3Type] ?? {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data ?? {})) {
    out[renames[key] ?? key] = value;
  }
  if (v3Type === "base.media") {
    if (typeof out.blob === "string") out.assetId = out.blob;
  }
  if (v3Type === "base.board" && objectId) {
    /* 现有界面用 spaceId 找到「进入白板」要去的那块白板。 */
    out.spaceId = objectId;
  }
  return out;
}

/** 现有字段 → v3 字段（写的时候改名）。 */
export function v3FieldOf(v3Type: string, key: string): string {
  return (FIELD_V2_TO_V3[v3Type] ?? {})[key] ?? key;
}

/** 现有载荷 → 内核认的载荷：改名，并去掉内核不认的字段。 */
export function v3DataOf(
  v3Type: string,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const allowed = V3_FIELDS[v3Type];
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data ?? {})) {
    const name = v3FieldOf(v3Type, key);
    if (allowed && !allowed.includes(name)) continue;
    /* 现有界面这一项的类型与内核不一样：内核会整条拒绝，这一项先不写。 */
    if (MISMATCHED_FIELDS[v3Type]?.includes(key)) continue;
    out[name] = value;
  }
  return out;
}

/** 白板对象（base.board）是不是一块可以进入的白板。 */
const isBoardType = (type: string) => type === "base.board";

/** 一行对象 → 现有的内容对象。 */
function toContentObject(row: V3ObjectRow): WorkspaceObject {
  return {
    id: row.id,
    kind: "native",
    type: v2TypeOf(row.type),
    typeVersion: row.typeVersion,
    title: row.title,
    data: v2DataOf(row.type, row.data ?? {}, row.id),
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    author: row.updatedBy || row.createdBy,
  };
}

/** 一行展示 → 现有的展示实例。 */
function toInstance(
  row: V3PresentationRow,
  object: V3ObjectRow | undefined,
): ComponentInstance {
  const type = object ? v2TypeOf(object.type) : "text";
  return {
    id: row.id,
    /* 展示挂在哪块白板上，就用哪块白板的编号当空间编号。 */
    spaceId: row.boardId,
    type,
    binding: { kind: "object", objectId: row.objectId },
    objectId: row.objectId,
    ...(row.appearance && Object.keys(row.appearance).length
      ? {
          appearance: {
            ...(row.appearance.detail
              ? { detail: row.appearance.detail as "full" | "label" | "icon" }
              : {}),
            ...(row.appearance.accent ? { icon: row.appearance.accent } : {}),
          },
        }
      : {}),
    title: object?.title ?? "",
    data: object ? v2DataOf(object.type, object.data ?? {}, object.id) : {},
    rect: {
      x: row.x,
      y: row.y,
      width: row.width,
      height: row.height,
      /* v3 的 locked（锁住）与现有界面的固定位置是一回事：
         锁住的展示不能拖动，也不能改尺寸。 */
      pinned: row.locked,
    },
    ...(row.parentId ? { parentId: row.parentId } : {}),
    z: row.z,
    updatedAt: row.updatedAt,
    author: row.updatedBy,
  };
}

/** 一行关系 → 现有的语义关系。 */
function toObjectRelation(row: V3RelationRow): ObjectRelation {
  return {
    id: row.id,
    source: row.sourceId,
    target: row.targetId,
    kind: v2LinkOf(row.kind),
    status: row.status,
    ...(row.attributes && Object.keys(row.attributes).length
      ? { attributes: row.attributes }
      : {}),
    ...(row.basis ? { basis: row.basis } : {}),
    createdAt: row.createdAt,
    author: row.updatedBy || row.createdBy,
  };
}

/** 现有的组件包：v3 的数据包按预设列出来。 */
function toComponentPack(row: V3PackRow): ComponentPack {
  const manifest = (row.manifest ?? {}) as Record<string, any>;
  const presets = (manifest.presets ?? []) as Record<string, any>[];
  return {
    id: row.id,
    name: String(manifest.title ?? row.id),
    version: row.version,
    description: manifest.description
      ? String(manifest.description)
      : undefined,
    homepage: undefined,
    source: "json",
    importedAt: 0,
    importedBy: "human",
    components: presets.map((preset) => ({
      key: String(preset.key ?? ""),
      type: String(preset.type ?? ""),
      title: String(preset.title ?? ""),
      ...(preset.data ? { data: preset.data } : {}),
      ...(preset.width ? { width: preset.width } : {}),
      ...(preset.height ? { height: preset.height } : {}),
    })),
  };
}

/** 外观：设置表里的 theme 就是现有的主题配置。 */
function toTheme(
  settings: Map<string, { value: unknown }>,
): ThemeConfig | null {
  const row = settings.get("theme");
  const value = row?.value;
  if (!value || typeof value !== "object") return null;
  return value as ThemeConfig;
}

/** 界面这一侧看到的视角。 */
export type V3View = {
  id: string;
  spaceId: string;
  selection: string[];
  camera: Camera;
  updatedAt: number;
};

const ACTIVITY_STATES = new Set(["running", "waiting", "done", "unknown"]);

/** app_activity 的一行。只取界面用得上的字段。 */
export type ReportedActivity = {
  actor?: unknown;
  state?: unknown;
  task?: unknown;
  action?: unknown;
  boardId?: unknown;
  objectIds?: unknown;
  reportedAt?: unknown;
};

/**
 * 活动报告 → 现有界面的两份列表。
 *
 * 徽标读 activities；「AI 编排」面板和卡片上的标记读 spaceActivities。
 * 活动只标对象编号，面板上的「查看」要的是展示编号，这里按对象对上。
 */
export function toReportedActivities(
  rows: readonly ReportedActivity[],
  presentations: Iterable<V3PresentationRow>,
): { activities: Activity[]; spaceActivities: SpaceActivity[] } {
  const live = [...presentations].filter((row) => !row.deleted);
  const activities: Activity[] = [];
  const spaceActivities: SpaceActivity[] = [];
  for (const row of rows) {
    const state =
      typeof row.state === "string" && ACTIVITY_STATES.has(row.state)
        ? (row.state as Activity["state"])
        : "unknown";
    const objectIds = Array.isArray(row.objectIds)
      ? row.objectIds.filter((id): id is string => typeof id === "string")
      : [];
    const spaceId = typeof row.boardId === "string" ? row.boardId : "";
    const reportedAt =
      typeof row.reportedAt === "number" && Number.isFinite(row.reportedAt)
        ? row.reportedAt
        : 0;
    const shared = {
      agentId: String(row.actor ?? ""),
      task: String(row.task ?? ""),
      action: String(row.action ?? ""),
      state,
      reportedAt,
      stale: false,
    };
    activities.push({ ...shared, workspaceId: "", objectIds });
    const onBoard = spaceId
      ? live.filter(
          (item) =>
            item.boardId === spaceId && objectIds.includes(item.objectId),
        )
      : [];
    const matched = onBoard.length
      ? onBoard
      : live.filter((item) => objectIds.includes(item.objectId));
    spaceActivities.push({
      ...shared,
      spaceId,
      instanceIds: matched.map((item) => item.id),
    });
  }
  return { activities, spaceActivities };
}

/**
 * 缓存 → 现有的白板。
 *
 * 现有组件要的字段这里一次给全：v3 没有的部分给空值，
 * 组件读不到就当没有（不要让组件知道内核是哪一版）。
 */
export function toBoard(
  cache: V3Cache,
  options: {
    /** 当前显示的白板。 */
    boardId: string;
    /** 界面的视角（选择与镜头由界面自己掌握）。 */
    view: V3View;
    /** 活动报告：Agent 在哪里。徽标读这一份。 */
    activities?: Board["activities"];
    /** 活动报告：AI 面板和卡片标记读这一份。 */
    spaceActivities?: Board["spaceActivities"];
  },
): Board {
  const presentations = [...cache.presentations.values()].filter(
    (p) => p.boardId === options.boardId,
  );
  const objects = presentations
    .map((p) => cache.objects.get(p.objectId))
    .filter((o): o is V3ObjectRow => Boolean(o));
  const instances = presentations.map((p) =>
    toInstance(p, cache.objects.get(p.objectId)),
  );
  /* 白板对象：既是空间列表里的一项，也是画布上一张「进入白板」的卡片。 */
  const spaces: Space[] = [];
  const spaceIds = new Set<string>();
  const addSpace = (id: string, title: string, parentId?: string) => {
    if (spaceIds.has(id)) return;
    spaceIds.add(id);
    spaces.push({ id, title, ...(parentId ? { parentId } : {}) });
  };
  /* 摆放着某个白板对象的那块白板，就是它的父白板。 */
  const parentOf = (objectId: string): string | undefined => {
    for (const presentation of cache.presentations.values()) {
      if (presentation.objectId === objectId) return presentation.boardId;
    }
    return undefined;
  };
  const boardObject = cache.objects.get(options.boardId);
  addSpace(
    options.boardId,
    boardObject?.title ?? "白板",
    parentOf(options.boardId),
  );
  for (const instance of instances) {
    const object = cache.objects.get(instance.objectId ?? "");
    if (!object || !isBoardType(object.type)) continue;
    addSpace(object.id, object.title, instance.spaceId);
  }
  const relations = [...cache.relations.values()].filter(
    (r) => cache.objects.has(r.sourceId) && cache.objects.has(r.targetId),
  );
  /* 现有界面画的是实例之间的连线：两端都要在这块白板上。 */
  const instanceByObject = new Map(
    instances.map((i) => [i.objectId, i.id] as const),
  );
  const spaceLinks: SpaceLink[] = relations
    .filter(
      (r) =>
        instanceByObject.has(r.sourceId) && instanceByObject.has(r.targetId),
    )
    .map((r) => ({
      id: r.id,
      source: instanceByObject.get(r.sourceId)!,
      target: instanceByObject.get(r.targetId)!,
      kind: v2LinkOf(r.kind) as SpaceLink["kind"],
      description: r.basis ?? "",
      author: r.updatedBy || r.createdBy,
    }));
  const packs = [...cache.packs.values()]
    .filter((p) => p.kind === "data")
    .map(toComponentPack);
  return {
    id: options.boardId,
    revision: cache.revision,
    title: boardObject?.title ?? "白板",
    expiresAt: 0,
    selection: options.view.selection
      .map((id) => instances.find((i) => i.id === id)?.objectId)
      .filter((id): id is string => Boolean(id)),
    placements: {},
    notes: {},
    groups: [],
    activities: options.activities ?? [],
    spaceActivities: options.spaceActivities ?? [],
    explanations: [],
    guides: [],
    spaces,
    instances,
    views: { [options.view.id]: options.view },
    spaceLinks,
    assets: [],
    componentPacks: packs,
    theme: toTheme(cache.settings),
    intents: [],
    proposals: [],
    validations: [],
    contentObjects: objects.map(toContentObject),
    objectRelations: relations.map(toObjectRelation),
    resources: [],
    contentRevision: cache.revision,
    history: { version: 2, entries: [] },
    audit: [],
    workspaces: [],
    objects: [],
    relations: [],
  };
}

/** v3 的一条命令。 */
export type V3Command = { op: string; [key: string]: unknown };

/** 写一次要用的上下文。 */
export type WriteContext = {
  /** 当前白板。 */
  boardId: string;
  /** 界面这一侧看到的对象与展示。 */
  objects: Map<string, V3ObjectRow>;
  presentations: Map<string, V3PresentationRow>;
};

/** 白板预设：新建一块白板时里面先放什么。 */
const BOARD_PRESETS: Record<string, [string, string][]> = {
  bug: [
    ["task", "目标与验收条件"],
    ["reasoning", "行为约定与未知项"],
    ["resource", "复现材料"],
  ],
  research: [
    ["comparison", "两次实验的比较"],
    ["chart", "实验指标"],
    ["metric", "当前关注指标"],
    ["reasoning", "证据与未知项"],
    ["task", "下一步检查"],
  ],
};

/** 组件类型 → 内核认的类型（写的时候用）。 */
const sizeOf = (type: string) =>
  componentTypes.find((c) => c.type === type)?.width ?? 280;

/**
 * 版本对不上时能做什么。
 *
 * 界面自己连着写两次（先标题、后正文）时，两次改的不是同一处：
 * 第二次可以拿着新版本再写一次。
 * 别人改了同一处，就要把冲突照实报出来，不能盖掉别人的改动。
 */
export function v3RetryInfo(
  op: any,
  ctx: WriteContext,
): { version: number; sameFields: boolean } | undefined {
  const presentation = ctx.presentations.get(String(op.instanceId));
  const object = presentation
    ? ctx.objects.get(presentation.objectId)
    : undefined;
  if (!object) return undefined;
  const data = object.data ?? {};
  let sameFields = true;
  const base = (op.baseData ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(base)) {
    if (
      JSON.stringify(data[v3FieldOf(object.type, key)]) !==
      JSON.stringify(value)
    )
      sameFields = false;
  }
  if (op.baseTitle !== undefined && op.baseTitle !== object.title)
    sameFields = false;
  return { version: object.version, sameFields };
}

/**
 * 现有的一次白板操作 → v3 的命令。
 *
 * 界面这一侧的操作名与形状都不变，翻译只在这里发生：
 * 组件里不出现任何 v3 的名词。
 */
function pasteNumber(value: unknown, label: string): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number))
    throw Error(`粘贴用的${label}不是有效数字。请重新复制后再试。`);
  return number;
}

function pasteAppearance(value: unknown):
  | {
      detail?: "full" | "label" | "icon";
      accent?: string;
      coverBlob?: string;
    }
  | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const appearance: {
    detail?: "full" | "label" | "icon";
    accent?: string;
    coverBlob?: string;
  } = {};
  if (raw.detail === "full" || raw.detail === "label" || raw.detail === "icon")
    appearance.detail = raw.detail;
  if (typeof raw.accent === "string" && raw.accent)
    appearance.accent = raw.accent;
  if (typeof raw.coverBlob === "string" && /^[a-f0-9]{64}$/.test(raw.coverBlob))
    appearance.coverBlob = raw.coverBlob;
  return Object.keys(appearance).length ? appearance : undefined;
}

export function toCommands(op: any, ctx: WriteContext): V3Command[] {
  const commands: V3Command[] = [];
  const kind = String(op?.kind ?? "");
  switch (kind) {
    case "create": {
      const v2Type = String(op.type ?? "text");
      const data = (op.data ?? {}) as Record<string, unknown>;
      const v3Type = v3TypeOf(v2Type, data);
      const rect = op.rect as
        { x: number; y: number; width: number; height: number } | undefined;
      const place = (objectId: string, boardId: string, ref?: string) => ({
        op: "presentation.create",
        ...(ref ? { ref } : {}),
        boardId,
        objectId,
        ...(rect ? { x: rect.x, y: rect.y } : {}),
        ...(rect ? { width: rect.width, height: rect.height } : {}),
      });
      if (op.objectId) {
        /* 摆一个已经存在的对象：内容共享，布局独立。 */
        commands.push(place(String(op.objectId), ctx.boardId));
        break;
      }
      commands.push({
        op: "object.create",
        ref: "new",
        type: v3Type,
        title: String(op.title ?? ""),
        data: v3DataOf(v3Type, data),
      });
      /* 展示也要一个 ref：内核回传 created 的时候才知道新卡片的编号，
         选中要的是展示编号（v2 里建完就选中，属性面板会打开）。 */
      commands.push(place("@new", ctx.boardId, "newP"));
      /* 新建的白板里先放预设内容：预设也是对象与展示。 */
      if (v2Type === "board") {
        const definitions = BOARD_PRESETS[String(data.preset ?? "")] ?? [];
        definitions.forEach(([type, title], index) => {
          const presetType = v3TypeOf(type);
          commands.push({
            op: "object.create",
            ref: `preset${index}`,
            type: presetType,
            title,
            data: v3DataOf(presetType, defaultData(type)),
          });
          commands.push({
            op: "presentation.create",
            boardId: "@new",
            objectId: `@preset${index}`,
            x: (index % 2) * 380,
            y: Math.floor(index / 2) * 270,
            width: sizeOf(type),
            height: 180,
          });
        });
      }
      break;
    }
    case "update": {
      const presentation = ctx.presentations.get(String(op.instanceId));
      if (!presentation)
        throw Error("这个组件已经不在白板上了。请刷新后再试。");
      /* 外观属于这一次展示，内容属于对象：两件事分开落地。 */
      if (op.appearance) {
        commands.push({
          op: "presentation.update",
          id: presentation.id,
          appearance: { detail: op.appearance.detail },
        });
      }
      const object = ctx.objects.get(presentation.objectId);
      if (!object) break;
      const set: Record<string, unknown> = {};
      /* 人物没有姓名字段，标题就是名字。旧表单仍交 name，写到标题上。 */
      let nameAsTitle: string | undefined;
      if (op.data) {
        const base = (op.baseData ?? {}) as Record<string, unknown>;
        const next = op.data as Record<string, unknown>;
        const allowed = V3_FIELDS[object.type];
        for (const key of Object.keys(next)) {
          /* 只写真正改动的字段：别人同时改过的字段不能被这一笔盖掉。 */
          if (JSON.stringify(base[key]) === JSON.stringify(next[key])) continue;
          const mapped = v3FieldOf(object.type, key);
          if (allowed && !allowed.includes(mapped)) {
            if (
              object.type === "novel.character" &&
              key === "name" &&
              typeof next[key] === "string"
            )
              nameAsTitle = next[key];
            continue;
          }
          set[mapped] = next[key];
        }
      }
      /* 标题跟编辑器的基线比，不跟缓存比：缓存可能已经是新标题了
         （上一次保存刚写进去），拿缓存比会把这次该写的标题丢掉。 */
      const baselineTitle =
        op.baseTitle !== undefined ? String(op.baseTitle) : object.title;
      const explicitTitle =
        op.title !== undefined && op.title !== baselineTitle
          ? String(op.title)
          : undefined;
      const title =
        explicitTitle ??
        (nameAsTitle !== undefined && nameAsTitle !== baselineTitle
          ? nameAsTitle
          : undefined);
      if (title !== undefined || Object.keys(set).length)
        commands.push({
          op: "object.update",
          id: object.id,
          /* 版本用编辑器捕获的那一版：那是人看到的那份内容的版本。
             别人在这期间改过这个对象，内核会挡下来。 */
          ...(op.expectedVersion !== undefined
            ? { expectedVersion: op.expectedVersion }
            : {}),
          ...(title !== undefined ? { title } : {}),
          ...(Object.keys(set).length ? { set } : {}),
        });
      break;
    }
    case "place": {
      for (const item of op.items ?? []) {
        const presentation = ctx.presentations.get(String(item.id));
        if (!presentation) continue;
        const rect = (item.rect ?? {}) as Record<string, number | boolean>;
        const set: Record<string, unknown> = {};
        if (typeof rect.x === "number" && rect.x !== presentation.x)
          set.x = rect.x;
        if (typeof rect.y === "number" && rect.y !== presentation.y)
          set.y = rect.y;
        if (typeof rect.width === "number" && rect.width !== presentation.width)
          set.width = rect.width;
        if (
          typeof rect.height === "number" &&
          rect.height !== presentation.height
        )
          set.height = rect.height;
        /* 固定位置在 v3 里就是锁住：位置被锁住时内核拒绝移动。 */
        if (
          typeof rect.pinned === "boolean" &&
          rect.pinned !== presentation.locked
        )
          set.locked = rect.pinned;
        if (Object.keys(set).length)
          commands.push({
            op: "presentation.update",
            id: presentation.id,
            ...set,
          });
      }
      break;
    }
    case "remove": {
      const ids = Array.isArray(op.instanceIds)
        ? op.instanceIds.map((id: unknown) => String(id))
        : op.instanceId !== undefined
          ? [String(op.instanceId)]
          : [];
      for (const id of ids) {
        const presentation = ctx.presentations.get(id);
        if (!presentation) continue;
        commands.push({ op: "presentation.delete", id: presentation.id });
      }
      break;
    }
    case "link": {
      const source = ctx.presentations.get(String(op.source));
      const target = ctx.presentations.get(String(op.target));
      if (!source || !target)
        throw Error("要连接的两个组件里有一个已经不在白板上了。请刷新后再试。");
      const kind = v3LinkOf(String(op.relation ?? "related"));
      const description = String(op.description ?? "");
      commands.push({
        op: "relation.create",
        kind,
        sourceId: source.objectId,
        targetId: target.objectId,
        /* 有些关系类型必须写明依据：没写就用一句人话兜底。 */
        ...(kind === "base.supports" || description
          ? { basis: description || "在白板上建立的关系" }
          : {}),
      });
      break;
    }
    case "unlink": {
      commands.push({ op: "relation.delete", id: String(op.linkId) });
      break;
    }
    case "theme": {
      commands.push({
        op: "setting.set",
        key: "theme",
        value: op.theme ?? null,
      });
      break;
    }
    case "duplicate": {
      const presentation = ctx.presentations.get(String(op.instanceId));
      const object = presentation
        ? ctx.objects.get(presentation.objectId)
        : undefined;
      if (!presentation || !object) break;
      commands.push({ op: "object.clone", id: object.id, ref: "copy" });
      commands.push({
        op: "presentation.create",
        boardId: ctx.boardId,
        objectId: "@copy",
        x: presentation.x + 40,
        y: presentation.y + 40,
        width: presentation.width,
        height: presentation.height,
      });
      break;
    }
    case "present": {
      const object = ctx.objects.get(String(op.objectId));
      if (!object) break;
      commands.push({
        op: "presentation.create",
        boardId: ctx.boardId,
        objectId: object.id,
      });
      break;
    }
    case "copyObject": {
      const presentation = ctx.presentations.get(String(op.instanceId));
      const object = presentation
        ? ctx.objects.get(presentation.objectId)
        : undefined;
      if (!presentation || !object) break;
      commands.push({ op: "object.clone", id: object.id, ref: "copy" });
      commands.push({
        op: "presentation.create",
        boardId: ctx.boardId,
        objectId: "@copy",
        x: presentation.x,
        y: presentation.y,
        width: presentation.width,
        height: presentation.height,
      });
      commands.push({ op: "presentation.delete", id: presentation.id });
      break;
    }
    case "move": {
      const presentation = ctx.presentations.get(String(op.instanceId));
      if (!presentation) break;
      const target = String(op.spaceId);
      if (target === presentation.boardId) break;
      commands.push({ op: "presentation.delete", id: presentation.id });
      commands.push({
        op: "presentation.create",
        boardId: target,
        objectId: presentation.objectId,
        x: 24,
        y: 24,
        width: presentation.width,
        height: presentation.height,
      });
      break;
    }
    case "paste": {
      const mode = op.mode === "clone" ? "clone" : "reference";
      const items = Array.isArray(op.items) ? op.items : [];
      if (!items.length) throw Error("没有可粘贴的展示。请先选中并复制。");
      const per = mode === "clone" ? 2 : 1;
      if (items.length * per > 200)
        throw Error("一次最多写入 200 条命令。请缩小选择后再试。");
      const normalized = items.map((item: any) => {
        const objectId = String(item?.objectId ?? "");
        if (!objectId)
          throw Error("剪贴板里有一条展示缺少源对象。请重新复制。");
        const width = pasteNumber(item?.width, "宽度");
        const height = pasteNumber(item?.height, "高度");
        if (width <= 0 || height <= 0)
          throw Error("粘贴用的宽高必须大于 0。请重新复制后再试。");
        return {
          objectId,
          x: pasteNumber(item?.x, "横坐标"),
          y: pasteNumber(item?.y, "纵坐标"),
          width,
          height,
          appearance: pasteAppearance(item?.appearance),
        };
      });
      normalized.forEach(
        (
          item: {
            objectId: string;
            x: number;
            y: number;
            width: number;
            height: number;
            appearance?: {
              detail?: "full" | "label" | "icon";
              accent?: string;
              coverBlob?: string;
            };
          },
          index: number,
        ) => {
          if (mode === "clone")
            commands.push({
              op: "object.clone",
              id: item.objectId,
              ref: `copy${index}`,
            });
          commands.push({
            op: "presentation.create",
            ref: `paste${index}`,
            boardId: ctx.boardId,
            objectId: mode === "clone" ? `@copy${index}` : item.objectId,
            x: item.x,
            y: item.y,
            width: item.width,
            height: item.height,
            ...(item.appearance ? { appearance: item.appearance } : {}),
          });
        },
      );
      break;
    }
    case "group": {
      const ids = Array.from(
        new Set<string>((op.ids ?? []).map((id: unknown) => String(id))),
      );
      const members = ids
        .map((id) => ctx.presentations.get(id))
        .filter((p): p is V3PresentationRow => Boolean(p));
      if (members.length < 2) throw Error("请先选中两个以上的组件再分组。");
      const left = Math.min(...members.map((m) => m.x)) - 12;
      const top = Math.min(...members.map((m) => m.y)) - 12;
      const right = Math.max(...members.map((m) => m.x + m.width)) + 12;
      const bottom = Math.max(...members.map((m) => m.y + m.height)) + 12;
      commands.push({
        op: "object.create",
        ref: "frame",
        type: "base.frame",
        title: String(op.title ?? "分组"),
        data: {},
      });
      commands.push({
        op: "presentation.create",
        ref: "frame",
        boardId: ctx.boardId,
        objectId: "@frame",
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
      });
      for (const member of members)
        commands.push({
          op: "presentation.update",
          id: member.id,
          parentId: "@frame",
        });
      break;
    }
    default:
      throw Error(`这一版内核还不支持「${kind}」这个操作。`);
  }
  return commands;
}
