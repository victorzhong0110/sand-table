// 工作空间整包导出与导入。
//
// 契约：docs/kernel-v3/05-delivery-contracts.md §3
// 任务卡：docs/kernel-v3/tasks/T25-export-import.md

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  applyCommands,
  CommandError,
  createRegistry,
  exportWorkspaceBundle,
  getMeta,
  IMPORT_REPORT_FILENAME,
  importWorkspaceBundle,
  isPackEnabled,
  MAX_BUNDLE_BLOB_BYTES,
  MAX_BUNDLE_JSON_BYTES,
  openWorkspace,
  openWorkspaceDb,
  toObjectRow,
  toPresentationRow,
  toRelationRow,
  WORKSPACE_BUNDLE_FORMAT,
  type Actor,
  type Db,
  type Registry,
} from "../kernel/index.ts";
import { builtinPacks } from "../packs/index.ts";

const actor: Actor = { id: "hui", kind: "human" };
const FIXTURES = fileURLToPath(new URL("./fixtures/v2/", import.meta.url));
const MEDIA = Buffer.from("hello-attachment");
const COVER = Buffer.from("cover-bytes-ok");
const mediaSha = createHash("sha256").update(MEDIA).digest("hex");
const coverSha = createHash("sha256").update(COVER).digest("hex");

function freshRegistry(): Registry {
  const created = createRegistry();
  for (const pack of builtinPacks) created.registerPack(pack, "builtin");
  return created;
}

function readingKit() {
  return {
    format: "sand-table-pack",
    formatVersion: 2,
    id: "reading-kit",
    title: "阅读",
    version: 1,
    description: "一张阅读卡片",
    types: [
      {
        type: "reading-kit.card",
        title: "卡片",
        description: "一张卡片",
        icon: "note",
        version: 1,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            note: {
              type: "string",
              "x-sand-label": "笔记",
              "x-sand-widget": "text",
            },
          },
        },
        display: {
          material: "paper",
          defaultSize: { width: 200, height: 120 },
          summary: ["note"],
        },
      },
    ],
  };
}

type Scene = {
  root: string;
  id: string;
  db: Db;
  registry: Registry;
  homeId: string;
  noteId: string;
  frameId: string;
  mediaId: string;
  cardId: string;
  framePresentationId: string;
  notePresentationId: string;
  close: () => void;
};

function scene(): Scene {
  const root = mkdtempSync(join(tmpdir(), "sand-bundle-"));
  const id = "demo";
  const reg = freshRegistry();
  const opened = openWorkspace(root, id, reg, { title: "原稿" });
  const db = opened.db;
  const homeId = getMeta(db, "home_board_id")!;
  const close = () => {
    try {
      db.close();
    } catch {
      /* 已经关过 */
    }
    rmSync(root, { recursive: true, force: true });
  };
  try {
    applyCommands(db, reg, {
      actor,
      intentId: "pack",
      commands: [{ op: "pack.import", manifest: readingKit() }],
    });
    applyCommands(db, reg, {
      actor,
      intentId: "disable-pack",
      commands: [{ op: "pack.disable", id: "novel" }],
    });
    const made = applyCommands(db, reg, {
      actor,
      intentId: "content",
      label: "摆上内容",
      commands: [
        {
          op: "object.create",
          ref: "note",
          type: "base.note",
          title: "便签",
          data: { body: "正文" },
          source: {
            origin: "human",
            external: {
              kind: "git",
              uri: "git://example/repo",
              fragment: "main",
            },
          },
        },
        {
          op: "object.create",
          ref: "frame",
          type: "base.frame",
          title: "框",
          data: {},
        },
        {
          op: "object.create",
          ref: "media",
          type: "base.media",
          title: "图",
          data: { blob: mediaSha, mime: "image/png", caption: "一张图" },
        },
        {
          op: "object.create",
          ref: "card",
          type: "reading-kit.card",
          title: "阅读卡片",
          data: { note: "保留下来" },
          source: {
            origin: "imported",
            external: {
              kind: "git",
              uri: "git://example/repo",
              fragment: "main",
            },
          },
        },
        {
          op: "object.create",
          ref: "gone",
          type: "base.note",
          title: "将被删除",
          data: { body: "不该出现在导出里" },
        },
        {
          op: "presentation.create",
          ref: "frame-box",
          boardId: homeId,
          objectId: "@frame",
          x: 10,
          y: 20,
          width: 400,
          height: 300,
          appearance: { coverBlob: coverSha },
        },
        {
          op: "presentation.create",
          ref: "note-box",
          boardId: homeId,
          objectId: "@note",
          parentId: "@frame-box",
          x: 12.5,
          y: 16,
          width: 200,
          height: 80,
        },
        {
          op: "presentation.create",
          boardId: homeId,
          objectId: "@media",
          x: 30,
          y: 40,
          width: 120,
          height: 90,
        },
        {
          op: "presentation.create",
          boardId: homeId,
          objectId: "@card",
          x: 50,
          y: 60,
          width: 180,
          height: 100,
        },
        {
          op: "relation.create",
          ref: "link",
          kind: "base.related",
          sourceId: "@note",
          targetId: "@card",
          status: "confirmed",
          evidence: [
            {
              kind: "url",
              uri: "https://example.com/a",
              fragment: "page=2",
            },
          ],
        },
        { op: "setting.set", key: "theme", value: { name: "night" } },
      ],
    });
    applyCommands(db, reg, {
      actor,
      intentId: "revise",
      commands: [
        {
          op: "object.update",
          id: made.created.note!,
          title: "便签第二稿",
          expectedVersion: 1,
        },
      ],
    });
    applyCommands(db, reg, {
      actor,
      intentId: "remove",
      commands: [{ op: "object.delete", id: made.created.gone! }],
    });
    writeBlob(root, id, mediaSha, "image/png", MEDIA);
    writeBlob(root, id, coverSha, "image/png", COVER);
    return {
      root,
      id,
      db,
      registry: reg,
      homeId,
      noteId: made.created.note!,
      frameId: made.created.frame!,
      mediaId: made.created.media!,
      cardId: made.created.card!,
      framePresentationId: made.created["frame-box"]!,
      notePresentationId: made.created["note-box"]!,
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}

function writeBlob(
  root: string,
  id: string,
  sha: string,
  mime: string,
  bytes: Buffer,
): void {
  const db = openOwned(root, id);
  try {
    const dir = join(root, id, "blobs");
    writeFileSync(join(dir, sha), bytes);
    db.prepare(
      "INSERT INTO blobs (sha256, mime, bytes, created_at) VALUES (?, ?, ?, ?)",
    ).run(sha, mime, bytes.length, 1);
  } finally {
    db.close();
  }
}

function openOwned(root: string, id: string): Db {
  mkdirSync(join(root, id, "blobs"), { recursive: true });
  return openWorkspaceDb(join(root, id, "workspace.db"), { create: false });
}

function dirs(root: string): string[] {
  return readdirSync(root)
    .filter((name) => !name.startsWith(".import-"))
    .sort();
}

function live<T>(
  db: Db,
  sql: string,
  map: (row: Record<string, unknown>) => T,
): T[] {
  return (db.prepare(sql).all() as Record<string, unknown>[]).map(map);
}

function contentObjects(db: Db) {
  return live(
    db,
    "SELECT * FROM objects WHERE deleted_rev IS NULL ORDER BY id",
    (row) => {
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
    },
  );
}

function contentPresentations(db: Db) {
  return live(
    db,
    "SELECT * FROM presentations WHERE deleted_rev IS NULL ORDER BY id",
    (row) => {
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
    },
  );
}

function contentRelations(db: Db) {
  return live(
    db,
    "SELECT * FROM relations WHERE deleted_rev IS NULL ORDER BY id",
    (row) => {
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
    },
  );
}

function settingsOf(db: Db) {
  return (
    db
      .prepare(
        "SELECT key, value FROM settings WHERE deleted_rev IS NULL ORDER BY key",
      )
      .all() as { key: string; value: string }[]
  ).map((row) => ({ key: row.key, value: JSON.parse(row.value) }));
}

function packsOf(db: Db) {
  return (
    db
      .prepare(
        `SELECT id, kind, version, enabled, manifest
         FROM packs WHERE deleted_rev IS NULL ORDER BY id`,
      )
      .all() as {
      id: string;
      kind: string;
      version: number;
      enabled: number;
      manifest: string | null;
    }[]
  ).map((row) => ({
    id: row.id,
    kind: row.kind,
    version: row.version,
    enabled: row.enabled === 1,
    manifest: row.manifest ? (JSON.parse(row.manifest) as unknown) : null,
  }));
}

test("上限是契约里的 200 MiB 和 300 MiB", () => {
  assert.equal(MAX_BUNDLE_BLOB_BYTES, 200 * 1024 * 1024);
  assert.equal(MAX_BUNDLE_JSON_BYTES, 300 * 1024 * 1024);
});

test("往返：内容、附件、外框坐标和包状态一致，已删除的行不在导出里", () => {
  const s = scene();
  try {
    const beforeRev = getMeta(s.db, "revision");
    const history = s.db.prepare("SELECT COUNT(*) AS n FROM history").get() as {
      n: number;
    };
    assert.ok(history.n > 0, "源工作空间有撤销历史");
    const exported = exportWorkspaceBundle(s.db);
    assert.equal(getMeta(s.db, "revision"), beforeRev, "导出不改修订号");
    const bundle = JSON.parse(exported.json) as {
      format: string;
      formatVersion: number;
      workspace: { id: string; homeBoardId: string };
      objects: { id: string; title: string }[];
      history?: unknown;
      audit?: unknown;
      views?: unknown;
      external: { kind: string; uri: string }[];
    };
    assert.equal(bundle.format, WORKSPACE_BUNDLE_FORMAT);
    assert.equal(bundle.formatVersion, 3);
    assert.equal(exported.filename, "sand-table-demo.json");
    assert.equal(bundle.history, undefined);
    assert.equal(bundle.audit, undefined);
    assert.equal(bundle.views, undefined);
    assert.ok(
      bundle.objects.some((object) => object.title === "便签第二稿"),
      "存活对象在导出里",
    );
    assert.ok(
      !bundle.objects.some((object) => object.title === "将被删除"),
      "已删除的对象不导出",
    );
    assert.equal(bundle.external.length, 2, "相同的外部定位只留一条");
    const liveIds = contentObjects(s.db).map((object) => object.id);
    assert.deepEqual(
      bundle.objects.map((object) => object.id).sort(),
      [...liveIds].sort(),
      "一次导出的对象与当时的存活行一致",
    );

    const first = importWorkspaceBundle(s.root, freshRegistry(), exported.json);
    assert.equal(first.workspaceId, "demo-2");
    assert.equal(first.title, "原稿（导入）");
    assert.equal(first.counts.blobs, 2);
    assert.equal(first.external.length, 2);
    assert.doesNotMatch(JSON.stringify(first), /跳过/);
    const opened = openWorkspace(s.root, first.workspaceId, freshRegistry());
    try {
      assert.deepEqual(contentObjects(opened.db), contentObjects(s.db));
      assert.deepEqual(
        contentPresentations(opened.db),
        contentPresentations(s.db),
      );
      assert.deepEqual(contentRelations(opened.db), contentRelations(s.db));
      assert.deepEqual(settingsOf(opened.db), settingsOf(s.db));
      const sourcePacks = packsOf(s.db);
      const importedPacks = packsOf(opened.db);
      assert.deepEqual(
        importedPacks.find((pack) => pack.id === "reading-kit"),
        sourcePacks.find((pack) => pack.id === "reading-kit"),
      );
      assert.equal(isPackEnabled(opened.db, "novel"), false);
      assert.equal(isPackEnabled(opened.db, "base"), true);
      assert.equal(getMeta(opened.db, "home_board_id"), s.homeId);
      assert.equal(getMeta(opened.db, "revision"), "1");
      assert.equal(getMeta(opened.db, "history_cursor"), "");
      const importedHistory = opened.db
        .prepare("SELECT COUNT(*) AS n FROM history")
        .get() as { n: number };
      assert.equal(importedHistory.n, 0, "不复制撤销历史");
      const revs = opened.db
        .prepare(
          `SELECT rev AS n FROM objects
           UNION ALL SELECT rev FROM presentations
           UNION ALL SELECT rev FROM relations
           UNION ALL SELECT rev FROM settings
           UNION ALL SELECT rev FROM packs`,
        )
        .all() as { n: number }[];
      assert.ok(revs.every((row) => row.n === 1));
      assert.deepEqual(
        readFileSync(join(s.root, first.workspaceId, "blobs", mediaSha)),
        MEDIA,
      );
      assert.deepEqual(
        readFileSync(join(s.root, first.workspaceId, "blobs", coverSha)),
        COVER,
      );
      const child = contentPresentations(opened.db).find(
        (item) => item.id === s.notePresentationId,
      );
      assert.equal(child?.parentId, s.framePresentationId);
      assert.equal(child?.x, 12.5);

      const again = importWorkspaceBundle(
        s.root,
        freshRegistry(),
        exported.json,
      );
      assert.equal(again.workspaceId, "demo-3");
      assert.notEqual(again.workspaceId, first.workspaceId);
      const reread = openWorkspace(s.root, first.workspaceId, freshRegistry());
      try {
        assert.deepEqual(contentObjects(reread.db), contentObjects(s.db));
      } finally {
        reread.db.close();
      }
      assert.equal(getMeta(s.db, "title"), "原稿", "源工作空间标题不变");
    } finally {
      opened.db.close();
    }
  } finally {
    s.close();
  }
});

test("缺端点、缺附件、不是 JSON：整份失败，不留目录，报告里不写跳过", () => {
  const s = scene();
  try {
    const exported = JSON.parse(exportWorkspaceBundle(s.db).json) as {
      objects: { id: string }[];
      presentations: { objectId: string }[];
      blobs: { sha256: string }[];
    };
    const before = dirs(s.root);
    const missingObject = structuredClone(exported);
    const dropped = missingObject.objects.find((object) =>
      missingObject.presentations.some((item) => item.objectId === object.id),
    );
    missingObject.objects = missingObject.objects.filter(
      (object) => object.id !== dropped?.id,
    );
    assert.throws(
      () =>
        importWorkspaceBundle(
          s.root,
          freshRegistry(),
          JSON.stringify(missingObject),
        ),
      (error: unknown) => {
        assert.ok(error instanceof CommandError);
        assert.doesNotMatch(error.message, /跳过/);
        return true;
      },
    );
    const missingBlob = structuredClone(exported);
    missingBlob.blobs = [];
    assert.throws(
      () =>
        importWorkspaceBundle(
          s.root,
          freshRegistry(),
          JSON.stringify(missingBlob),
        ),
      (error: unknown) => {
        assert.ok(error instanceof CommandError);
        assert.doesNotMatch(error.message, /跳过/);
        assert.match(error.message, new RegExp(mediaSha));
        return true;
      },
    );
    assert.throws(
      () => importWorkspaceBundle(s.root, freshRegistry(), "这不是 JSON"),
      (error: unknown) => {
        assert.ok(error instanceof CommandError);
        assert.match(error.message, /不是 JSON/);
        assert.doesNotMatch(error.message, /跳过/);
        return true;
      },
    );
    assert.deepEqual(dirs(s.root), before);
    assert.equal(
      readdirSync(s.root).some((name) => name.startsWith(".import-")),
      false,
      "临时目录已删除",
    );
  } finally {
    s.close();
  }
});

test("外框不成环、不跨白板；首页必须是白板", () => {
  const s = scene();
  try {
    const bundle = JSON.parse(exportWorkspaceBundle(s.db).json) as {
      workspace: { homeBoardId: string };
      objects: Record<string, unknown>[];
      presentations: { id: string; boardId: string; parentId: string | null }[];
    };
    const before = dirs(s.root);
    const cycled = structuredClone(bundle);
    const parent = cycled.presentations.find((item) => item.parentId);
    const frame = cycled.presentations.find(
      (item) => item.id === parent?.parentId,
    );
    assert.ok(parent && frame);
    frame.parentId = parent.id;
    assert.throws(
      () =>
        importWorkspaceBundle(s.root, freshRegistry(), JSON.stringify(cycled)),
      /环/,
    );
    const crossed = structuredClone(bundle);
    crossed.objects.push({
      id: "other-board",
      type: "base.board",
      typeVersion: 1,
      title: "另一块",
      data: {},
      source: null,
      version: 1,
      createdAt: 1,
      createdBy: "hui",
      updatedAt: 1,
      updatedBy: "hui",
    });
    const child = crossed.presentations.find((item) => item.parentId);
    assert.ok(child);
    child.boardId = "other-board";
    assert.throws(
      () =>
        importWorkspaceBundle(s.root, freshRegistry(), JSON.stringify(crossed)),
      /同一块白板/,
    );
    const note = bundle.objects.find((object) => object.type === "base.note");
    const badHome = structuredClone(bundle);
    badHome.workspace.homeBoardId = String(note?.id);
    assert.throws(
      () =>
        importWorkspaceBundle(s.root, freshRegistry(), JSON.stringify(badHome)),
      /首页/,
    );
    assert.deepEqual(dirs(s.root), before);
  } finally {
    s.close();
  }
});

test("未知类型保留，无效包不注册但清单和对象还在，再次导出还能带上", () => {
  const s = scene();
  try {
    const bundle = JSON.parse(exportWorkspaceBundle(s.db).json) as {
      objects: Record<string, unknown>[];
      presentations: Record<string, unknown>[];
      packs: Record<string, unknown>[];
    };
    bundle.objects.push({
      id: "ghost-1",
      type: "ghost.card",
      typeVersion: 1,
      title: "不认识的卡片",
      data: { keep: 1, extra: "原样" },
      source: null,
      version: 4,
      createdAt: 10,
      createdBy: "hui",
      updatedAt: 11,
      updatedBy: "hui",
    });
    bundle.presentations.push({
      id: "ghost-box",
      boardId: s.homeId,
      objectId: "ghost-1",
      parentId: null,
      x: 1,
      y: 2,
      width: 40,
      height: 30,
      z: 1,
      locked: false,
      appearance: {},
      version: 1,
      updatedAt: 11,
      updatedBy: "hui",
    });
    bundle.packs.push({
      id: "bad-pack",
      kind: "data",
      version: 1,
      enabled: true,
      manifest: { id: "bad-pack", format: "sand-table-pack" },
    });
    bundle.objects.push({
      id: "bad-obj",
      type: "bad-pack.item",
      typeVersion: 1,
      title: "坏包里的对象",
      data: { keep: true },
      source: null,
      version: 1,
      createdAt: 10,
      createdBy: "hui",
      updatedAt: 10,
      updatedBy: "hui",
    });
    const report = importWorkspaceBundle(
      s.root,
      freshRegistry(),
      JSON.stringify(bundle),
    );
    assert.ok(
      report.degraded.some(
        (item) => item.kind === "unknown-type" && item.id === "ghost-1",
      ),
    );
    assert.ok(
      report.degraded.some(
        (item) => item.kind === "invalid-pack" && item.id === "bad-pack",
      ),
    );
    assert.doesNotMatch(JSON.stringify(report), /跳过/);
    const reg = freshRegistry();
    const opened = openWorkspace(s.root, report.workspaceId, reg);
    try {
      const ghost = contentObjects(opened.db).find(
        (object) => object.id === "ghost-1",
      );
      assert.equal(ghost?.type, "ghost.card");
      assert.deepEqual(ghost?.data, { keep: 1, extra: "原样" });
      assert.equal(ghost?.version, 4);
      const kept = contentObjects(opened.db).find(
        (object) => object.id === "bad-obj",
      );
      assert.deepEqual(kept?.data, { keep: true });
      assert.equal(
        packsOf(opened.db).some((pack) => pack.id === "bad-pack"),
        false,
        "无效包没有注册",
      );
      assert.equal(reg.getPack("bad-pack"), undefined);
      const isolation = JSON.parse(
        readFileSync(
          join(s.root, report.workspaceId, IMPORT_REPORT_FILENAME),
          "utf8",
        ),
      ) as { invalidPacks: { id: string; manifest: { id?: string } }[] };
      assert.equal(isolation.invalidPacks[0]?.manifest.id, "bad-pack");
    } finally {
      opened.db.close();
    }
    const carriedDb = openWorkspace(
      s.root,
      report.workspaceId,
      freshRegistry(),
    );
    let again: { json: string };
    try {
      again = exportWorkspaceBundle(carriedDb.db);
    } finally {
      carriedDb.db.close();
    }
    const carried = JSON.parse(again.json) as {
      isolation?: {
        invalidPacks: { id: string; manifest: { format?: string } }[];
      };
      objects: { id: string }[];
    };
    assert.equal(carried.isolation?.invalidPacks[0]?.id, "bad-pack");
    assert.equal(
      carried.isolation?.invalidPacks[0]?.manifest.format,
      "sand-table-pack",
    );
    assert.ok(carried.objects.some((object) => object.id === "bad-obj"));
    const round = importWorkspaceBundle(s.root, freshRegistry(), again.json);
    const file = JSON.parse(
      readFileSync(
        join(s.root, round.workspaceId, IMPORT_REPORT_FILENAME),
        "utf8",
      ),
    ) as { invalidPacks: { manifest: { id?: string } }[] };
    assert.equal(
      file.invalidPacks.some((pack) => pack.manifest.id === "bad-pack"),
      true,
    );
    const restored = openWorkspace(s.root, round.workspaceId, freshRegistry());
    try {
      assert.ok(
        contentObjects(restored.db).some((object) => object.id === "bad-obj"),
      );
      assert.equal(
        packsOf(restored.db).some((pack) => pack.id === "bad-pack"),
        false,
      );
    } finally {
      restored.db.close();
    }
  } finally {
    s.close();
  }
});

test("v2 工作空间文件走 importV2", () => {
  const root = mkdtempSync(join(tmpdir(), "sand-bundle-v2-"));
  try {
    const json = readFileSync(join(FIXTURES, "unknown-type.json"), "utf8");
    const report = importWorkspaceBundle(root, freshRegistry(), json);
    assert.equal(report.workspaceId, "unknown-type-workspace");
    assert.equal(report.title, "未知类型（导入）");
    const opened = openWorkspace(root, report.workspaceId, freshRegistry());
    try {
      const foo = contentObjects(opened.db).find(
        (object) => object.id === "obj-foo",
      );
      assert.equal(foo?.type, "legacy.foo");
      assert.equal(foo?.data.whatever, "原样");
      assert.equal(foo?.data.count, 0);
    } finally {
      opened.db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("附件超过上限时导出失败，并列出附件；摘要对不上也不导出", () => {
  const s = scene();
  try {
    assert.throws(
      () => exportWorkspaceBundle(s.db, { maxBlobBytes: 8 }),
      (error: unknown) => {
        assert.ok(error instanceof CommandError);
        assert.equal(error.code, "LIMIT");
        assert.match(error.message, /附件/);
        assert.match(error.message, new RegExp(mediaSha));
        return true;
      },
    );
    const file = join(s.root, s.id, "blobs", mediaSha);
    const original = readFileSync(file);
    writeFileSync(file, Buffer.from("tampered"));
    assert.throws(
      () => exportWorkspaceBundle(s.db),
      (error: unknown) => {
        assert.ok(error instanceof CommandError);
        assert.match(error.message, /对不上/);
        assert.match(error.message, new RegExp(mediaSha));
        return true;
      },
    );
    writeFileSync(file, original);
    const bad = JSON.parse(exportWorkspaceBundle(s.db).json) as {
      blobs: { sha256: string; base64: string; bytes: number }[];
    };
    const blob = bad.blobs.find((item) => item.sha256 === mediaSha);
    assert.ok(blob);
    blob.base64 = Buffer.from("nope").toString("base64");
    blob.bytes = 4;
    const before = dirs(s.root);
    assert.throws(
      () => importWorkspaceBundle(s.root, freshRegistry(), JSON.stringify(bad)),
      /对不上/,
    );
    assert.deepEqual(dirs(s.root), before);
  } finally {
    s.close();
  }
});

test("路径穿越的工作空间编号不会写到根目录外面", () => {
  const s = scene();
  try {
    const bundle = JSON.parse(exportWorkspaceBundle(s.db).json) as {
      workspace: { id: string };
    };
    bundle.workspace.id = "../escape";
    const parent = join(s.root, "..");
    const before = existsSync(join(parent, "escape"));
    const report = importWorkspaceBundle(
      s.root,
      freshRegistry(),
      JSON.stringify(bundle),
    );
    assert.equal(report.workspaceId.includes(".."), false);
    assert.equal(report.workspaceId.includes("/"), false);
    assert.ok(existsSync(join(s.root, report.workspaceId, "workspace.db")));
    assert.equal(existsSync(join(parent, "escape")), before);
  } finally {
    s.close();
  }
});

test("JSON 超过上限时不建目录", () => {
  const root = mkdtempSync(join(tmpdir(), "sand-bundle-size-"));
  try {
    writeFileSync(join(root, "keep.txt"), "stay");
    assert.throws(
      () =>
        importWorkspaceBundle(root, freshRegistry(), '{"format":"x"}', {
          maxJsonBytes: 4,
        }),
      /300 MiB|超过/,
    );
    assert.deepEqual(readdirSync(root).sort(), ["keep.txt"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
