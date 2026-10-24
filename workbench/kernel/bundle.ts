// 工作空间整包导出与导入。
//
// 在线编辑必须走命令事务。这里是例外：只在尚未发布的临时库里直接恢复内容行，
// 校验通过并关闭数据库之后，才把目录改名到工作空间根下。失败就删掉临时目录。
// 见 docs/kernel-v3/05-delivery-contracts.md §3。

import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import {
  getMeta,
  openWorkspaceDb,
  setMeta,
  transaction,
  type Db,
} from "./db.ts";
import { CommandError } from "./errors.ts";
import { markFrameCoords } from "./frame-coords.ts";
import { importV2 } from "./legacy/import-v2.ts";
import { V2MigrationError } from "./legacy/v2-migrate.ts";
import { createRegistry, PackSpecError, type Registry } from "./registry.ts";
import { toObjectRow, toPresentationRow, toRelationRow } from "./rows.ts";
import type { Appearance, ExternalLocator, ObjectSource } from "./types.ts";

export const WORKSPACE_BUNDLE_FORMAT = "sand-table-workspace";
export const WORKSPACE_BUNDLE_VERSION = 3;
/** 原始 JSON 上限：300 MiB。 */
export const MAX_BUNDLE_JSON_BYTES = 300 * 1024 * 1024;
/** 解码后的附件合计上限：200 MiB。 */
export const MAX_BUNDLE_BLOB_BYTES = 200 * 1024 * 1024;
export const IMPORT_REPORT_FILENAME = "import-report.json";

const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const LOCATOR_KINDS = new Set([
  "file",
  "git",
  "pdf",
  "url",
  "dataset",
  "symbol",
]);
const ORIGINS = new Set([
  "human",
  "imported",
  "ai-generated",
  "ai-inferred",
  "derived",
]);
const DETAILS = new Set(["full", "label", "icon"]);
const TITLE_LIMIT = 300;
const IMPORT_REV = 1;
const CODE_PACK = "code";

export type BundleCounts = {
  objects: number;
  presentations: number;
  relations: number;
  blobs: number;
};

export type BundleDegraded = {
  kind: "unknown-type" | "invalid-pack";
  id: string;
  reason: string;
};

/** 给人看的导入结果。隔离清单里的原清单在工作空间目录的 import-report.json。 */
export type BundleImportReport = {
  workspaceId: string;
  title: string;
  counts: BundleCounts;
  degraded: BundleDegraded[];
  external: ExternalLocator[];
};

export type BundleFile = {
  filename: string;
  json: string;
};

type BundleOptions = {
  now?: () => number;
  maxBlobBytes?: number;
  maxJsonBytes?: number;
};

type BundleObject = {
  id: string;
  type: string;
  typeVersion: number;
  title: string;
  data: Record<string, unknown>;
  source: ObjectSource | null;
  version: number;
  createdAt: number;
  createdBy: string;
  updatedAt: number;
  updatedBy: string;
};

type BundlePresentation = {
  id: string;
  boardId: string;
  objectId: string;
  parentId: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  locked: boolean;
  appearance: Appearance;
  version: number;
  updatedAt: number;
  updatedBy: string;
};

type BundleRelation = {
  id: string;
  kind: string;
  sourceId: string;
  targetId: string;
  status: "confirmed" | "inferred";
  basis: string | null;
  attributes: Record<string, unknown>;
  evidence: ExternalLocator[];
  version: number;
  createdAt: number;
  createdBy: string;
  updatedAt: number;
  updatedBy: string;
};

type BundleSetting = { key: string; value: unknown };

type BundleBlob = {
  sha256: string;
  mime: string;
  bytes: Buffer;
};

type BuiltinRow = { id: string; version: number; enabled: boolean };

type DataRow = {
  id: string;
  version: number;
  enabled: boolean;
  manifest: Record<string, unknown>;
};

type InvalidPack = {
  id: string;
  kind: "data" | "builtin";
  version: number | null;
  enabled: boolean | null;
  manifest: unknown;
  objects: BundleObject[];
  reason: string;
};

type CheckedBundle = {
  preferredId: string;
  title: string;
  homeBoardId: string;
  objects: BundleObject[];
  presentations: BundlePresentation[];
  relations: BundleRelation[];
  settings: BundleSetting[];
  builtins: BuiltinRow[];
  dataPacks: DataRow[];
  invalidPacks: InvalidPack[];
  blobs: BundleBlob[];
  degraded: BundleDegraded[];
  external: ExternalLocator[];
  carriedInvalid: InvalidPack[];
};

type BlobMeta = { mime: string; bytes: number };

/**
 * 导出当前工作空间。
 *
 * 内容行在同一个只读事务里读取。附件按 sha256 核对，对不上就整份失败，
 * 避免把别的进程刚写到一半的字节带出去。
 */
export function exportWorkspaceBundle(
  db: Db,
  options?: BundleOptions,
): BundleFile {
  const maxBlob = options?.maxBlobBytes ?? MAX_BUNDLE_BLOB_BYTES;
  const now = options?.now ?? Date.now;
  const dir = workspaceDir(db);
  let revision = "";
  let payload: Record<string, unknown> | undefined;
  db.exec("BEGIN");
  try {
    revision = getMeta(db, "revision") ?? "";
    payload = readBundle(db, dir, maxBlob, now());
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* 仍抛出原来的错误 */
    }
    throw asCommandError(error, "导出");
  }
  if ((getMeta(db, "revision") ?? "") !== revision)
    throw new CommandError(
      "INVALID_DATA",
      "导出过程中工作空间有新的写入，这份导出没有保存。请再导出一次。",
      null,
    );
  const isolation = readIsolation(dir);
  if (isolation !== undefined) payload.isolation = isolation;
  const json = JSON.stringify(payload);
  if (Buffer.byteLength(json) > MAX_BUNDLE_JSON_BYTES)
    throw new CommandError(
      "LIMIT",
      "导出的文件超过 300 MiB，没有导出。请删掉一些附件或对象后再试。",
      null,
    );
  const id = String(
    (payload.workspace as { id?: string } | undefined)?.id ?? "workspace",
  );
  return { filename: `sand-table-${id}.json`, json };
}

/**
 * 从 JSON 文本导入一个新的工作空间。
 *
 * 不覆盖已有目录。v3 文件在临时目录里建库，关闭后再改名；
 * 带 schemaVersion 和 boards 的 v2 文件交给 importV2。
 */
export function importWorkspaceBundle(
  root: string,
  registry: Registry,
  json: string,
  options?: BundleOptions,
): BundleImportReport {
  const maxJson = options?.maxJsonBytes ?? MAX_BUNDLE_JSON_BYTES;
  if (typeof json !== "string" || json.length === 0)
    throw new CommandError(
      "INVALID_DATA",
      "没有可导入的内容。请选择导出的工作空间文件。",
      null,
    );
  if (Buffer.byteLength(json) > maxJson)
    throw new CommandError(
      "LIMIT",
      "工作空间文件超过 300 MiB，没有导入。请删掉一些附件后再导出一份更小的文件。",
      null,
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new CommandError(
      "INVALID_DATA",
      "这个文件不是 JSON，没法导入。请选择导出的工作空间文件。",
      null,
    );
  }
  if (isV3Bundle(parsed)) return importV3(root, registry, parsed, options);
  if (isV2Bundle(parsed))
    return importV2Bundle(root, registry, json, options?.now ?? Date.now);
  throw new CommandError(
    "INVALID_DATA",
    "认不出这份工作空间文件。请使用本机导出的文件，或带 schemaVersion 和 boards 的 v2 工作空间文件。",
    null,
  );
}

function readBundle(
  db: Db,
  dir: string,
  maxBlob: number,
  exportedAt: number,
): Record<string, unknown> {
  const id = getMeta(db, "workspace_id");
  const title = getMeta(db, "title");
  const homeBoardId = getMeta(db, "home_board_id");
  if (!id || title === undefined || !homeBoardId)
    throw new CommandError(
      "INTERNAL",
      "这个工作空间缺少编号、标题或首页，没有导出。请重新打开工作空间后再试。",
      null,
    );
  const objects = liveObjects(db);
  if (!objects.some((object) => object.id === homeBoardId))
    throw new CommandError(
      "NOT_FOUND",
      "首页白板已经不在了，没有导出。请保留 workspace.db，不要把它当成空工作空间。",
      null,
    );
  const presentations = livePresentations(db);
  const relations = liveRelations(db);
  const settings = liveSettings(db);
  const packs = livePacks(db);
  const blobMeta = blobTable(db);
  const referenced = referencedBlobs(
    objects,
    presentations,
    relations,
    settings,
    blobMeta,
  );
  const blobs = readReferencedBlobs(dir, referenced, blobMeta, maxBlob);
  const external = collectExternal(objects, relations);
  return {
    format: WORKSPACE_BUNDLE_FORMAT,
    formatVersion: WORKSPACE_BUNDLE_VERSION,
    exportedAt,
    workspace: { id, title, homeBoardId },
    objects,
    presentations,
    relations,
    settings,
    packs,
    blobs,
    external,
  };
}

function liveObjects(db: Db): BundleObject[] {
  const rows = db
    .prepare("SELECT * FROM objects WHERE deleted_rev IS NULL ORDER BY id ASC")
    .all() as Record<string, unknown>[];
  return rows.map((row) => {
    const object = toObjectRow(row);
    return {
      id: object.id,
      type: object.type,
      typeVersion: object.typeVersion,
      title: object.title,
      data: object.data,
      source: object.source,
      version: object.version,
      createdAt: object.createdAt,
      createdBy: object.createdBy,
      updatedAt: object.updatedAt,
      updatedBy: object.updatedBy,
    };
  });
}

function livePresentations(db: Db): BundlePresentation[] {
  const rows = db
    .prepare(
      "SELECT * FROM presentations WHERE deleted_rev IS NULL ORDER BY id ASC",
    )
    .all() as Record<string, unknown>[];
  return rows.map((row) => {
    const presentation = toPresentationRow(row);
    return {
      id: presentation.id,
      boardId: presentation.boardId,
      objectId: presentation.objectId,
      parentId: presentation.parentId,
      x: presentation.x,
      y: presentation.y,
      width: presentation.width,
      height: presentation.height,
      z: presentation.z,
      locked: presentation.locked,
      appearance: presentation.appearance,
      version: presentation.version,
      updatedAt: presentation.updatedAt,
      updatedBy: presentation.updatedBy,
    };
  });
}

function liveRelations(db: Db): BundleRelation[] {
  const rows = db
    .prepare(
      "SELECT * FROM relations WHERE deleted_rev IS NULL ORDER BY id ASC",
    )
    .all() as Record<string, unknown>[];
  return rows.map((row) => {
    const relation = toRelationRow(row);
    return {
      id: relation.id,
      kind: relation.kind,
      sourceId: relation.sourceId,
      targetId: relation.targetId,
      status: relation.status,
      basis: relation.basis,
      attributes: relation.attributes,
      evidence: relation.evidence,
      version: relation.version,
      createdAt: relation.createdAt,
      createdBy: relation.createdBy,
      updatedAt: relation.updatedAt,
      updatedBy: relation.updatedBy,
    };
  });
}

function liveSettings(db: Db): BundleSetting[] {
  const rows = db
    .prepare(
      "SELECT key, value FROM settings WHERE deleted_rev IS NULL ORDER BY key ASC",
    )
    .all() as { key: string; value: string }[];
  return rows.map((row) => ({
    key: String(row.key),
    value: JSON.parse(row.value) as unknown,
  }));
}

function livePacks(db: Db): Record<string, unknown>[] {
  const rows = db
    .prepare(
      `SELECT id, kind, version, enabled, manifest
       FROM packs WHERE deleted_rev IS NULL ORDER BY id ASC`,
    )
    .all() as {
    id: string;
    kind: string;
    version: number;
    enabled: number;
    manifest: string | null;
  }[];
  return rows.map((row) => {
    if (row.kind === "builtin")
      return { id: String(row.id), enabled: Number(row.enabled) === 1 };
    let manifest: unknown = null;
    if (row.manifest) {
      try {
        manifest = JSON.parse(row.manifest) as unknown;
      } catch {
        throw new CommandError(
          "INVALID_DATA",
          `组件包「${row.id}」的清单无法读取，没有导出。请不要手改数据库里的清单。`,
          null,
        );
      }
    }
    return {
      id: String(row.id),
      kind: "data",
      version: Number(row.version),
      enabled: Number(row.enabled) === 1,
      manifest,
    };
  });
}

function blobTable(db: Db): Map<string, BlobMeta> {
  const rows = db
    .prepare("SELECT sha256, mime, bytes FROM blobs ORDER BY sha256 ASC")
    .all() as { sha256: string; mime: string; bytes: number }[];
  const map = new Map<string, BlobMeta>();
  for (const row of rows)
    map.set(String(row.sha256), {
      mime: String(row.mime),
      bytes: Number(row.bytes),
    });
  return map;
}

function referencedBlobs(
  objects: BundleObject[],
  presentations: BundlePresentation[],
  relations: BundleRelation[],
  settings: BundleSetting[],
  known: Map<string, BlobMeta>,
): Set<string> {
  const refs = new Set<string>();
  const visit = (value: unknown, key?: string) => {
    if (typeof value === "string") {
      if (!SHA256.test(value)) return;
      if (key === "blob" || key === "coverBlob" || known.has(value))
        refs.add(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!plain(value)) return;
    for (const [childKey, child] of Object.entries(value))
      visit(child, childKey);
  };
  for (const object of objects) {
    visit(object.data);
    visit(object.source);
  }
  for (const presentation of presentations) visit(presentation.appearance);
  for (const relation of relations) {
    visit(relation.attributes);
    visit(relation.evidence);
  }
  for (const setting of settings) visit(setting.value);
  return refs;
}

function readReferencedBlobs(
  dir: string,
  refs: Set<string>,
  known: Map<string, BlobMeta>,
  maxBlob: number,
): { sha256: string; mime: string; bytes: number; base64: string }[] {
  const listed: { sha256: string; bytes: number }[] = [];
  let total = 0;
  for (const sha of [...refs].sort()) {
    const file = blobPath(dir, sha);
    if (!existsSync(file))
      throw new CommandError(
        "NOT_FOUND",
        `附件「${sha}」的文件不在了，没有导出。请确认 blobs 目录还在，或删掉引用它的对象后再导出。`,
        null,
      );
    const info = statSync(file);
    if (!info.isFile())
      throw new CommandError(
        "INVALID_DATA",
        `附件「${sha}」不是文件，没有导出。请检查 blobs 目录后再导出。`,
        null,
      );
    listed.push({ sha256: sha, bytes: info.size });
    total += info.size;
  }
  if (total > maxBlob)
    throw new CommandError(
      "LIMIT",
      `附件合计 ${total} 字节，超过上限（${blobLimitText(maxBlob)}），没有导出。最大的附件：${largestBlobs(listed)}。请删掉一些附件后再导出。`,
      null,
    );
  const blobs: {
    sha256: string;
    mime: string;
    bytes: number;
    base64: string;
  }[] = [];
  for (const item of listed) {
    const bytes = readFileSync(blobPath(dir, item.sha256));
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (hash !== item.sha256)
      throw new CommandError(
        "INVALID_DATA",
        `附件「${item.sha256}」的内容和摘要对不上，没有导出。请不要同时往这个工作空间写入，稍后再导出。`,
        null,
      );
    const meta = known.get(item.sha256);
    if (meta && meta.bytes !== bytes.length)
      throw new CommandError(
        "INVALID_DATA",
        `附件「${item.sha256}」登记的大小是 ${meta.bytes} 字节，文件是 ${bytes.length} 字节，没有导出。请稍后再导出。`,
        null,
      );
    blobs.push({
      sha256: item.sha256,
      mime: meta?.mime || "application/octet-stream",
      bytes: bytes.length,
      base64: bytes.toString("base64"),
    });
  }
  return blobs;
}

function collectExternal(
  objects: BundleObject[],
  relations: BundleRelation[],
): ExternalLocator[] {
  const seen = new Set<string>();
  const locators: ExternalLocator[] = [];
  const add = (value: unknown, where: string) => {
    if (value == null) return;
    const locator = normalizeLocator(value, where);
    const key = stable(locator);
    if (seen.has(key)) return;
    seen.add(key);
    locators.push(locator);
  };
  for (const object of objects)
    if (object.source && "external" in object.source)
      add(object.source.external, `对象「${object.id}」的外部定位`);
  for (const relation of relations)
    for (const item of relation.evidence)
      add(item, `关系「${relation.id}」的外部定位`);
  locators.sort((a, b) =>
    stable(a) < stable(b) ? -1 : stable(a) > stable(b) ? 1 : 0,
  );
  return locators;
}

function importV3(
  root: string,
  registry: Registry,
  parsed: Record<string, unknown>,
  options: BundleOptions | undefined,
): BundleImportReport {
  const checked = precheck(
    parsed,
    registry,
    options?.maxBlobBytes ?? MAX_BUNDLE_BLOB_BYTES,
  );
  mkdirSync(root, { recursive: true });
  const temp = mkdtempSync(join(root, ".import-"));
  const now = options?.now ?? Date.now;
  try {
    const initialId = firstFreeId(root, checked.preferredId);
    const db = openWorkspaceDb(join(temp, "workspace.db"), {
      create: true,
      workspaceId: initialId,
      title: checked.title,
      now,
    });
    try {
      writeContents(db, checked, initialId, now());
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      db.close();
    }
    const report = faceReport(initialId, checked);
    writeFileSync(
      join(temp, IMPORT_REPORT_FILENAME),
      `${JSON.stringify(isolationFile(checked, report), null, 2)}\n`,
    );
    const workspaceId = publishDirectory(temp, root, checked.preferredId);
    return { ...report, workspaceId };
  } catch (error) {
    rmSync(temp, { recursive: true, force: true });
    throw asCommandError(error);
  }
}

function faceReport(
  workspaceId: string,
  checked: CheckedBundle,
): BundleImportReport {
  return {
    workspaceId,
    title: checked.title,
    counts: {
      objects: checked.objects.length,
      presentations: checked.presentations.length,
      relations: checked.relations.length,
      blobs: checked.blobs.length,
    },
    degraded: checked.degraded,
    external: checked.external,
  };
}

function isolationFile(checked: CheckedBundle, report: BundleImportReport) {
  const invalidPacks = mergeInvalid(checked);
  return {
    counts: report.counts,
    degraded: report.degraded,
    external: report.external,
    invalidPacks,
  };
}

function mergeInvalid(checked: CheckedBundle): InvalidPack[] {
  const byId = new Map<string, InvalidPack>();
  for (const pack of checked.carriedInvalid) byId.set(pack.id, pack);
  for (const pack of checked.invalidPacks) byId.set(pack.id, pack);
  for (const pack of checked.builtins) byId.delete(pack.id);
  for (const pack of checked.dataPacks) byId.delete(pack.id);
  const merged = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  return merged.map((pack) => ({
    ...pack,
    objects: checked.objects.filter((object) =>
      object.type.startsWith(`${pack.id}.`),
    ),
  }));
}

function writeContents(
  db: Db,
  checked: CheckedBundle,
  workspaceId: string,
  now: number,
): void {
  transaction(db, () => {
    db.prepare("DELETE FROM objects").run();
    const insertObject = db.prepare(
      `INSERT INTO objects (
         id, type, type_version, title, data, source, version,
         created_at, created_by, updated_at, updated_by, rev, deleted_rev
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    );
    for (const object of checked.objects)
      insertObject.run(
        object.id,
        object.type,
        object.typeVersion,
        object.title,
        JSON.stringify(object.data),
        object.source ? JSON.stringify(object.source) : null,
        object.version,
        object.createdAt,
        object.createdBy,
        object.updatedAt,
        object.updatedBy,
        IMPORT_REV,
      );
    const insertPresentation = db.prepare(
      `INSERT INTO presentations (
         id, board_id, object_id, parent_id, x, y, width, height, z, locked,
         appearance, version, updated_at, updated_by, rev, deleted_rev
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    );
    for (const presentation of orderPresentations(checked.presentations))
      insertPresentation.run(
        presentation.id,
        presentation.boardId,
        presentation.objectId,
        presentation.parentId,
        presentation.x,
        presentation.y,
        presentation.width,
        presentation.height,
        presentation.z,
        presentation.locked ? 1 : 0,
        JSON.stringify(presentation.appearance),
        presentation.version,
        presentation.updatedAt,
        presentation.updatedBy,
        IMPORT_REV,
      );
    const insertRelation = db.prepare(
      `INSERT INTO relations (
         id, kind, source_id, target_id, status, basis, attributes, evidence,
         version, created_at, created_by, updated_at, updated_by, rev, deleted_rev
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    );
    for (const relation of checked.relations)
      insertRelation.run(
        relation.id,
        relation.kind,
        relation.sourceId,
        relation.targetId,
        relation.status,
        relation.basis,
        JSON.stringify(relation.attributes),
        JSON.stringify(relation.evidence),
        relation.version,
        relation.createdAt,
        relation.createdBy,
        relation.updatedAt,
        relation.updatedBy,
        IMPORT_REV,
      );
    const insertSetting = db.prepare(
      "INSERT INTO settings (key, value, rev, deleted_rev) VALUES (?, ?, ?, NULL)",
    );
    for (const setting of checked.settings)
      insertSetting.run(setting.key, JSON.stringify(setting.value), IMPORT_REV);
    const insertPack = db.prepare(
      `INSERT INTO packs (id, kind, version, enabled, manifest, rev, deleted_rev)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
    );
    for (const pack of checked.builtins)
      insertPack.run(
        pack.id,
        "builtin",
        pack.version,
        pack.enabled ? 1 : 0,
        null,
        IMPORT_REV,
      );
    for (const pack of checked.dataPacks)
      insertPack.run(
        pack.id,
        "data",
        pack.version,
        pack.enabled ? 1 : 0,
        JSON.stringify(pack.manifest),
        IMPORT_REV,
      );
    const insertBlob = db.prepare(
      "INSERT INTO blobs (sha256, mime, bytes, created_at) VALUES (?, ?, ?, ?)",
    );
    const blobDir = join(workspaceDir(db), "blobs");
    if (checked.blobs.length) mkdirSync(blobDir, { recursive: true });
    for (const blob of checked.blobs) {
      const target = blobPath(workspaceDir(db), blob.sha256);
      writeFileSync(target, blob.bytes, { flag: "wx" });
      insertBlob.run(blob.sha256, blob.mime, blob.bytes.length, now);
    }
    setMeta(db, "workspace_id", workspaceId);
    setMeta(db, "title", checked.title);
    setMeta(db, "home_board_id", checked.homeBoardId);
    setMeta(db, "revision", String(IMPORT_REV));
    setMeta(db, "history_cursor", "");
    setMeta(db, "tombstone_floor", "0");
    setMeta(db, "created_at", String(now));
    markFrameCoords(db);
    db.prepare(
      "INSERT INTO audit (at, actor, actor_kind, action, history_id, detail) VALUES (?, 'import', 'human', 'import', NULL, ?)",
    ).run(
      now,
      JSON.stringify({
        counts: {
          objects: checked.objects.length,
          presentations: checked.presentations.length,
          relations: checked.relations.length,
          blobs: checked.blobs.length,
        },
      }),
    );
  });
}

function precheck(
  parsed: Record<string, unknown>,
  registry: Registry,
  maxBlob: number,
): CheckedBundle {
  if (parsed.formatVersion !== WORKSPACE_BUNDLE_VERSION)
    throw new CommandError(
      "INVALID_DATA",
      `这份导出的格式版本是 ${JSON.stringify(parsed.formatVersion)}，当前只接受版本 ${WORKSPACE_BUNDLE_VERSION}，没有导入。请用当前版本重新导出。`,
      null,
    );
  const workspace = parsed.workspace;
  if (!plain(workspace) || typeof workspace.id !== "string")
    throw new CommandError(
      "INVALID_DATA",
      "这份文件缺少工作空间编号，没有导入。请重新导出一份完整的文件。",
      null,
    );
  if (typeof workspace.title !== "string")
    throw new CommandError(
      "INVALID_DATA",
      "这份文件缺少工作空间标题，没有导入。请重新导出一份完整的文件。",
      null,
    );
  if (typeof workspace.homeBoardId !== "string" || !workspace.homeBoardId)
    throw new CommandError(
      "INVALID_DATA",
      "这份文件缺少首页白板，没有导入。请重新导出一份完整的文件。",
      null,
    );
  const objects = arrayOf(parsed.objects, "对象");
  const presentations = arrayOf(parsed.presentations, "展示");
  const relations = arrayOf(parsed.relations, "关系");
  const settings = arrayOf(parsed.settings, "设置");
  const packs = arrayOf(parsed.packs, "组件包");
  const blobRows = arrayOf(parsed.blobs, "附件");
  const externalRows = arrayOf(parsed.external, "外部资源");
  const normalizedObjects = objects.map((item, index) =>
    normalizeObject(item, index),
  );
  const objectIds = uniqueIds(
    normalizedObjects.map((object) => object.id),
    "对象",
  );
  const normalizedPresentations = presentations.map((item, index) =>
    normalizePresentation(item, index),
  );
  const presentationIds = uniqueIds(
    normalizedPresentations.map((item) => item.id),
    "展示",
  );
  const normalizedRelations = relations.map((item, index) =>
    normalizeRelation(item, index),
  );
  uniqueIds(
    normalizedRelations.map((item) => item.id),
    "关系",
  );
  const allIds = new Set<string>([
    ...objectIds,
    ...presentationIds,
    ...normalizedRelations.map((item) => item.id),
  ]);
  if (
    allIds.size !==
    objectIds.size + presentationIds.size + normalizedRelations.length
  )
    throw new CommandError(
      "INVALID_DATA",
      "对象、展示和关系的编号有重复，没有导入。请重新导出一份完整的文件。",
      null,
    );
  const classified = classifyPacks(packs, registry);
  const known = knownTypes(registry, classified.dataPacks);
  const home = normalizedObjects.find(
    (object) => object.id === workspace.homeBoardId,
  );
  if (!home || !known.containers.has(home.type))
    throw new CommandError(
      "NOT_CONTAINER",
      "首页不是可以进入的白板，没有导入。请重新导出一份完整的文件。",
      null,
    );
  assertGraph(
    normalizedObjects,
    normalizedPresentations,
    normalizedRelations,
    known,
  );
  const carriedInvalid = carriedInvalidPacks(parsed.isolation);
  const degraded = degradedEntries(
    normalizedObjects,
    normalizedRelations,
    classified,
    registry,
  );
  for (const pack of carriedInvalid) {
    if (
      degraded.some(
        (item) => item.kind === "invalid-pack" && item.id === pack.id,
      )
    )
      continue;
    if (classified.dataPacks.some((item) => item.id === pack.id)) continue;
    if (classified.builtins.some((item) => item.id === pack.id)) continue;
    degraded.push({
      kind: "invalid-pack",
      id: pack.id,
      reason: pack.reason,
    });
  }
  const blobs = normalizeBlobs(
    blobRows,
    referencedFrom(
      normalizedObjects,
      normalizedPresentations,
      normalizedRelations,
      settings.map((item, index) => normalizeSetting(item, index)),
    ),
    maxBlob,
  );
  const normalizedSettings = settings.map((item, index) =>
    normalizeSetting(item, index),
  );
  uniqueIds(
    normalizedSettings.map((item) => item.key),
    "设置",
  );
  return {
    preferredId: String(workspace.id),
    title: importedTitle(String(workspace.title)),
    homeBoardId: String(workspace.homeBoardId),
    objects: normalizedObjects,
    presentations: normalizedPresentations,
    relations: normalizedRelations,
    settings: normalizedSettings,
    builtins: classified.builtins,
    dataPacks: classified.dataPacks,
    invalidPacks: classified.invalidPacks,
    blobs,
    degraded,
    external: externalRows.map((item, index) =>
      normalizeLocator(item, `第 ${index + 1} 条外部资源`),
    ),
    carriedInvalid,
  };
}

function classifyPacks(packs: unknown[], registry: Registry) {
  const staged = createRegistry();
  const builtins = new Map<string, BuiltinRow>();
  for (const pack of registry.listPacks()) {
    if (pack.kind !== "builtin") continue;
    staged.registerPack(pack.spec, "builtin");
    builtins.set(pack.spec.id, {
      id: pack.spec.id,
      version: pack.spec.version,
      enabled: pack.spec.id !== CODE_PACK,
    });
  }
  const dataPacks: DataRow[] = [];
  const invalidPacks: InvalidPack[] = [];
  const seen = new Set<string>();
  const entries = packs.map((item, index) => {
    if (!plain(item) || typeof item.id !== "string" || !item.id)
      throw new CommandError(
        "INVALID_DATA",
        `第 ${index + 1} 个组件包没有编号，没有导入。请重新导出一份完整的文件。`,
        null,
      );
    return item;
  });
  entries.sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1));
  for (const entry of entries) {
    const id = String(entry.id);
    if (seen.has(id))
      throw new CommandError(
        "INVALID_DATA",
        `组件包「${id}」重复了，没有导入。请重新导出一份完整的文件。`,
        null,
      );
    seen.add(id);
    const enabled = booleanOr(entry.enabled, `组件包「${id}」的启用状态`);
    const data = isDataPackEntry(entry);
    if (!data) {
      const builtin = builtins.get(id);
      if (!builtin) {
        invalidPacks.push(
          invalidPack({
            id,
            kind: "builtin",
            version: null,
            enabled,
            manifest: null,
            reason: `组件包「${id}」不在本机注册表里，没有注册。`,
          }),
        );
        continue;
      }
      if (enabled === undefined)
        throw new CommandError(
          "INVALID_DATA",
          `内置包「${id}」的启用状态不是 true 或 false，没有导入。请重新导出。`,
          null,
        );
      builtin.enabled = enabled;
      continue;
    }
    const manifest = entry.manifest;
    if (!plain(manifest)) {
      invalidPacks.push(
        invalidPack({
          id,
          kind: "data",
          version: numberOrNull(entry.version),
          enabled,
          manifest: manifest ?? null,
          reason: `组件包「${id}」没有清单，没有注册。`,
        }),
      );
      continue;
    }
    if (builtins.has(id) || staged.getPack(id)?.kind === "builtin") {
      invalidPacks.push(
        invalidPack({
          id,
          kind: "data",
          version: numberOrNull(entry.version),
          enabled,
          manifest,
          reason: `组件包「${id}」和内置包重名，没有注册。原清单留在导入报告里。`,
        }),
      );
      continue;
    }
    if (typeof manifest.id === "string" && manifest.id !== id) {
      invalidPacks.push(
        invalidPack({
          id,
          kind: "data",
          version: numberOrNull(entry.version),
          enabled,
          manifest,
          reason: `组件包「${id}」的清单编号不一致，没有注册。原清单留在导入报告里。`,
        }),
      );
      continue;
    }
    try {
      staged.registerPack(structuredClone(manifest), "data");
    } catch (error) {
      const problem =
        error instanceof PackSpecError
          ? (error.problems[0]?.message ?? error.message)
          : "清单不合格";
      invalidPacks.push(
        invalidPack({
          id,
          kind: "data",
          version: numberOrNull(entry.version),
          enabled,
          manifest,
          reason: `组件包「${id}」的清单不合格（${problem}），没有注册。原清单和它的对象留在导入报告里。`,
        }),
      );
      if (!(error instanceof PackSpecError) && !(error instanceof CommandError))
        throw error;
      continue;
    }
    const version = Number(manifest.version);
    dataPacks.push({
      id,
      version: Number.isInteger(version) ? version : 1,
      enabled: enabled ?? true,
      manifest,
    });
  }
  return { builtins: [...builtins.values()], dataPacks, invalidPacks };
}

function degradedEntries(
  objects: BundleObject[],
  relations: BundleRelation[],
  classified: {
    invalidPacks: InvalidPack[];
    dataPacks: DataRow[];
  },
  registry: Registry,
): BundleDegraded[] {
  const staged = createRegistry();
  for (const pack of registry.listPacks())
    if (pack.kind === "builtin") staged.registerPack(pack.spec, "builtin");
  for (const pack of classified.dataPacks)
    staged.registerPack(pack.manifest, "data");
  const degraded: BundleDegraded[] = [];
  for (const pack of classified.invalidPacks)
    degraded.push({
      kind: "invalid-pack",
      id: pack.id,
      reason: pack.reason,
    });
  for (const object of objects) {
    if (staged.getType(object.type)) continue;
    degraded.push({
      kind: "unknown-type",
      id: object.id,
      reason: `对象「${object.id}」的类型「${object.type}」在本机没有注册，已按原样保留。`,
    });
  }
  for (const relation of relations) {
    if (staged.getRelationKind(relation.kind)) continue;
    degraded.push({
      kind: "unknown-type",
      id: relation.id,
      reason: `关系「${relation.id}」的类型「${relation.kind}」在本机没有注册，已按原样保留。`,
    });
  }
  return degraded;
}

function assertGraph(
  objects: BundleObject[],
  presentations: BundlePresentation[],
  relations: BundleRelation[],
  known: { containers: Set<string>; types: Set<string> },
): void {
  const objectById = new Map(objects.map((object) => [object.id, object]));
  const presentationById = new Map(
    presentations.map((item) => [item.id, item]),
  );
  for (const presentation of presentations) {
    const board = objectById.get(presentation.boardId);
    const object = objectById.get(presentation.objectId);
    if (!board || !object)
      throw new CommandError(
        "INVALID_DATA",
        `展示「${presentation.id}」指向的对象不在这份文件里，没有导入。请重新导出一份完整的文件。`,
        null,
      );
    if (presentation.boardId === presentation.objectId)
      throw new CommandError(
        "CYCLE",
        `展示「${presentation.id}」把白板放进了自己里面，没有导入。请重新导出一份完整的文件。`,
        null,
      );
    if (known.types.has(board.type) && !known.containers.has(board.type))
      throw new CommandError(
        "NOT_CONTAINER",
        `展示「${presentation.id}」所在的「${board.title || board.id}」不是白板，没有导入。请重新导出一份完整的文件。`,
        null,
      );
    if (!presentation.parentId) continue;
    const parent = presentationById.get(presentation.parentId);
    if (!parent)
      throw new CommandError(
        "INVALID_DATA",
        `展示「${presentation.id}」的外框不在这份文件里，没有导入。请重新导出一份完整的文件。`,
        null,
      );
    if (parent.boardId !== presentation.boardId)
      throw new CommandError(
        "INVALID_DATA",
        `展示「${presentation.id}」的外框不在同一块白板上，没有导入。请重新导出一份完整的文件。`,
        null,
      );
  }
  assertParentAcyclic(presentations);
  assertBoardAcyclic(presentations, objectById, known.containers);
  for (const relation of relations) {
    if (
      !objectById.has(relation.sourceId) ||
      !objectById.has(relation.targetId)
    )
      throw new CommandError(
        "INVALID_DATA",
        `关系「${relation.id}」的端点不在这份文件里，没有导入。请重新导出一份完整的文件。`,
        null,
      );
  }
}

function assertParentAcyclic(presentations: BundlePresentation[]): void {
  const parentOf = new Map(
    presentations.map((item) => [item.id, item.parentId]),
  );
  const state = new Map<string, number>();
  const visit = (id: string) => {
    const mark = state.get(id) ?? 0;
    if (mark === 1)
      throw new CommandError(
        "CYCLE",
        "展示的外框套成了环，没有导入。请重新导出一份完整的文件。",
        null,
      );
    if (mark === 2) return;
    state.set(id, 1);
    const parent = parentOf.get(id);
    if (parent) visit(parent);
    state.set(id, 2);
  };
  for (const presentation of presentations) visit(presentation.id);
}

function assertBoardAcyclic(
  presentations: BundlePresentation[],
  objects: Map<string, BundleObject>,
  containers: Set<string>,
): void {
  const edges = new Map<string, string[]>();
  for (const presentation of presentations) {
    const object = objects.get(presentation.objectId);
    if (!object || !containers.has(object.type)) continue;
    const list = edges.get(presentation.boardId) ?? [];
    list.push(presentation.objectId);
    edges.set(presentation.boardId, list);
  }
  const state = new Map<string, number>();
  const visit = (id: string) => {
    const mark = state.get(id) ?? 0;
    if (mark === 1)
      throw new CommandError(
        "CYCLE",
        "白板互相放进了对方里面，没有导入。请重新导出一份完整的文件。",
        null,
      );
    if (mark === 2) return;
    state.set(id, 1);
    for (const next of edges.get(id) ?? []) visit(next);
    state.set(id, 2);
  };
  for (const id of edges.keys()) visit(id);
}

function builtinRegistry(registry: Registry): Registry {
  const staged = createRegistry();
  for (const pack of registry.listPacks())
    if (pack.kind === "builtin") staged.registerPack(pack.spec, "builtin");
  return staged;
}

function knownTypes(
  registry: Registry,
  dataPacks: DataRow[],
): { containers: Set<string>; types: Set<string> } {
  const staged = createRegistry();
  for (const pack of registry.listPacks())
    if (pack.kind === "builtin") staged.registerPack(pack.spec, "builtin");
  for (const pack of dataPacks) staged.registerPack(pack.manifest, "data");
  const containers = new Set<string>();
  const types = new Set<string>();
  for (const pack of staged.listPacks())
    for (const type of pack.spec.types ?? []) {
      types.add(type.type);
      if (type.capabilities?.container) containers.add(type.type);
    }
  return { containers, types };
}

function normalizeObject(value: unknown, index: number): BundleObject {
  if (!plain(value))
    throw new CommandError(
      "INVALID_DATA",
      `第 ${index + 1} 个对象不是对象，没有导入。请重新导出一份完整的文件。`,
      null,
    );
  const id = requireId(value.id, `第 ${index + 1} 个对象`);
  const type = requireText(value.type, `对象「${id}」的类型`);
  return {
    id,
    type,
    typeVersion: requireInt(value.typeVersion, `对象「${id}」的类型版本`, 1),
    title: requireTitle(value.title, `对象「${id}」`),
    data: requireRecord(value.data, `对象「${id}」的数据`),
    source: normalizeSource(value.source, id),
    version: requireInt(value.version, `对象「${id}」的版本`, 1),
    createdAt: requireInt(value.createdAt, `对象「${id}」的创建时间`, 0),
    createdBy: requireText(value.createdBy, `对象「${id}」的创建者`, true),
    updatedAt: requireInt(value.updatedAt, `对象「${id}」的修改时间`, 0),
    updatedBy: requireText(value.updatedBy, `对象「${id}」的修改者`, true),
  };
}

function normalizePresentation(
  value: unknown,
  index: number,
): BundlePresentation {
  if (!plain(value))
    throw new CommandError(
      "INVALID_DATA",
      `第 ${index + 1} 个展示不是对象，没有导入。请重新导出一份完整的文件。`,
      null,
    );
  const id = requireId(value.id, `第 ${index + 1} 个展示`);
  const width = requireFinite(value.width, `展示「${id}」的宽度`);
  const height = requireFinite(value.height, `展示「${id}」的高度`);
  if (width <= 0 || height <= 0)
    throw new CommandError(
      "INVALID_DATA",
      `展示「${id}」的宽高必须大于 0，没有导入。请重新导出一份完整的文件。`,
      null,
    );
  return {
    id,
    boardId: requireId(value.boardId, `展示「${id}」的白板`),
    objectId: requireId(value.objectId, `展示「${id}」的对象`),
    parentId:
      value.parentId == null
        ? null
        : requireId(value.parentId, `展示「${id}」的外框`),
    x: requireFinite(value.x, `展示「${id}」的横坐标`),
    y: requireFinite(value.y, `展示「${id}」的纵坐标`),
    width,
    height,
    z: requireInt(value.z, `展示「${id}」的层`),
    locked: requireBoolean(value.locked, `展示「${id}」的锁定`),
    appearance: normalizeAppearance(value.appearance, id),
    version: requireInt(value.version, `展示「${id}」的版本`, 1),
    updatedAt: requireInt(value.updatedAt, `展示「${id}」的修改时间`, 0),
    updatedBy: requireText(value.updatedBy, `展示「${id}」的修改者`, true),
  };
}

function normalizeRelation(value: unknown, index: number): BundleRelation {
  if (!plain(value))
    throw new CommandError(
      "INVALID_DATA",
      `第 ${index + 1} 条关系不是对象，没有导入。请重新导出一份完整的文件。`,
      null,
    );
  const id = requireId(value.id, `第 ${index + 1} 条关系`);
  if (value.status !== "confirmed" && value.status !== "inferred")
    throw new CommandError(
      "INVALID_DATA",
      `关系「${id}」的状态无法识别，没有导入。请重新导出一份完整的文件。`,
      null,
    );
  const basis =
    value.basis == null
      ? null
      : requireText(value.basis, `关系「${id}」的依据`, true);
  if (value.status === "inferred" && !basis?.trim())
    throw new CommandError(
      "INVALID_DATA",
      `推测关系「${id}」没有依据，没有导入。请补上依据后重新导出。`,
      null,
    );
  if (value.sourceId === value.targetId)
    throw new CommandError(
      "INVALID_DATA",
      `关系「${id}」的两端是同一个对象，没有导入。请重新导出一份完整的文件。`,
      null,
    );
  const evidence = arrayOf(value.evidence, `关系「${id}」的外部定位`).map(
    (item, at) =>
      normalizeLocator(item, `关系「${id}」的第 ${at + 1} 条外部定位`),
  );
  return {
    id,
    kind: requireText(value.kind, `关系「${id}」的类型`),
    sourceId: requireId(value.sourceId, `关系「${id}」的起点`),
    targetId: requireId(value.targetId, `关系「${id}」的终点`),
    status: value.status,
    basis,
    attributes: requireRecord(value.attributes, `关系「${id}」的附加数据`),
    evidence,
    version: requireInt(value.version, `关系「${id}」的版本`, 1),
    createdAt: requireInt(value.createdAt, `关系「${id}」的创建时间`, 0),
    createdBy: requireText(value.createdBy, `关系「${id}」的创建者`, true),
    updatedAt: requireInt(value.updatedAt, `关系「${id}」的修改时间`, 0),
    updatedBy: requireText(value.updatedBy, `关系「${id}」的修改者`, true),
  };
}

function normalizeSetting(value: unknown, index: number): BundleSetting {
  if (!plain(value))
    throw new CommandError(
      "INVALID_DATA",
      `第 ${index + 1} 项设置不是对象，没有导入。请重新导出一份完整的文件。`,
      null,
    );
  const key = requireText(value.key, `第 ${index + 1} 项设置的名字`);
  if (Array.from(key).length > TITLE_LIMIT)
    throw new CommandError(
      "LIMIT",
      `设置「${key.slice(0, 40)}」的名字超过 300 字，没有导入。请缩短后再导出。`,
      null,
    );
  if (value.value === undefined)
    throw new CommandError(
      "INVALID_DATA",
      `设置「${key}」没有值，没有导入。请重新导出一份完整的文件。`,
      null,
    );
  return { key, value: value.value };
}

function normalizeSource(value: unknown, id: string): ObjectSource | null {
  if (value == null) return null;
  if (!plain(value) || !ORIGINS.has(String(value.origin)))
    throw new CommandError(
      "INVALID_DATA",
      `对象「${id}」的来源无法识别，没有导入。请重新导出一份完整的文件。`,
      null,
    );
  if (
    value.origin === "ai-inferred" &&
    (typeof value.basis !== "string" || !value.basis.trim())
  )
    throw new CommandError(
      "INVALID_DATA",
      `对象「${id}」是推测出来的，但没有依据，没有导入。请补上依据后重新导出。`,
      null,
    );
  if (value.external !== undefined)
    normalizeLocator(value.external, `对象「${id}」的外部定位`);
  return value as ObjectSource;
}

function normalizeAppearance(value: unknown, id: string): Appearance {
  const appearance = requireRecord(value, `展示「${id}」的外观`);
  if (
    appearance.detail !== undefined &&
    !DETAILS.has(String(appearance.detail))
  )
    throw new CommandError(
      "INVALID_DATA",
      `展示「${id}」的外观层级无法识别，没有导入。请重新导出一份完整的文件。`,
      null,
    );
  if (
    appearance.coverBlob !== undefined &&
    (typeof appearance.coverBlob !== "string" ||
      !SHA256.test(appearance.coverBlob))
  )
    throw new CommandError(
      "INVALID_DATA",
      `展示「${id}」的封面不是附件摘要，没有导入。请重新导出一份完整的文件。`,
      null,
    );
  if (appearance.accent !== undefined && typeof appearance.accent !== "string")
    throw new CommandError(
      "INVALID_DATA",
      `展示「${id}」的强调色无法识别，没有导入。请重新导出一份完整的文件。`,
      null,
    );
  return appearance as Appearance;
}

function normalizeLocator(value: unknown, where: string): ExternalLocator {
  if (
    !plain(value) ||
    typeof value.kind !== "string" ||
    !LOCATOR_KINDS.has(value.kind) ||
    typeof value.uri !== "string" ||
    !value.uri
  )
    throw new CommandError(
      "INVALID_DATA",
      `${where}无法识别，已停止。请重新导出一份完整的文件。`,
      null,
    );
  for (const key of ["fragment", "version", "fingerprint"] as const)
    if (value[key] !== undefined && typeof value[key] !== "string")
      throw new CommandError(
        "INVALID_DATA",
        `${where}的 ${key} 无法识别，没有导入。请重新导出一份完整的文件。`,
        null,
      );
  return value as ExternalLocator;
}

function normalizeBlobs(
  rows: unknown[],
  referenced: Set<string>,
  maxBlob: number,
): BundleBlob[] {
  const blobs: BundleBlob[] = [];
  const seen = new Set<string>();
  let declared = 0;
  const sizes: { sha256: string; bytes: number }[] = [];
  for (const [index, row] of rows.entries()) {
    if (
      !plain(row) ||
      typeof row.sha256 !== "string" ||
      !SHA256.test(row.sha256)
    )
      throw new CommandError(
        "INVALID_DATA",
        `第 ${index + 1} 个附件的摘要无法识别，没有导入。请重新导出一份完整的文件。`,
        null,
      );
    if (seen.has(row.sha256))
      throw new CommandError(
        "INVALID_DATA",
        `附件「${row.sha256}」重复了，没有导入。请重新导出一份完整的文件。`,
        null,
      );
    seen.add(row.sha256);
    if (
      typeof row.bytes !== "number" ||
      !Number.isSafeInteger(row.bytes) ||
      row.bytes < 0
    )
      throw new CommandError(
        "INVALID_DATA",
        `附件「${row.sha256}」的大小无法识别，没有导入。请重新导出一份完整的文件。`,
        null,
      );
    declared += row.bytes;
    sizes.push({ sha256: row.sha256, bytes: row.bytes });
  }
  if (declared > maxBlob)
    throw new CommandError(
      "LIMIT",
      `附件合计 ${declared} 字节，超过上限（${blobLimitText(maxBlob)}），没有导入。最大的附件：${largestBlobs(sizes)}。请删掉一些附件后再导出。`,
      null,
    );
  let actual = 0;
  for (const row of rows) {
    if (!plain(row)) continue;
    const sha = String(row.sha256);
    if (
      typeof row.base64 !== "string" ||
      typeof row.mime !== "string" ||
      !row.mime
    )
      throw new CommandError(
        "INVALID_DATA",
        `附件「${sha}」缺少内容或类型，没有导入。请重新导出一份完整的文件。`,
        null,
      );
    if (row.mime.length > 2000)
      throw new CommandError(
        "LIMIT",
        `附件「${sha}」的类型名太长，没有导入。请重新导出一份完整的文件。`,
        null,
      );
    const bytes = decodeBase64(row.base64, sha);
    if (bytes.length !== row.bytes)
      throw new CommandError(
        "INVALID_DATA",
        `附件「${sha}」声明 ${row.bytes} 字节，实际解出 ${bytes.length} 字节，没有导入。请重新导出。`,
        null,
      );
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (hash !== sha)
      throw new CommandError(
        "INVALID_DATA",
        `附件「${sha}」的内容和摘要对不上，没有导入。请重新导出。`,
        null,
      );
    actual += bytes.length;
    if (actual > maxBlob)
      throw new CommandError(
        "LIMIT",
        `附件合计超过上限（${blobLimitText(maxBlob)}），没有导入。最大的附件：${largestBlobs(sizes)}。请删掉一些附件后再导出。`,
        null,
      );
    blobs.push({ sha256: sha, mime: row.mime, bytes });
  }
  for (const sha of referenced)
    if (!seen.has(sha))
      throw new CommandError(
        "NOT_FOUND",
        `内容引用了附件「${sha}」，文件里却没有它，没有导入。请重新导出一份完整的文件。`,
        null,
      );
  return blobs;
}

function referencedFrom(
  objects: BundleObject[],
  presentations: BundlePresentation[],
  relations: BundleRelation[],
  settings: BundleSetting[],
): Set<string> {
  const refs = new Set<string>();
  const visit = (value: unknown, key?: string) => {
    if (typeof value === "string") {
      if ((key === "blob" || key === "coverBlob") && SHA256.test(value))
        refs.add(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!plain(value)) return;
    for (const [childKey, child] of Object.entries(value))
      visit(child, childKey);
  };
  for (const object of objects) {
    visit(object.data);
    visit(object.source);
  }
  for (const presentation of presentations) visit(presentation.appearance);
  for (const relation of relations) {
    visit(relation.attributes);
    visit(relation.evidence);
  }
  for (const setting of settings) visit(setting.value);
  return refs;
}

function carriedInvalidPacks(value: unknown): InvalidPack[] {
  if (value === undefined) return [];
  if (!plain(value))
    throw new CommandError(
      "INVALID_DATA",
      "这份文件里的导入报告不是对象，没有导入。请重新导出。",
      null,
    );
  if (value.invalidPacks === undefined) return [];
  if (!Array.isArray(value.invalidPacks))
    throw new CommandError(
      "INVALID_DATA",
      "这份文件里的导入报告损坏了，没有导入。请重新导出。",
      null,
    );
  return value.invalidPacks.map((item, index) => {
    if (!plain(item) || typeof item.id !== "string" || !item.id)
      throw new CommandError(
        "INVALID_DATA",
        `导入报告里的第 ${index + 1} 个无效包没有编号，没有导入。请重新导出。`,
        null,
      );
    const objects = Array.isArray(item.objects)
      ? item.objects.map((object, at) => normalizeObject(object, at))
      : [];
    return {
      id: item.id,
      kind: item.kind === "builtin" ? "builtin" : "data",
      version: numberOrNull(item.version),
      enabled: typeof item.enabled === "boolean" ? item.enabled : null,
      manifest: item.manifest ?? null,
      objects,
      reason:
        typeof item.reason === "string" && item.reason
          ? item.reason
          : `组件包「${item.id}」没有注册。原清单仍留在导入报告里。`,
    };
  });
}

function importV2Bundle(
  root: string,
  registry: Registry,
  json: string,
  now: () => number,
): BundleImportReport {
  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(json) as unknown;
    if (!plain(value)) throw new Error("not object");
    parsed = value;
  } catch {
    throw new CommandError(
      "INVALID_DATA",
      "这个文件不是 JSON，没法导入。请选择导出的工作空间文件。",
      null,
    );
  }
  mkdirSync(root, { recursive: true });
  const preferred = typeof parsed.id === "string" ? parsed.id : "imported";
  const id = firstFreeId(root, preferred);
  const dir = join(root, id);
  const jsonFile = join(tmpdir(), `sand-v2-${randomUUID()}.json`);
  writeFileSync(jsonFile, json);
  try {
    const imported = importV2(
      jsonFile,
      join(dir, "workspace.db"),
      builtinRegistry(registry),
      now,
    );
    const db = openWorkspaceDb(join(dir, "workspace.db"), { create: false });
    try {
      const title = importedTitle(getMeta(db, "title") ?? "");
      setMeta(db, "title", title);
      setMeta(db, "workspace_id", id);
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      const blobs = db.prepare("SELECT COUNT(*) AS n FROM blobs").get() as {
        n: number;
      };
      return {
        workspaceId: id,
        title,
        counts: {
          objects: imported.objects,
          presentations: imported.presentations,
          relations: imported.relations,
          blobs: Number(blobs.n),
        },
        degraded: [],
        external: [],
      };
    } finally {
      db.close();
    }
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw asCommandError(error);
  } finally {
    rmSync(jsonFile, { force: true });
  }
}

function publishDirectory(
  temp: string,
  root: string,
  preferred: string,
): string {
  const base = safeWorkspaceId(preferred);
  let stamped = getStampedId(temp);
  for (const id of workspaceIds(base)) {
    assertInside(root, id);
    const target = join(root, id);
    if (existsSync(target)) continue;
    if (stamped !== id) {
      stampWorkspaceId(temp, id);
      stamped = id;
    }
    try {
      renameSync(temp, target);
      return id;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST" || code === "ENOTEMPTY" || existsSync(target))
        continue;
      throw error;
    }
  }
  throw new CommandError(
    "LIMIT",
    "工作空间编号的后缀已经用完，没有导入。请换一个工作空间目录后再试。",
    null,
  );
}

function getStampedId(temp: string): string {
  const db = openWorkspaceDb(join(temp, "workspace.db"), { create: false });
  try {
    return getMeta(db, "workspace_id") ?? "";
  } finally {
    db.close();
  }
}

function stampWorkspaceId(temp: string, id: string): void {
  const db = openWorkspaceDb(join(temp, "workspace.db"), { create: false });
  try {
    setMeta(db, "workspace_id", id);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
}

function firstFreeId(root: string, preferred: string): string {
  const base = safeWorkspaceId(preferred);
  for (const id of workspaceIds(base)) {
    assertInside(root, id);
    if (!existsSync(join(root, id))) return id;
  }
  throw new CommandError(
    "LIMIT",
    "工作空间编号的后缀已经用完，没有导入。请换一个工作空间目录后再试。",
    null,
  );
}

function* workspaceIds(base: string): Generator<string> {
  yield base;
  for (let n = 2; n < 10000; n++) yield suffixed(base, n);
}

function suffixed(base: string, n: number): string {
  const suffix = `-${n}`;
  let stem = base.slice(0, 63 - suffix.length).replace(/-+$/, "");
  if (!/^[a-z0-9]/.test(stem)) stem = "w";
  const id = `${stem}${suffix}`;
  return SAFE_ID.test(id) ? id : `imported${suffix}`.slice(0, 63);
}

function safeWorkspaceId(raw: string): string {
  let slug = "";
  for (const char of raw.toLowerCase()) {
    if (/[a-z0-9-]/.test(char)) slug += char;
    else if (slug && !slug.endsWith("-")) slug += "-";
  }
  slug = slug.replace(/^-+/, "").replace(/-+$/, "");
  if (slug.length > 63) slug = slug.slice(0, 63).replace(/-+$/, "");
  return SAFE_ID.test(slug) ? slug : "imported";
}

function assertInside(root: string, id: string): void {
  if (!SAFE_ID.test(id))
    throw new CommandError(
      "FORBIDDEN",
      `工作空间编号「${id}」不能用作目录名，没有导入。`,
      null,
    );
  const base = resolve(root);
  const rel = relative(base, resolve(base, id));
  if (
    !rel ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel) ||
    rel.includes(sep)
  )
    throw new CommandError(
      "FORBIDDEN",
      `工作空间编号「${id}」会跑到工作空间目录外面，没有导入。`,
      null,
    );
}

function importedTitle(title: string): string {
  const suffix = "（导入）";
  const base = title.trim() || "未命名工作空间";
  const next = `${base}${suffix}`;
  if (Array.from(next).length <= TITLE_LIMIT) return next;
  const room = TITLE_LIMIT - Array.from(suffix).length;
  return `${Array.from(base).slice(0, Math.max(room, 0)).join("")}${suffix}`;
}

function orderPresentations(rows: BundlePresentation[]): BundlePresentation[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const ordered: BundlePresentation[] = [];
  const seen = new Set<string>();
  const visit = (row: BundlePresentation) => {
    if (seen.has(row.id)) return;
    seen.add(row.id);
    if (row.parentId) {
      const parent = byId.get(row.parentId);
      if (parent) visit(parent);
    }
    ordered.push(row);
  };
  for (const row of rows) visit(row);
  return ordered;
}

function readIsolation(dir: string): unknown {
  const file = join(dir, IMPORT_REPORT_FILENAME);
  if (!existsSync(file)) return undefined;
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new CommandError(
      "INVALID_DATA",
      "工作空间目录里的导入报告读不出来，没有导出。请确认 import-report.json 仍是可读的文件后再导出。",
      null,
    );
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!plain(parsed)) throw new Error("not object");
    return parsed;
  } catch (error) {
    if (error instanceof CommandError) throw error;
    throw new CommandError(
      "INVALID_DATA",
      "工作空间目录里的导入报告不是 JSON 对象，没有导出。请不要手改 import-report.json。",
      null,
    );
  }
}

function workspaceDir(db: Db): string {
  const rows = db.prepare("PRAGMA database_list").all() as {
    name: string;
    file: string;
  }[];
  const main = rows.find((row) => row.name === "main") ?? rows[0];
  if (!main?.file)
    throw new CommandError(
      "INTERNAL",
      "找不到工作空间目录，没有继续。请重新打开工作空间后再试。",
      null,
    );
  return dirname(main.file);
}

function blobPath(dir: string, sha: string): string {
  if (!SHA256.test(sha))
    throw new CommandError(
      "INVALID_DATA",
      `附件摘要「${sha}」无法识别。`,
      null,
    );
  const root = join(dir, "blobs");
  const target = join(root, sha);
  const rel = relative(root, target);
  if (rel !== sha)
    throw new CommandError(
      "FORBIDDEN",
      "附件路径跑到了 blobs 目录外面，已拒绝。",
      null,
    );
  return target;
}

function decodeBase64(value: string, sha: string): Buffer {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value))
    throw new CommandError(
      "INVALID_DATA",
      `附件「${sha}」的内容不是 base64，没有导入。请重新导出。`,
      null,
    );
  const bytes = Buffer.from(value, "base64");
  const canonical = bytes.toString("base64").replace(/=+$/, "");
  if (canonical !== value.replace(/=+$/, ""))
    throw new CommandError(
      "INVALID_DATA",
      `附件「${sha}」的 base64 无法原样解出，没有导入。请重新导出。`,
      null,
    );
  return bytes;
}

function largestBlobs(items: { sha256: string; bytes: number }[]): string {
  return [...items]
    .sort((a, b) => b.bytes - a.bytes || (a.sha256 < b.sha256 ? -1 : 1))
    .slice(0, 5)
    .map((item) => `${item.sha256}（${item.bytes} 字节）`)
    .join("，");
}

function blobLimitText(limit: number): string {
  return limit === MAX_BUNDLE_BLOB_BYTES ? "200 MiB" : `${limit} 字节`;
}

function arrayOf(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value))
    throw new CommandError(
      "INVALID_DATA",
      `这份文件缺少${label}列表，没有导入。请重新导出一份完整的文件。`,
      null,
    );
  return value;
}

function uniqueIds(ids: string[], label: string): Set<string> {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id))
      throw new CommandError(
        "INVALID_DATA",
        `${label}「${id}」重复了，没有导入。请重新导出一份完整的文件。`,
        null,
      );
    seen.add(id);
  }
  return seen;
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== "string" || !value)
    throw new CommandError(
      "INVALID_DATA",
      `${label}缺少编号，没有导入。请重新导出一份完整的文件。`,
      null,
    );
  return value;
}

function requireText(
  value: unknown,
  label: string,
  allowEmpty = false,
): string {
  if (typeof value !== "string" || (!allowEmpty && !value))
    throw new CommandError(
      "INVALID_DATA",
      `${label}无法识别，没有导入。请重新导出一份完整的文件。`,
      null,
    );
  return value;
}

function requireTitle(value: unknown, label: string): string {
  const title = requireText(value, `${label}的标题`, true);
  if (Array.from(title).length > TITLE_LIMIT)
    throw new CommandError(
      "LIMIT",
      `${label}的标题超过 300 字，没有导入。请缩短后再导出。`,
      null,
    );
  return title;
}

function requireInt(
  value: unknown,
  label: string,
  min = Number.MIN_SAFE_INTEGER,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min)
    throw new CommandError(
      "INVALID_DATA",
      `${label}无法识别，没有导入。请重新导出一份完整的文件。`,
      null,
    );
  return value;
}

function requireFinite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new CommandError(
      "INVALID_DATA",
      `${label}无法识别，没有导入。请重新导出一份完整的文件。`,
      null,
    );
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean")
    throw new CommandError(
      "INVALID_DATA",
      `${label}无法识别，没有导入。请重新导出一份完整的文件。`,
      null,
    );
  return value;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!plain(value))
    throw new CommandError(
      "INVALID_DATA",
      `${label}必须是对象，没有导入。请重新导出一份完整的文件。`,
      null,
    );
  return value;
}

function booleanOr(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean")
    throw new CommandError(
      "INVALID_DATA",
      `${label}不是 true 或 false，没有导入。请重新导出。`,
      null,
    );
  return value;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isDataPackEntry(entry: Record<string, unknown>): boolean {
  return entry.kind === "data" || entry.manifest !== undefined;
}

function isV3Bundle(value: unknown): value is Record<string, unknown> {
  return plain(value) && value.format === WORKSPACE_BUNDLE_FORMAT;
}

function isV2Bundle(value: unknown): value is Record<string, unknown> {
  return (
    plain(value) &&
    Object.prototype.hasOwnProperty.call(value, "schemaVersion") &&
    Array.isArray(value.boards)
  );
}

function plain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function stable(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map((item) => stable(item)).join(",")}]`;
  if (plain(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function invalidPack(
  pack: Omit<InvalidPack, "objects" | "enabled"> & {
    enabled: boolean | null | undefined;
  },
): InvalidPack {
  return { ...pack, enabled: pack.enabled ?? null, objects: [] };
}

function asCommandError(
  error: unknown,
  action: "导入" | "导出" = "导入",
): CommandError {
  if (error instanceof CommandError) return error;
  if (error instanceof V2MigrationError)
    return new CommandError("INVALID_DATA", error.message, null);
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("跳过"))
    return new CommandError(
      "INVALID_DATA",
      "这份工作空间的结构不完整，整份没有导入。请重新导出一份完整的文件。",
      null,
    );
  const wrapped = new CommandError(
    "INVALID_DATA",
    action === "导出"
      ? "导出没有完成，工作空间没有改动。请稍后再试。"
      : "导入没有完成，临时文件已删除，原来的工作空间没有改动。请重新导出后再试。",
    null,
  );
  if (error instanceof Error) wrapped.cause = error;
  return wrapped;
}
