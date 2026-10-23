// 把 v2 的 workspace.json 一次性导入成 v3 的 workspace.db。
//
// 映射规则见 docs/kernel-v3/01-data-model.md §10；类型改名见 §10.1。
// v2 的目录在 T24 会被删掉，所以这个文件不 import workbench/core/ 的任何代码：
// 读文件靠 ./v2-migrate.ts（从 v2 复制过来的迁移链），写文件直接写行
//（§9 的 V8：唯一例外就是 kernel/legacy/import-v2.ts）。

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  getMeta,
  openWorkspaceDb,
  setMeta,
  transaction,
  type Db,
} from "../db.ts";
import { newId } from "../ids.ts";
import { createRegistry, PackSpecError, type Registry } from "../registry.ts";
import type { Appearance, ExternalLocator, ObjectSource } from "../types.ts";
import {
  readV2Workspace,
  V2MigrationError,
  type V2Asset,
  type V2Board,
  type V2ComponentPack,
  type V2Evidence,
  type V2Group,
  type V2ObjectSource,
  type V2Presentation,
  type V2Workspace,
} from "./v2-migrate.ts";

/** 导入报告里的一条记录：跳过了什么、为什么。 */
export type ImportSkipped = { what: string; reason: string };

/**
 * 一次导入的结果。
 *
 * skipped 是「没能映射进新库」的东西；warnings 是「映射进来了，但新版本不认
 * （旧字段、缺依据的名字匹配等）」。两者分开，是因为前者是丢数据，后者不是。
 */
export type ImportReport = {
  /** 来源文件。 */
  from: string;
  objects: number;
  presentations: number;
  relations: number;
  skipped: ImportSkipped[];
  warnings: ImportSkipped[];
};

/** v2 的类型名 → v3 的类型名（docs/kernel-v3/01-data-model.md §10.1）。 */
const BASE_TYPES: Record<string, string> = {
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
};

const NOVEL_TYPES: Record<string, string> = {
  character: "novel.character",
  event: "novel.event",
  chapter: "novel.chapter",
};

const RESEARCH_TYPES: Record<string, string> = {
  hypothesis: "research.hypothesis",
  evidence: "research.evidence",
  conclusion: "research.conclusion",
};

/**
 * 空间链接的 kind。对象关系的 kind 不在 §10.1 里，原样保留，不在这里改名。
 */
const SPACE_LINK_KINDS: Record<string, string> = {
  related: "base.related",
  "depends-on": "base.depends_on",
  supports: "base.supports",
  compares: "base.compares",
  "belongs-to": "base.belongs_to",
};

/** v3 的对象标题上限（与内核写入路径一致）。 */
const TITLE_LIMIT = 300;
/** 提案里单个文件内容超过这个大小就写进附件区。 */
const BLOB_THRESHOLD = 1024 * 1024;
/**
 * 分组框的留白：和 v2 画布画分组框时一样（左右 12、上 28、下 12）。
 * 见 workbench/board/SpaceCanvas.tsx 画分组框的那段。
 */
const FRAME_PADDING_X = 12;
const FRAME_PADDING_TOP = 28;
const FRAME_PADDING_BOTTOM = 12;
/** 导入的写入算一次修订。 */
const IMPORT_REV = 1;

/** 一个矩形。 */
export type Rect = { x: number; y: number; width: number; height: number };

/**
 * 分组框的位置与大小：包住组内的所有展示。
 *
 * v2 的分组没有自己的位置，画布是按组员的外接矩形加留白画出来的，
 * 所以这里按同一套留白算，导入后看到的框和 v2 里看到的一样。
 */
export function groupFrameBox(members: readonly Rect[]): Rect {
  if (!members.length) return { x: 0, y: 0, width: 1, height: 1 };
  const left = Math.min(...members.map((m) => m.x)) - FRAME_PADDING_X;
  const top = Math.min(...members.map((m) => m.y)) - FRAME_PADDING_TOP;
  const right =
    Math.max(...members.map((m) => m.x + m.width)) + FRAME_PADDING_X;
  const bottom =
    Math.max(...members.map((m) => m.y + m.height)) + FRAME_PADDING_BOTTOM;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * 把白板上的绝对坐标换算成相对分组框左上角的坐标。
 *
 * v2 的展示坐标是白板上的绝对坐标，v3 的框内展示坐标是相对框左上角的
 * （docs/kernel-v3/01-data-model.md §4 的 parent_id 注释）。换算只在这一处，
 * 口径变了只改这里和 groupFrameBox。
 */
export function toFrameRelative(
  frame: Rect,
  point: { x: number; y: number },
): { x: number; y: number } {
  return { x: point.x - frame.x, y: point.y - frame.y };
}

/** v2 的类型名换成 v3 的类型名。 */
export function mapV2Type(type: string, data: Record<string, unknown>): string {
  if (type === "text") return BASE_TYPES.text!;
  if (type === "heading") return BASE_TYPES.heading!;
  if (type === "code") return BASE_TYPES.code!;
  if (type === "resource") {
    if (typeof data.url === "string" && data.url) return "base.link";
    if (typeof data.assetId === "string" && data.assetId) return "base.media";
    return "base.link";
  }
  if (BASE_TYPES[type]) return BASE_TYPES[type]!;
  if (NOVEL_TYPES[type]) return NOVEL_TYPES[type]!;
  if (RESEARCH_TYPES[type]) return RESEARCH_TYPES[type]!;
  return `legacy.${type}`;
}

/** 空间链接的 kind 换成 v3 的关系名。对象关系不走这里。 */
export function mapV2RelationKind(kind: string): string {
  return SPACE_LINK_KINDS[kind] ?? kind;
}

/** 导入过程中的上下文：写到哪里、已经写了什么。 */
type Ctx = {
  db: Db;
  registry: Registry;
  now: number;
  dbFile: string;
  jsonFile: string;
  report: ImportReport;
  /** 已经写入的对象 id。 */
  objectIds: Set<string>;
  /** 对象 id → 类型名（用来找默认尺寸）。 */
  objectType: Map<string, string>;
  /** 对象 id → 标题（用来在报告里说清是哪个对象占了 id）。 */
  objectTitle: Map<string, string>;
  /** 已经写入的关系 id。 */
  relationIds: Set<string>;
  /** v2 的「白板序号:分区 id」→ v3 的白板对象 id。 */
  spaceMap: Map<string, string>;
  /** v2 的展示 id → 它绑定的 v3 对象 id。 */
  presentationObject: Map<string, string>;
  /**
   * v2 的展示 id → 它在 v3 里的位置和所在白板。
   *
   * 这里存的是 v2 的绝对坐标（白板上的位置）；数据库里存的展示坐标在框内
   * 是相对框左上角的，换算见 toFrameRelative。
   */
  presentationRect: Map<string, Rect & { boardId: string }>;
  /** 标题 → 同名对象的 id 列表（用来给名单匹配出建议）。 */
  titles: Map<string, string[]>;
  /** 已经导入的数据包 id。 */
  packIds: Set<string>;
  /** 已写入 blobs 的附件：v2 asset id → sha256 与 mime。 */
  assetsById: Map<string, { sha: string; mime: string }>;
  /** 由 v2 分区变成的白板对象 id（用来发现展示被改绑到分区上）。 */
  spaceObjectIds: Set<string>;
  /** 这次导入写出去的附件文件路径；事务失败时要删掉，不能留孤儿文件。 */
  writtenBlobs: string[];
  /** 校验组件包清单用的暂存注册表：和内核写库前用的是同一套规则。 */
  staged: Registry;
};

type ObjectInput = {
  id: string;
  type: string;
  title: string;
  data: Record<string, unknown>;
  source?: ObjectSource | null;
  version?: number;
  createdAt?: number;
  updatedAt?: number;
  author?: string;
};

/**
 * 把 v2 的 workspace.json 导入成一个新的 workspace.db。
 *
 * 读失败抛错，不创建任何文件；写失败删掉半成品数据库再抛错，旧的 workspace.json 不动。
 */
export function importV2(
  jsonFile: string,
  dbFile: string,
  registry: Registry,
  now: () => number,
): ImportReport {
  if (existsSync(dbFile))
    throw new V2MigrationError(
      `这个工作空间已经有 ${dbFile} 了，没有重复导入。要重新导入请先把旧数据库挪走。`,
    );
  const workspace = readV2Workspace(jsonFile);
  const timestamp = now();
  const report: ImportReport = {
    from: jsonFile,
    objects: 0,
    presentations: 0,
    relations: 0,
    skipped: [],
    warnings: [],
  };
  mkdirSync(dirname(dbFile), { recursive: true });
  const db = openWorkspaceDb(dbFile, {
    create: true,
    workspaceId: workspace.id,
    title: workspace.title,
    now: () => timestamp,
  });
  const ctx = createCtx(db, registry, timestamp, jsonFile, dbFile, report);
  try {
    writeAll(ctx, workspace);
  } catch (error) {
    try {
      db.close();
    } catch {
      /* 连接可能已经关掉 */
    }
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        rmSync(dbFile + suffix);
      } catch {
        /* 半成品文件可能不存在 */
      }
    }
    // 事务回滚了，附件字节却已经落盘：一起删掉，不留孤儿文件。
    for (const file of ctx.writtenBlobs) {
      try {
        rmSync(file, { force: true });
      } catch {
        /* 删不掉就留着，但不能盖掉原来的错误 */
      }
    }
    throw error;
  }
  db.close();
  return report;
}

function createCtx(
  db: Db,
  registry: Registry,
  now: number,
  jsonFile: string,
  dbFile: string,
  report: ImportReport,
): Ctx {
  return {
    db,
    registry,
    now,
    dbFile,
    jsonFile,
    report,
    objectIds: new Set(),
    objectType: new Map(),
    objectTitle: new Map(),
    relationIds: new Set(),
    spaceMap: new Map(),
    presentationObject: new Map(),
    presentationRect: new Map(),
    titles: new Map(),
    packIds: new Set(),
    assetsById: new Map(),
    spaceObjectIds: new Set(),
    writtenBlobs: [],
    staged: stageRegistry(registry),
  };
}

/**
 * 暂存注册表：和内核写命令前用的一样（kernel/commands.ts 的 stageRegistry）。
 * 组件包清单先在这里过一遍，不合格的不写库。
 */
function stageRegistry(registry: Registry): Registry {
  const staged = createRegistry();
  for (const pack of registry.listPacks())
    staged.registerPack(pack.spec, pack.kind);
  return staged;
}

function writeAll(ctx: Ctx, workspace: V2Workspace): void {
  transaction(ctx.db, () => {
    importObjects(ctx, workspace);
    importSpaces(ctx, workspace);
    importAssets(ctx, workspace);
    importCodeFlow(ctx, workspace);
    importGuides(ctx, workspace);
    importPresentations(ctx, workspace);
    linkResourceBlobs(ctx);
    importGroups(ctx, workspace);
    importNotes(ctx, workspace);
    importRelations(ctx, workspace);
    importSpaceLinks(ctx, workspace);
    importParticipants(ctx);
    importTheme(ctx, workspace);
    importPacks(ctx, workspace);
    importAudit(ctx, workspace);
    finalize(ctx, workspace);
  });
}

/**
 * v2 的每个分区变成一个 base.board 对象，id 不变。
 *
 * 分区的 id 撞上别的对象时分区改名；改出来的名字再撞上，就由 insertObject
 * 另起一个 id。所以最后用的是 insertObject 返回的那个 id，索引里也记它：
 * 首页和分区入口的展示都得指着分区自己，不能指到占名字的内容对象上。
 */
function importSpaces(ctx: Ctx, workspace: V2Workspace): void {
  workspace.boards.forEach((board, index) => {
    for (const space of board.spaces) {
      if (!space.id) {
        ctx.report.skipped.push({
          what: `白板「${board.title}」里的一个分区`,
          reason: "分区没有 id，没有导入。",
        });
        continue;
      }
      const key = spaceKey(index, space.id);
      if (ctx.spaceMap.has(key)) continue;
      const wanted = space.id;
      // 分区 id 已经被别的对象占了：分区改名，占着 id 的那个对象保留原 id。
      const planned = ctx.objectIds.has(wanted)
        ? `${board.id}:${wanted}`
        : wanted;
      const id = insertObject(ctx, {
        id: planned,
        type: "base.board",
        title: space.title,
        data: {},
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt,
        author: "v2",
      });
      if (id !== wanted) {
        const holder = ctx.spaceObjectIds.has(wanted)
          ? `另一块白板的分区「${wanted}」`
          : `内容对象「${ctx.objectTitle.get(wanted) ?? wanted}」`;
        ctx.report.warnings.push({
          what: `分区「${space.title}」`,
          reason: `它的 id「${wanted}」和${holder}重名，分区改用「${id}」；占着原 id 的对象保留原 id，指向它的展示不会被改绑到别的对象上。`,
        });
      }
      ctx.spaceObjectIds.add(id);
      ctx.spaceMap.set(key, id);
    }
  });
}

/** v2 的内容对象。id、创建时间、作者都保留。 */
function importObjects(ctx: Ctx, workspace: V2Workspace): void {
  for (const object of workspace.objects) {
    if (!object.id) {
      ctx.report.skipped.push({
        what: `对象「${object.title}」`,
        reason: "对象没有 id，没有导入。",
      });
      continue;
    }
    if (ctx.objectIds.has(object.id)) {
      ctx.report.skipped.push({
        what: `对象「${object.title}」`,
        reason: `id「${object.id}」重复，只保留第一份。`,
      });
      continue;
    }
    const data = object.data ?? {};
    const isCode = object.kind === "code";
    const type = isCode
      ? codeEntryType(object.id)
      : mapV2Type(object.type, data);
    insertObject(ctx, {
      id: object.id,
      type,
      title: object.title,
      data: isCode
        ? codeEntryData(type, object.id)
        : mapV2Data(object.type, data, object.body),
      source: mapV2Source(object.source, isCode),
      version: object.version,
      createdAt: object.createdAt,
      updatedAt: object.updatedAt,
      author: object.author,
    });
    if (type === "novel.character") rememberTitle(ctx, object.title, object.id);
  }
}

/** v2 的附件：字节写进 blobs/，每个附件一个 base.media 对象。 */
function importAssets(ctx: Ctx, workspace: V2Workspace): void {
  for (const board of workspace.boards) {
    for (const asset of board.assets) {
      if (!asset.id) {
        ctx.report.skipped.push({
          what: "一个附件",
          reason: "附件没有 id，没有导入。",
        });
        continue;
      }
      const read = readAssetBytes(ctx.jsonFile, asset);
      if (!read.ok) {
        ctx.report.skipped.push({
          what: asset.name ? `附件「${asset.name}」` : "一个附件",
          reason: read.reason,
        });
        continue;
      }
      const mime = asset.mime || "application/octet-stream";
      const written = writeBlob(ctx, read.bytes, mime);
      if (!written.ok) {
        ctx.report.skipped.push({
          what: asset.name ? `附件「${asset.name}」` : "一个附件",
          reason: `${written.reason}这个附件没有导入。`,
        });
        continue;
      }
      ctx.assetsById.set(asset.id, { sha: written.sha, mime });
      if (ctx.objectIds.has(asset.id)) {
        ctx.report.skipped.push({
          what: `附件「${asset.name}」`,
          reason: `id「${asset.id}」重复，只保留第一份。`,
        });
        continue;
      }
      insertObject(ctx, {
        id: asset.id,
        type: "base.media",
        title: asset.name,
        data: {
          blob: written.sha,
          mime,
          caption: asset.name,
          alt: asset.name,
        },
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt,
        author: "v2",
      });
    }
  }
}

/** v2 的意图 / 提案 / 验证：各自变成一个对象，提案与验证指向意图。 */
function importCodeFlow(ctx: Ctx, workspace: V2Workspace): void {
  for (const board of workspace.boards) {
    for (const intent of board.intents) {
      const id = stringOf(intent.id);
      if (!id) {
        ctx.report.skipped.push({
          what: "一个改动意图",
          reason: "意图没有 id，没有导入。",
        });
        continue;
      }
      if (ctx.objectIds.has(id)) {
        ctx.report.skipped.push({
          what: "一个改动意图",
          reason: `id「${id}」和已经导入的对象重名，没有导入。`,
        });
        continue;
      }
      const data = { ...intent };
      delete data.id;
      insertObject(ctx, {
        id,
        type: "code.intent",
        title: truncate(stringOf(intent.request) || "改动意图"),
        data,
        createdAt: numberOf(intent.createdAt, workspace.createdAt),
        updatedAt: numberOf(intent.updatedAt, workspace.updatedAt),
        author: stringOf(intent.agentId) || "v2",
      });
    }
    for (const proposal of board.proposals) {
      const id = stringOf(proposal.id);
      if (!id) {
        ctx.report.skipped.push({
          what: "一个目标版本",
          reason: "提案没有 id，没有导入。",
        });
        continue;
      }
      if (ctx.objectIds.has(id)) {
        ctx.report.skipped.push({
          what: "一个目标版本",
          reason: `id「${id}」和已经导入的对象重名，没有导入。`,
        });
        continue;
      }
      const data = { ...proposal };
      delete data.id;
      const files = Array.isArray(proposal.files) ? proposal.files : [];
      data.files = files.map((file) => mapProposalFile(ctx, file));
      insertObject(ctx, {
        id,
        type: "code.proposal",
        title: truncate(stringOf(proposal.title) || "目标版本"),
        data,
        createdAt: numberOf(proposal.createdAt, workspace.createdAt),
        updatedAt: numberOf(proposal.updatedAt, workspace.updatedAt),
        author: stringOf(proposal.agentId) || "v2",
      });
      const intentId = stringOf(proposal.intentId);
      if (intentId && ctx.objectIds.has(intentId))
        insertRelation(ctx, {
          id: newId(),
          kind: "code.contains",
          sourceId: id,
          targetId: intentId,
          status: "confirmed",
          createdAt: numberOf(proposal.createdAt, workspace.createdAt),
          author: stringOf(proposal.agentId) || "v2",
        });
    }
    for (const validation of board.validations) {
      const id = stringOf(validation.id);
      if (!id) {
        ctx.report.skipped.push({
          what: "一条验证结果",
          reason: "验证没有 id，没有导入。",
        });
        continue;
      }
      if (ctx.objectIds.has(id)) {
        ctx.report.skipped.push({
          what: "一条验证结果",
          reason: `id「${id}」和已经导入的对象重名，没有导入。`,
        });
        continue;
      }
      const data = { ...validation };
      delete data.id;
      insertObject(ctx, {
        id,
        type: "code.validation",
        title: truncate(stringOf(validation.command) || "验证结果"),
        data,
        createdAt: numberOf(validation.reportedAt, workspace.createdAt),
        updatedAt: numberOf(validation.reportedAt, workspace.updatedAt),
        author: stringOf(validation.agentId) || "v2",
      });
      const proposalId = stringOf(validation.proposalId);
      if (proposalId && ctx.objectIds.has(proposalId))
        insertRelation(ctx, {
          id: newId(),
          kind: "code.contains",
          sourceId: id,
          targetId: proposalId,
          status: "confirmed",
          createdAt: numberOf(validation.reportedAt, workspace.createdAt),
          author: stringOf(validation.agentId) || "v2",
        });
    }
  }
}

/** v2 的导览：一个 base.tour 对象，每一站是一条 base.tour_stop 关系。 */
function importGuides(ctx: Ctx, workspace: V2Workspace): void {
  for (const board of workspace.boards) {
    for (const guide of board.guides) {
      const id = guide.id || newId();
      if (ctx.objectIds.has(id)) {
        ctx.report.skipped.push({
          what: `导览「${guide.title}」`,
          reason: `id「${id}」和已经导入的对象重名，没有导入。`,
        });
        continue;
      }
      const legacySteps: unknown[] = [];
      const stops: {
        objectId: string;
        order: number;
        title: string;
        explanation: string;
        uncertainty: string;
        evidence: V2Evidence[];
      }[] = [];
      guide.steps.forEach((step, index) => {
        if (!step.objectIds.length) {
          legacySteps.push({ ...step });
          return;
        }
        for (const objectId of step.objectIds)
          stops.push({
            objectId,
            order: index,
            title: step.title,
            explanation: step.explanation,
            uncertainty: step.uncertainty,
            evidence: step.evidence,
          });
      });
      insertObject(ctx, {
        id,
        type: "base.tour",
        title: guide.title,
        data: {
          purpose: guide.purpose,
          inputs: guide.inputs,
          outputs: guide.outputs,
          agentId: guide.agentId,
          stale: guide.stale,
          status: guide.status,
          createdAt: guide.createdAt,
          legacySteps,
        },
        createdAt: guide.createdAt,
        updatedAt: guide.createdAt,
        author: guide.agentId || "v2",
      });
      for (const stop of stops) {
        if (!ctx.objectIds.has(stop.objectId)) {
          ctx.report.skipped.push({
            what: `导览「${guide.title}」的一站`,
            reason: `指向的对象「${stop.objectId}」不存在，没有建关系。`,
          });
          continue;
        }
        insertRelation(ctx, {
          id: newId(),
          kind: "base.tour_stop",
          sourceId: id,
          targetId: stop.objectId,
          status: "confirmed",
          basis: stop.uncertainty || null,
          attributes: {
            order: stop.order,
            title: stop.title,
            explanation: stop.explanation,
          },
          evidence: stop.evidence.map(mapEvidence),
          createdAt: guide.createdAt,
          author: guide.agentId || "v2",
        });
      }
    }
  }
}

/** v2 的展示实例。 */
function importPresentations(ctx: Ctx, workspace: V2Workspace): void {
  workspace.boards.forEach((board, index) => {
    for (const presentation of board.presentations) {
      const boardId = ctx.spaceMap.get(spaceKey(index, presentation.spaceId));
      if (!boardId) {
        ctx.report.skipped.push({
          what: `展示「${presentation.title || presentation.type}」`,
          reason: `所在的白板分区「${presentation.spaceId}」不存在，没有导入。`,
        });
        continue;
      }
      const objectId = resolvePresentationObject(
        ctx,
        index,
        board,
        presentation,
      );
      if (!objectId) continue;
      if (objectId === boardId) {
        ctx.report.skipped.push({
          what: `展示「${presentation.title || presentation.type}」`,
          reason: "它指向的白板就是它自己所在的分区，没有导入。",
        });
        continue;
      }
      const rect = normalizeRect(ctx, presentation, objectId);
      insertPresentation(ctx, {
        id: presentation.id,
        boardId,
        objectId,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        locked: presentation.rect.pinned,
        appearance: presentation.appearance ?? {},
        updatedAt: presentation.updatedAt,
        author: presentation.author,
      });
      ctx.presentationObject.set(presentation.id, objectId);
      ctx.presentationRect.set(presentation.id, { ...rect, boardId });
    }
  });
}

/** 展示指向哪个对象：绑定对象、白板入口、本地内容、代码投影。 */
function resolvePresentationObject(
  ctx: Ctx,
  index: number,
  board: V2Board,
  presentation: V2Presentation,
): string | undefined {
  if (presentation.type === "board" || presentation.type === "space-link") {
    const target = stringOf(presentation.data.spaceId);
    const objectId = target
      ? ctx.spaceMap.get(spaceKey(index, target))
      : undefined;
    if (!objectId) {
      ctx.report.skipped.push({
        what: `展示「${presentation.title || presentation.type}」`,
        reason: `指向的白板分区「${target || "（空）"}」不存在，没有导入。`,
      });
      return undefined;
    }
    return objectId;
  }
  const bound = presentation.binding?.objectId ?? presentation.objectId;
  if (bound) {
    if (ctx.objectIds.has(bound)) {
      if (ctx.spaceObjectIds.has(bound))
        ctx.report.warnings.push({
          what: `展示「${presentation.title || presentation.type}」`,
          reason: `它绑定的 id「${bound}」是白板分区（base.board）的 id，不是内容对象的 id；这条展示被绑到了分区对象上，可能不是它原来要指的对象。`,
        });
      return bound;
    }
    if (isCodeEntryId(bound))
      return createCodePlaceholder(ctx, bound, presentation.title);
    ctx.report.skipped.push({
      what: `展示「${presentation.title || presentation.type}」`,
      reason: `绑定的对象「${bound}」不存在，没有导入这条展示。`,
    });
    return undefined;
  }
  if (presentation.type === "object") {
    ctx.report.skipped.push({
      what: `展示「${presentation.title || presentation.type}」`,
      reason: "它没有绑定任何对象，也没有本地内容，没有导入。",
    });
    return undefined;
  }
  return createLocalObject(ctx, presentation);
}

/** v2 的本地内容展示：先用本地内容建一个对象，再让展示指向它。 */
function createLocalObject(
  ctx: Ctx,
  presentation: V2Presentation,
): string | undefined {
  let id = presentation.id;
  if (ctx.objectIds.has(id)) id = `local:${presentation.id}`;
  if (ctx.objectIds.has(id)) {
    ctx.report.skipped.push({
      what: `展示「${presentation.title || presentation.type}」`,
      reason: "本地内容没有地方放，没有导入。",
    });
    return undefined;
  }
  const data = presentation.data ?? {};
  return insertObject(ctx, {
    id,
    type: mapV2Type(presentation.type, data),
    title: presentation.title,
    data: mapV2Data(presentation.type, data),
    createdAt: presentation.updatedAt,
    updatedAt: presentation.updatedAt,
    author: presentation.author,
  });
}

/**
 * 代码投影：v2 的代码条目不在 workspace.json 里（索引每次重新生成），
 * 所以按条目 id 建一个占位对象，等代码包下次刷新时按同一个 id 覆盖。
 */
function createCodePlaceholder(
  ctx: Ctx,
  entryId: string,
  title: string,
): string | undefined {
  const existing = ctx.objectIds.has(entryId);
  if (existing) return entryId;
  const type = codeEntryType(entryId);
  const locator = codeEntryLocator(entryId);
  const id = insertObject(ctx, {
    id: entryId,
    type,
    title: title || locator.fragment || entryId,
    data: codeEntryData(type, entryId),
    source: {
      origin: "derived",
      external: locator,
    },
    createdAt: ctx.now,
    updatedAt: ctx.now,
    author: "v2",
  });
  ctx.report.warnings.push({
    what: `代码条目「${entryId}」`,
    reason:
      "旧版本没有保存代码条目的详情，先建了一个占位对象；下次刷新代码索引时会按同一个 id 补上。",
  });
  return id;
}

/** v2 的分组：一个 base.frame 对象加一个框展示，组内展示挂在这个框下面。 */
function importGroups(ctx: Ctx, workspace: V2Workspace): void {
  for (const board of workspace.boards) {
    for (const group of board.groups) {
      const members = groupMembers(ctx, group);
      if (!members.length) {
        ctx.report.skipped.push({
          what: `分组「${group.title}」`,
          reason: "组里的展示都没找到，没有导入这个分组。",
        });
        continue;
      }
      const byBoard = new Map<string, string[]>();
      for (const member of members) {
        const boardId = ctx.presentationRect.get(member)?.boardId;
        if (!boardId) continue;
        const list = byBoard.get(boardId) ?? [];
        list.push(member);
        byBoard.set(boardId, list);
      }
      if (!byBoard.size) continue;
      const boardId = [...byBoard.entries()].sort(
        (a, b) =>
          b[1].length - a[1].length || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
      )[0]![0];
      const memberIds = byBoard.get(boardId)!;
      const rects = memberIds
        .map((id) => ctx.presentationRect.get(id))
        .filter((r): r is Rect & { boardId: string } => Boolean(r));
      const frame = groupFrameBox(rects);
      const frameId = insertObject(ctx, {
        id: ctx.objectIds.has(group.id) ? newId() : group.id,
        type: "base.frame",
        title: group.title,
        data: {},
        createdAt: ctx.now,
        updatedAt: ctx.now,
        author: "v2",
      });
      const framePresentationId = insertPresentation(ctx, {
        id: ctx.presentationObject.has(group.id)
          ? newId()
          : `${group.id}:frame`,
        boardId,
        objectId: frameId,
        x: frame.x,
        y: frame.y,
        width: frame.width,
        height: frame.height,
        updatedAt: ctx.now,
        author: "v2",
      });
      for (const memberId of memberIds) {
        const rect = ctx.presentationRect.get(memberId);
        if (!rect) continue;
        const relative = toFrameRelative(frame, rect);
        ctx.db
          .prepare(
            "UPDATE presentations SET parent_id = ?, x = ?, y = ? WHERE id = ?",
          )
          .run(framePresentationId, relative.x, relative.y, memberId);
      }
      const others = [...byBoard.entries()].filter(([id]) => id !== boardId);
      for (const [, ids] of others)
        ctx.report.skipped.push({
          what: `分组「${group.title}」`,
          reason: `组里的展示分布在 ${byBoard.size} 块白板上，只有同一块上的 ${memberIds.length} 个挂进了框里。`,
        });
    }
  }
}

/**
 * 分组的成员展示。
 * 有对得上的展示 id 就只用它们；一个都对不上（或根本没写展示 id）就按对象 id 找。
 */
function groupMembers(ctx: Ctx, group: V2Group): string[] {
  const fromInstances = (group.instanceIds ?? []).filter((id) =>
    ctx.presentationObject.has(id),
  );
  if (group.instanceIds?.length && fromInstances.length) return fromInstances;
  const objectIds = new Set(group.objectIds);
  return [...ctx.presentationObject.entries()]
    .filter(([, objectId]) => objectIds.has(objectId))
    .map(([presentationId]) => presentationId);
}

/** v2 的备注：每条一个 base.note 对象，放在目标旁边，并建 base.about 关系。 */
function importNotes(ctx: Ctx, workspace: V2Workspace): void {
  for (const board of workspace.boards) {
    for (const [targetId, text] of Object.entries(board.notes)) {
      if (!ctx.objectIds.has(targetId)) {
        ctx.report.skipped.push({
          what: "一条备注",
          reason: `它属于的对象「${targetId}」不存在，没有导入。`,
        });
        continue;
      }
      const noteId = newId();
      insertObject(ctx, {
        id: noteId,
        type: "base.note",
        title: "",
        data: { body: text },
        createdAt: ctx.now,
        updatedAt: ctx.now,
        author: "v2",
      });
      insertRelation(ctx, {
        id: newId(),
        kind: "base.about",
        sourceId: noteId,
        targetId: targetId,
        status: "confirmed",
        createdAt: ctx.now,
        author: "v2",
      });
      const anchor = findAnchor(ctx, targetId);
      if (!anchor) {
        ctx.report.warnings.push({
          what: "一条备注",
          reason:
            "它属于的对象没有摆在白板上，备注只建了对象和关系，没有位置。",
        });
        continue;
      }
      insertPresentation(ctx, {
        id: newId(),
        boardId: anchor.boardId,
        objectId: noteId,
        x: anchor.x + anchor.width + 24,
        y: anchor.y,
        width: 280,
        height: 180,
        updatedAt: ctx.now,
        author: "v2",
      });
    }
  }
}

/** v2 的对象关系。id 保留。§10.1 没有给出的 kind 原样保留。 */
function importRelations(ctx: Ctx, workspace: V2Workspace): void {
  for (const relation of workspace.relations) {
    if (!ctx.objectIds.has(relation.source)) {
      ctx.report.skipped.push({
        what: `关系「${relation.kind}」`,
        reason: `起点对象「${relation.source}」不存在，没有导入。`,
      });
      continue;
    }
    if (!ctx.objectIds.has(relation.target)) {
      ctx.report.skipped.push({
        what: `关系「${relation.kind}」`,
        reason: `终点对象「${relation.target}」不存在，没有导入。`,
      });
      continue;
    }
    if (relation.source === relation.target) {
      ctx.report.skipped.push({
        what: `关系「${relation.kind}」`,
        reason: "两端是同一个对象，没有导入。",
      });
      continue;
    }
    const kind = relation.kind;
    if (relation.status === "inferred" && !relation.basis) {
      ctx.report.warnings.push({
        what: `关系「${relation.kind}」`,
        reason:
          "它是推测关系但没有依据，新版本要求推测关系必须写依据，原样导入没有改。",
      });
    }
    insertRelation(ctx, {
      id: relation.id || newId(),
      kind,
      sourceId: relation.source,
      targetId: relation.target,
      status: relation.status,
      basis: relation.basis ?? null,
      attributes: relation.attributes ?? {},
      evidence: (relation.evidence ?? []).map(mapLocator),
      createdAt: relation.createdAt,
      updatedAt: relation.createdAt,
      author: relation.author,
    });
  }
}

/** v2 的空间链接：两端是展示绑定的对象，转成关系。 */
function importSpaceLinks(ctx: Ctx, workspace: V2Workspace): void {
  for (const board of workspace.boards) {
    for (const link of board.spaceLinks) {
      const source = ctx.presentationObject.get(link.source);
      const target = ctx.presentationObject.get(link.target);
      if (!source || !target) {
        ctx.report.skipped.push({
          what: `空间链接「${link.kind}」`,
          reason: `两端有一端指向不存在的展示（${link.source} → ${link.target}），没有导入。`,
        });
        continue;
      }
      if (source === target) {
        ctx.report.skipped.push({
          what: `空间链接「${link.kind}」`,
          reason: "两端是同一个对象，没有导入。",
        });
        continue;
      }
      insertRelation(ctx, {
        id: ctx.relationIds.has(link.id) ? newId() : link.id || newId(),
        kind: mapV2RelationKind(link.kind),
        sourceId: source,
        targetId: target,
        status: "confirmed",
        basis: link.description || null,
        createdAt: workspace.updatedAt,
        updatedAt: workspace.updatedAt,
        author: link.author,
      });
    }
  }
}

/**
 * 文本名单只给建议，不建关系。
 *
 * 新版本里参与者是关系槽，旧版本存的是名字。名字可能重名，也可能是笔误，
 * 所以这里只报告，由人来确认。
 */
function importParticipants(ctx: Ctx): void {
  const rows = ctx.db
    .prepare("SELECT id, title, data FROM objects WHERE type = 'novel.event'")
    .all() as { id: string; title: string; data: string }[];
  for (const row of rows) {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(row.data) as Record<string, unknown>;
    } catch {
      continue;
    }
    const names = Array.isArray(data.participants) ? data.participants : [];
    if (!names.length) continue;
    data.legacyParticipants = [...names];
    ctx.db
      .prepare("UPDATE objects SET data = ? WHERE id = ?")
      .run(JSON.stringify(data), row.id);
    for (const name of names) {
      if (typeof name !== "string") continue;
      const matches = ctx.titles.get(name) ?? [];
      if (matches.length === 0) {
        ctx.report.warnings.push({
          what: `事件「${row.title}」的参与者「${name}」`,
          reason: "没有同名的人物，没有自动建关系；名单原样保留在数据里。",
        });
        continue;
      }
      if (matches.length > 1) {
        ctx.report.warnings.push({
          what: `事件「${row.title}」的参与者「${name}」`,
          reason: `有 ${matches.length} 个同名的人物，没有自动建关系；名单原样保留在数据里。`,
        });
        continue;
      }
      ctx.report.warnings.push({
        what: `事件「${row.title}」的参与者「${name}」`,
        reason:
          "可以建立 novel.participates 关系；按名字匹配只作建议，没有自动建。",
      });
    }
  }
}

/** v2 的主题写进 settings。 */
function importTheme(ctx: Ctx, workspace: V2Workspace): void {
  let written = false;
  for (const board of workspace.boards) {
    if (board.theme === undefined || board.theme === null) continue;
    if (written) {
      ctx.report.skipped.push({
        what: "主题",
        reason: "另一块白板已经有主题了，一个工作空间只保留一份。",
      });
      continue;
    }
    ctx.db
      .prepare("INSERT INTO settings (key, value, rev) VALUES (?, ?, ?)")
      .run("theme", JSON.stringify(board.theme), IMPORT_REV);
    written = true;
  }
  if (!written && workspace.boards.some((b) => b.theme !== undefined))
    ctx.report.skipped.push({
      what: "主题",
      reason: "主题是空的，没有导入。",
    });
}

/** v2 的组件包（v1 清单）转换成 v3 的数据包。 */
function importPacks(ctx: Ctx, workspace: V2Workspace): void {
  for (const board of workspace.boards) {
    for (const pack of board.componentPacks) {
      const manifest = convertV1Pack(pack);
      if (!manifest) {
        ctx.report.skipped.push({
          what: `组件包「${pack.name || pack.id}」`,
          reason: "清单不完整（缺 id 或 name），没有导入。",
        });
        continue;
      }
      if (ctx.packIds.has(manifest.id)) {
        ctx.report.skipped.push({
          what: `组件包「${pack.name}」`,
          reason: `另一块白板里已有 id 为「${manifest.id}」的组件包，只导入了一次。`,
        });
        continue;
      }
      const builtin = ctx.registry.getPack(manifest.id);
      if (builtin?.kind === "builtin") {
        ctx.report.skipped.push({
          what: `组件包「${pack.name}」`,
          reason: `id「${manifest.id}」和内置包重名，没有导入，避免顶掉内置包。`,
        });
        continue;
      }
      // 写库前先用内核同一套规则校验清单：不合格的包不写库，
      // 否则 syncPacks 会在打开工作空间时报错，工作空间就打不开了。
      try {
        ctx.staged.registerPack(manifest, "data");
      } catch (error) {
        if (error instanceof PackSpecError) {
          const problem = error.problems[0];
          const detail = (problem?.message ?? error.message).replace(/。$/, "");
          ctx.report.skipped.push({
            what: `组件包「${pack.name || pack.id}」`,
            reason: `清单不合格，未装入：${detail}。这个包没有写进数据库，其余数据照常导入。`,
          });
          continue;
        }
        throw error;
      }
      ctx.packIds.add(manifest.id);
      ctx.db
        .prepare(
          "INSERT INTO packs (id, kind, version, enabled, manifest, rev) VALUES (?, 'data', ?, 1, ?, ?)",
        )
        .run(
          manifest.id,
          manifest.version,
          JSON.stringify(manifest),
          IMPORT_REV,
        );
    }
  }
}

/** v2 的审计记录原样搬过来。 */
function importAudit(ctx: Ctx, workspace: V2Workspace): void {
  for (const entry of workspace.audit) {
    ctx.db
      .prepare(
        "INSERT INTO audit (at, actor, actor_kind, action, history_id, detail) VALUES (?, ?, ?, ?, NULL, ?)",
      )
      .run(
        entry.at,
        entry.actor,
        entry.actorKind,
        entry.action,
        JSON.stringify({
          id: entry.id,
          ...(entry.target ? { target: entry.target } : {}),
          ...(entry.via ? { via: entry.via } : {}),
        }),
      );
  }
}

/** 收尾：首页白板、修订号、导入来源、导入审计。 */
function finalize(ctx: Ctx, workspace: V2Workspace): void {
  const autoHome = getMeta(ctx.db, "home_board_id");
  const rootBoard = rootSpaceObjectId(ctx, workspace);
  if (autoHome && rootBoard) {
    ctx.db.prepare("DELETE FROM objects WHERE id = ?").run(autoHome);
    setMeta(ctx.db, "home_board_id", rootBoard);
  }
  if (workspace.createdAt > 0)
    setMeta(ctx.db, "created_at", String(workspace.createdAt));
  setMeta(ctx.db, "revision", String(IMPORT_REV));
  setMeta(ctx.db, "imported_from", `workspace.json@${workspace.revision}`);
  ctx.db
    .prepare(
      "INSERT INTO audit (at, actor, actor_kind, action, history_id, detail) VALUES (?, 'system', 'system', 'import', NULL, ?)",
    )
    .run(
      ctx.now,
      JSON.stringify({
        from: ctx.report.from,
        objects: ctx.report.objects,
        presentations: ctx.report.presentations,
        relations: ctx.report.relations,
        skipped: ctx.report.skipped,
        warnings: ctx.report.warnings,
        note: "升级前的撤销记录未保留。",
      }),
    );
}

/** 根分区（overview）对应的白板对象，它就是新的首页。 */
function rootSpaceObjectId(
  ctx: Ctx,
  workspace: V2Workspace,
): string | undefined {
  for (const [index, board] of workspace.boards.entries()) {
    const preferred = board.spaces.find((s) => s.id === "overview");
    if (preferred) return ctx.spaceMap.get(spaceKey(index, preferred.id));
    const root = board.spaces.find((s) => !s.parentId);
    if (root) return ctx.spaceMap.get(spaceKey(index, root.id));
    const first = board.spaces[0];
    if (first) return ctx.spaceMap.get(spaceKey(index, first.id));
  }
  return undefined;
}

function insertObject(ctx: Ctx, input: ObjectInput): string {
  let id = input.id;
  if (ctx.objectIds.has(id)) {
    // id 撞车时另起一个 id：丢内容比丢 id 更糟，但要让人看得见。
    id = newId();
    ctx.report.warnings.push({
      what: `对象「${input.title}」`,
      reason: `id「${input.id}」重复，换成了「${id}」。`,
    });
  }
  const typeVersion = ctx.registry.getType(input.type)?.version ?? 1;
  ctx.db
    .prepare(
      `INSERT INTO objects (
         id, type, type_version, title, data, source, version,
         created_at, created_by, updated_at, updated_by, rev
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.type,
      typeVersion,
      truncate(input.title),
      JSON.stringify(input.data ?? {}),
      input.source ? JSON.stringify(input.source) : null,
      input.version ?? 1,
      input.createdAt ?? ctx.now,
      input.author ?? "v2",
      input.updatedAt ?? ctx.now,
      input.author ?? "v2",
      IMPORT_REV,
    );
  ctx.objectIds.add(id);
  ctx.objectType.set(id, input.type);
  ctx.objectTitle.set(id, input.title);
  ctx.report.objects += 1;
  return id;
}

function insertPresentation(
  ctx: Ctx,
  input: {
    id: string;
    boardId: string;
    objectId: string;
    x: number;
    y: number;
    width: number;
    height: number;
    locked?: boolean;
    appearance?: Appearance;
    updatedAt?: number;
    author?: string;
  },
): string {
  let id = input.id;
  if (ctx.presentationObject.has(id)) {
    id = newId();
    ctx.report.warnings.push({
      what: "一条展示",
      reason: `id「${input.id}」重复，换成了「${id}」。`,
    });
  }
  ctx.db
    .prepare(
      `INSERT INTO presentations (
         id, board_id, object_id, parent_id, x, y, width, height, z, locked,
         appearance, version, updated_at, updated_by, rev
       ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 0, ?, ?, 1, ?, ?, ?)`,
    )
    .run(
      id,
      input.boardId,
      input.objectId,
      input.x,
      input.y,
      input.width,
      input.height,
      input.locked ? 1 : 0,
      JSON.stringify(input.appearance ?? {}),
      input.updatedAt ?? ctx.now,
      input.author ?? "v2",
      IMPORT_REV,
    );
  ctx.presentationObject.set(id, input.objectId);
  ctx.presentationRect.set(id, {
    x: input.x,
    y: input.y,
    width: input.width,
    height: input.height,
    boardId: input.boardId,
  });
  ctx.report.presentations += 1;
  return id;
}

function insertRelation(
  ctx: Ctx,
  input: {
    id: string;
    kind: string;
    sourceId: string;
    targetId: string;
    status: "confirmed" | "inferred";
    basis?: string | null;
    attributes?: Record<string, unknown>;
    evidence?: ExternalLocator[];
    createdAt?: number;
    updatedAt?: number;
    author?: string;
  },
): void {
  let id = input.id;
  if (ctx.relationIds.has(id)) {
    id = newId();
    ctx.report.warnings.push({
      what: `关系「${input.kind}」`,
      reason: `id「${input.id}」重复，换成了「${id}」。`,
    });
  }
  ctx.db
    .prepare(
      `INSERT INTO relations (
         id, kind, source_id, target_id, status, basis, attributes, evidence,
         version, created_at, created_by, updated_at, updated_by, rev
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.kind,
      input.sourceId,
      input.targetId,
      input.status,
      input.basis ?? null,
      JSON.stringify(input.attributes ?? {}),
      JSON.stringify(input.evidence ?? []),
      input.createdAt ?? ctx.now,
      input.author ?? "v2",
      input.updatedAt ?? ctx.now,
      input.author ?? "v2",
      IMPORT_REV,
    );
  ctx.relationIds.add(id);
  ctx.report.relations += 1;
}

/**
 * 写一个附件：字节进 blobs/，登记进 blobs 表。
 *
 * blobs/<sha> 是按内容命名的：文件已经存在就核对内容，对不上说明那里
 * 摆的不是这份字节，不能登记。
 */
function writeBlob(
  ctx: Ctx,
  bytes: Buffer,
  mime: string,
): { ok: true; sha: string } | { ok: false; reason: string } {
  const sha = createHash("sha256").update(bytes).digest("hex");
  const dir = join(dirname(ctx.dbFile), "blobs");
  mkdirSync(dir, { recursive: true });
  const target = join(dir, sha);
  if (existsSync(target)) {
    let existing: Buffer;
    try {
      existing = readFileSync(target);
    } catch {
      return {
        ok: false,
        reason: `blobs 目录里已有一个叫「${sha}」的条目，但它不是文件，没有登记。`,
      };
    }
    if (createHash("sha256").update(existing).digest("hex") !== sha)
      return {
        ok: false,
        reason: `blobs 目录里已有一个叫「${sha}」的文件，它的内容和这个哈希对不上，没有登记。`,
      };
  } else {
    try {
      writeFileSync(target, bytes);
    } catch (error) {
      throw new V2MigrationError(
        `附件写不进 ${dir} 目录：${error instanceof Error ? error.message : String(error)}。请检查这个工作空间目录的权限和磁盘空间，处理好之后重新导入。`,
        { cause: error },
      );
    }
    ctx.writtenBlobs.push(target);
  }
  ctx.db
    .prepare(
      "INSERT OR REPLACE INTO blobs (sha256, mime, bytes, created_at) VALUES (?, ?, ?, ?)",
    )
    .run(sha, mime || "application/octet-stream", bytes.length, ctx.now);
  return { ok: true, sha };
}

/**
 * 把引用了附件的 base.media 补上 blob 与 mime。
 * v2 的 resource 只存 assetId，v3 的媒体对象靠 blob 显示。
 * assetId 原样留下。
 */
function linkResourceBlobs(ctx: Ctx): void {
  const rows = ctx.db
    .prepare(
      "SELECT id, type, title, data FROM objects WHERE deleted_rev IS NULL",
    )
    .all() as { id: string; type: string; title: string; data: string }[];
  for (const row of rows) {
    if (row.type !== "base.media") continue;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(row.data) as Record<string, unknown>;
    } catch {
      continue;
    }
    const assetId = data.assetId;
    if (typeof assetId !== "string" || !assetId) continue;
    const asset = ctx.assetsById.get(assetId);
    if (!asset) {
      ctx.report.warnings.push({
        what: `媒体「${row.title || row.id}」`,
        reason: `它引用的附件「${assetId}」没有导入成功，数据里还留着 assetId，界面暂时显示不出图片、音频或视频。`,
      });
      continue;
    }
    let changed = false;
    if (typeof data.blob !== "string" || !data.blob) {
      data.blob = asset.sha;
      changed = true;
    }
    if (typeof data.mime !== "string" || !data.mime) {
      data.mime = asset.mime;
      changed = true;
    }
    if (!changed) continue;
    ctx.db
      .prepare("UPDATE objects SET data = ? WHERE id = ?")
      .run(JSON.stringify(data), row.id);
  }
}

/** 附件的字节：先看文件里的内联数据，没有就只读 attachments 目录里的同名文件。 */
function readAssetBytes(
  jsonFile: string,
  asset: V2Asset,
): { ok: true; bytes: Buffer } | { ok: false; reason: string } {
  if (asset.dataUrl) {
    const bytes = decodeDataUrl(asset.dataUrl);
    if (!bytes)
      return {
        ok: false,
        reason: "内联数据不是合法的 data URL，没有导入。",
      };
    return { ok: true, bytes };
  }
  if (!asset.name)
    return {
      ok: false,
      reason: "文件里没有内联数据，也没有文件名，没有导入。",
    };
  if (!isSafeAttachmentName(asset.name))
    return {
      ok: false,
      reason:
        "附件名越界：含有路径分隔或 ..，不能读取工作空间 attachments 目录以外的文件，没有导入。",
    };
  const located = locateAttachment(jsonFile, asset.name);
  if (!located.ok) return located;
  try {
    return { ok: true, bytes: readFileSync(located.file) };
  } catch {
    return {
      ok: false,
      reason: "attachments 目录里的同名文件读不出来，没有导入。",
    };
  }
}

function decodeDataUrl(dataUrl: string): Buffer | undefined {
  const match = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(dataUrl);
  if (!match) return undefined;
  const payload = match[3] ?? "";
  if (match[2]) return Buffer.from(payload, "base64");
  try {
    return Buffer.from(decodeURIComponent(payload), "utf8");
  } catch {
    return Buffer.from(payload, "utf8");
  }
}

/** 附件名只能是 attachments 目录里的一个文件名，不能带路径。 */
function isSafeAttachmentName(name: string): boolean {
  if (!name || name === "." || name === "..") return false;
  if (name.includes("/") || name.includes("\\") || name.includes("\0"))
    return false;
  return true;
}

/**
 * 解析附件路径。符号链接也要落在 attachments 目录里面，否则不读。
 */
function locateAttachment(
  jsonFile: string,
  name: string,
): { ok: true; file: string } | { ok: false; reason: string } {
  const root = join(dirname(jsonFile), "attachments");
  const file = resolve(root, name);
  const inside = relative(resolve(root), file);
  if (!inside || inside.startsWith("..") || isAbsolute(inside))
    return {
      ok: false,
      reason:
        "附件路径越界：解析后超出了工作空间的 attachments 目录，没有读取。",
    };
  if (!existsSync(file))
    return {
      ok: false,
      reason:
        "文件里没有内联数据，attachments 目录里也找不到同名文件，没有导入。",
    };
  let rootReal: string;
  let fileReal: string;
  try {
    rootReal = realpathSync(root);
    fileReal = realpathSync(file);
  } catch {
    return {
      ok: false,
      reason: "attachments 目录里的同名文件读不出来，没有导入。",
    };
  }
  const resolved = relative(rootReal, fileReal);
  if (!resolved || resolved.startsWith("..") || isAbsolute(resolved))
    return {
      ok: false,
      reason:
        "附件路径越界：解析后超出了工作空间的 attachments 目录，没有读取。",
    };
  return { ok: true, file: fileReal };
}

/** 提案里超过 1 MB 的文件内容写进附件区，原地留一个 sha256 引用。 */
function mapProposalFile(ctx: Ctx, file: unknown): unknown {
  if (!isRecord(file)) return file;
  const copy: Record<string, unknown> = { ...file };
  for (const key of ["before", "after"]) {
    const content = copy[key];
    if (typeof content !== "string") continue;
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes <= BLOB_THRESHOLD) continue;
    const written = writeBlob(ctx, Buffer.from(content, "utf8"), "text/plain");
    if (!written.ok) {
      // 内容留在原地，不丢；只是没有搬进附件区。
      ctx.report.warnings.push({
        what: `提案里的文件内容（${key}）`,
        reason: `${written.reason}这段内容仍留在提案数据里，没有搬进附件区。`,
      });
      continue;
    }
    copy[key] = { blob: written.sha, bytes };
  }
  return copy;
}

/** v2 的资源定位换成 v3 的。 */
function mapLocator(locator: {
  kind: string;
  uri: string;
  fragment?: string;
  version?: string;
}): ExternalLocator {
  const mapped: ExternalLocator = {
    kind:
      locator.kind === "git" ||
      locator.kind === "pdf" ||
      locator.kind === "url" ||
      locator.kind === "dataset" ||
      locator.kind === "symbol"
        ? locator.kind
        : "file",
    uri: locator.uri,
  };
  if (locator.fragment !== undefined) mapped.fragment = locator.fragment;
  if (locator.version !== undefined) mapped.version = locator.version;
  return mapped;
}

/** v2 的代码证据换成 v3 的资源定位。 */
function mapEvidence(evidence: V2Evidence): ExternalLocator {
  return {
    kind: "file",
    uri: evidence.path,
    fragment: `${evidence.startLine}-${evidence.endLine}`,
    fingerprint: evidence.hash,
  };
}

/** v2 的对象来源换成 v3 的。旧字段原样留下，不静默丢。 */
function mapV2Source(
  source: V2ObjectSource | undefined,
  derived: boolean,
): ObjectSource | null {
  if (!source) return derived ? { origin: "derived" } : null;
  const mapped: ObjectSource & Record<string, unknown> = {
    origin: derived
      ? "derived"
      : source.origin === "code-index"
        ? "derived"
        : source.origin,
  };
  if (source.basis !== undefined) mapped.basis = source.basis;
  if (source.author !== undefined) mapped.author = source.author;
  if (source.importedAt !== undefined) mapped.importedAt = source.importedAt;
  if (source.external) {
    const external = mapLocator(source.external);
    if (source.fingerprint !== undefined)
      external.fingerprint = source.fingerprint;
    mapped.external = external;
  }
  return mapped;
}

/** v2 的对象数据。字段改名按 §10.1，其余原样保留。 */
function mapV2Data(
  type: string,
  data: Record<string, unknown>,
  body?: string,
): Record<string, unknown> {
  const mapped: Record<string, unknown> = { ...data };
  if (type === "text") {
    if (typeof mapped.text === "string") {
      mapped.body = mapped.text;
      delete mapped.text;
    } else if (body !== undefined) mapped.body = body;
  } else if (body !== undefined && mapped.body === undefined) {
    mapped.body = body;
  }
  return mapped;
}

/**
 * v2 的代码条目 id 形如 `<仓库 id>:<路径>` 或 `<仓库 id>:<路径>#<符号名>`。
 * 内容对象的 id 是 UUID，不含冒号，所以冒号能可靠地把两者分开。
 */
function isCodeEntryId(id: string): boolean {
  const colon = id.indexOf(":");
  return colon > 0 && colon < id.length - 1;
}

/** 代码条目是文件还是符号：有「#」的是符号。 */
function codeEntryType(id: string): string {
  return id.includes("#") ? "code.symbol" : "code.file";
}

/** 代码条目的外部定位：uri 是稳定 id，fragment 是路径或符号名。 */
function codeEntryLocator(id: string): ExternalLocator {
  const hash = id.indexOf("#");
  const colon = id.indexOf(":");
  if (hash >= 0)
    return {
      kind: "symbol",
      uri: `v2-code-entry:${id}`,
      fragment: id.slice(hash + 1),
    };
  return {
    kind: "file",
    uri: `v2-code-entry:${id}`,
    fragment: colon >= 0 ? id.slice(colon + 1) : id,
  };
}

/** 代码占位对象的初始数据。 */
function codeEntryData(type: string, id: string): Record<string, unknown> {
  const locator = codeEntryLocator(id);
  if (type === "code.symbol") return { name: locator.fragment ?? "" };
  return { path: locator.fragment ?? "" };
}

/** 找到目标对象的一个展示，备注要放在它旁边。 */
function findAnchor(
  ctx: Ctx,
  objectId: string,
): (Rect & { boardId: string }) | undefined {
  for (const [presentationId, bound] of ctx.presentationObject) {
    if (bound !== objectId) continue;
    const rect = ctx.presentationRect.get(presentationId);
    if (rect) return rect;
  }
  return undefined;
}

/** 记住标题，用来给文本名单匹配出建议。 */
function rememberTitle(ctx: Ctx, title: string, id: string): void {
  if (!title) return;
  const list = ctx.titles.get(title) ?? [];
  list.push(id);
  ctx.titles.set(title, list);
}

/** v1 组件包清单转成 v3 的数据包清单（docs/kernel-v3/03-types-and-extensions.md §6.1）。 */
function convertV1Pack(pack: V2ComponentPack):
  | {
      format: "sand-table-pack";
      formatVersion: 2;
      id: string;
      title: string;
      version: number;
      description?: string;
      presets: {
        key: string;
        type: string;
        title: string;
        data?: Record<string, unknown>;
        width?: number;
        height?: number;
      }[];
    }
  | undefined {
  const id = packSlug(pack.id);
  const title = pack.name?.trim() ? pack.name : pack.id;
  if (!id || !title) return undefined;
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(id)) return undefined;
  const presets: {
    key: string;
    type: string;
    title: string;
    data?: Record<string, unknown>;
    width?: number;
    height?: number;
  }[] = [];
  for (const component of pack.components ?? []) {
    if (!component.key || !component.title || !component.type) continue;
    const data = { ...(component.data ?? {}) };
    if (
      component.type === "text" &&
      !Object.prototype.hasOwnProperty.call(data, "body") &&
      Object.prototype.hasOwnProperty.call(data, "text")
    ) {
      data.body = data.text;
      delete data.text;
    }
    const preset: (typeof presets)[number] = {
      key: component.key,
      type: mapV2Type(component.type, data),
      title: component.title,
      data,
    };
    if (typeof component.width === "number" && component.width > 0)
      preset.width = component.width;
    if (typeof component.height === "number" && component.height > 0)
      preset.height = component.height;
    presets.push(preset);
  }
  return {
    format: "sand-table-pack",
    formatVersion: 2,
    id,
    title,
    version: Math.max(1, Math.trunc(pack.version) || 1),
    ...(pack.description ? { description: pack.description } : {}),
    presets,
  };
}

/** 包 id 转成小写，非 [a-z0-9-] 换成「-」，截到 41 个字符。 */
function packSlug(id: string): string {
  let out = "";
  for (const char of id.toLowerCase())
    out += /[a-z0-9-]/.test(char) ? char : "-";
  return Array.from(out).slice(0, 41).join("");
}

/** 展示的矩形：宽高必须是正数，不正就用类型的默认尺寸。 */
function normalizeRect(
  ctx: Ctx,
  presentation: V2Presentation,
  objectId: string,
): Rect {
  const rect = presentation.rect;
  const spec = ctx.registry.getType(ctx.objectType.get(objectId) ?? "");
  const fallback = spec?.display.defaultSize ?? { width: 280, height: 180 };
  const width = rect.width > 0 ? rect.width : fallback.width;
  const height = rect.height > 0 ? rect.height : fallback.height;
  if (width !== rect.width || height !== rect.height)
    ctx.report.warnings.push({
      what: `展示「${presentation.title || presentation.type}」`,
      reason: `尺寸不是正数（${rect.width}×${rect.height}），已按默认尺寸 ${width}×${height} 处理。`,
    });
  return { x: rect.x, y: rect.y, width, height };
}

function spaceKey(boardIndex: number, spaceId: string): string {
  return `${boardIndex}:${spaceId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberOf(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function truncate(text: string): string {
  return text.length > TITLE_LIMIT ? text.slice(0, TITLE_LIMIT) : text;
}
