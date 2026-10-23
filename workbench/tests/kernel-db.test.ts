import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "../kernel/schema.ts";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CommandError,
  WorkspaceOpenError,
  getMeta,
  setMeta,
  newId,
  openWorkspaceDb,
  toObjectRow,
  toPresentationRow,
  toRelationRow,
  transaction,
  type Db,
} from "../kernel/index.ts";

const REQUIRED_META = [
  "schema_version",
  "workspace_id",
  "title",
  "created_at",
  "home_board_id",
  "revision",
  "history_cursor",
  "tombstone_floor",
];

function tempDir() {
  return mkdtempSync(join(tmpdir(), "sand-kernel-db-"));
}

function remove(dir: string) {
  rmSync(dir, { recursive: true, force: true });
}

test("新建库写入全部 meta，并有首页白板", () => {
  const dir = tempDir();
  const file = join(dir, "workspace.db");
  const now = 1_700_000_000_000;
  const db = openWorkspaceDb(file, {
    create: true,
    workspaceId: "demo",
    now: () => now,
  });
  try {
    const meta = Object.fromEntries(
      (
        db.prepare("SELECT key, value FROM meta").all() as {
          key: string;
          value: string;
        }[]
      ).map((row) => [row.key, row.value]),
    );
    for (const key of REQUIRED_META) assert.ok(key in meta, key);
    assert.equal(meta.schema_version, "2");
    for (const table of ["settings", "packs"])
      assert.ok(
        db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .some((r) => r.name === "deleted_rev"),
      );
    assert.equal(meta.workspace_id, "demo");
    assert.equal(meta.title, "未命名工作空间");
    assert.equal(meta.created_at, String(now));
    assert.equal(meta.revision, "0");
    assert.equal(meta.history_cursor, "");
    assert.equal(meta.tombstone_floor, "0");
    assert.equal("imported_from" in meta, false);
    const home = db
      .prepare("SELECT * FROM objects WHERE id = ?")
      .get(meta.home_board_id) as Record<string, unknown>;
    assert.equal(home.type, "base.board");
    assert.equal(home.title, "首页");
    assert.equal(home.data, "{}");
    assert.equal(home.created_by, "system");
    assert.equal(home.updated_by, "system");
    assert.equal(home.rev, 0);
    assert.equal(home.created_at, now);
  } finally {
    db.close();
    remove(dir);
  }
});

test("重新打开后首页白板和修订号不变", () => {
  const dir = tempDir();
  const file = join(dir, "workspace.db");
  const created = openWorkspaceDb(file, {
    create: true,
    workspaceId: "demo",
  });
  const home = getMeta(created, "home_board_id");
  const revision = getMeta(created, "revision");
  created.close();
  const again = openWorkspaceDb(file, { create: false });
  try {
    assert.equal(getMeta(again, "home_board_id"), home);
    assert.equal(getMeta(again, "revision"), revision);
    assert.equal(revision, "0");
  } finally {
    again.close();
    remove(dir);
  }
});

test("非 SQLite 文件被拒绝且内容不变", () => {
  const dir = tempDir();
  const file = join(dir, "notes.txt");
  writeFileSync(file, "hello");
  try {
    assert.throws(
      () => openWorkspaceDb(file, { create: false }),
      (error: unknown) =>
        error instanceof WorkspaceOpenError && error.code === "NOT_SQLITE",
    );
    assert.equal(readFileSync(file, "utf8"), "hello");
  } finally {
    remove(dir);
  }
});

test("高于当前程序的 schema 版本被拒绝", () => {
  const dir = tempDir();
  const file = join(dir, "workspace.db");
  const db = openWorkspaceDb(file, { create: true, workspaceId: "demo" });
  db.prepare("UPDATE meta SET value = '99' WHERE key = 'schema_version'").run();
  db.close();
  try {
    assert.throws(
      () => openWorkspaceDb(file, { create: false }),
      (error: unknown) =>
        error instanceof WorkspaceOpenError && error.code === "TOO_NEW",
    );
  } finally {
    remove(dir);
  }
});

test("不允许创建时，缺少的文件不会被建出来", () => {
  const dir = tempDir();
  const file = join(dir, "missing.db");
  try {
    assert.throws(
      () => openWorkspaceDb(file, { create: false }),
      (error: unknown) =>
        error instanceof WorkspaceOpenError && error.code === "MISSING",
    );
    assert.equal(existsSync(file), false);
  } finally {
    remove(dir);
  }
});

test("外键拒绝不存在的对象展示", () => {
  const dir = tempDir();
  const file = join(dir, "workspace.db");
  const db = openWorkspaceDb(file, { create: true, workspaceId: "demo" });
  try {
    const home = getMeta(db, "home_board_id");
    assert.ok(home);
    assert.throws(() =>
      db
        .prepare(
          `INSERT INTO presentations (
             id, board_id, object_id, x, y, width, height, updated_at, updated_by, rev
           ) VALUES (?, ?, 'missing-object', 0, 0, 120, 80, 0, 'human', 0)`,
        )
        .run(newId(), home),
    );
  } finally {
    db.close();
    remove(dir);
  }
});

test("非法 JSON 不能写入对象", () => {
  const dir = tempDir();
  const file = join(dir, "workspace.db");
  const db = openWorkspaceDb(file, { create: true, workspaceId: "demo" });
  try {
    assert.throws(() =>
      db
        .prepare(
          `INSERT INTO objects (
             id, type, data, created_at, created_by, updated_at, updated_by, rev
           ) VALUES (?, 'base.note', 'not json', 0, 'human', 0, 'human', 0)`,
        )
        .run(newId()),
    );
  } finally {
    db.close();
    remove(dir);
  }
});

test("事务失败会回滚，且不能嵌套", () => {
  const dir = tempDir();
  const file = join(dir, "workspace.db");
  const db = openWorkspaceDb(file, { create: true, workspaceId: "demo" });
  const id = newId();
  try {
    assert.throws(() =>
      transaction(db, () => {
        db.prepare(
          `INSERT INTO objects (
             id, type, title, data, created_at, created_by, updated_at, updated_by, rev
           ) VALUES (?, 'base.note', '临时', '{}', 0, 'human', 0, 'human', 0)`,
        ).run(id);
        throw new Error("boom");
      }),
    );
    assert.equal(
      db.prepare("SELECT id FROM objects WHERE id = ?").get(id),
      undefined,
    );
    assert.throws(
      () => transaction(db, () => transaction(db, () => undefined)),
      /不能在事务里再开启事务/,
    );
  } finally {
    db.close();
    remove(dir);
  }
});

test("另一个连接能读到已提交的写入", () => {
  const dir = tempDir();
  const file = join(dir, "workspace.db");
  const writer = openWorkspaceDb(file, { create: true, workspaceId: "demo" });
  const reader = openWorkspaceDb(file, { create: false });
  const id = newId();
  try {
    transaction(writer, () => {
      writer
        .prepare(
          `INSERT INTO objects (
             id, type, title, data, created_at, created_by, updated_at, updated_by, rev
           ) VALUES (?, 'base.note', '共享', '{}', 0, 'human', 0, 'human', 0)`,
        )
        .run(id);
    });
    const seen = reader
      .prepare("SELECT title FROM objects WHERE id = ?")
      .get(id) as { title: string } | undefined;
    assert.equal(seen?.title, "共享");
  } finally {
    writer.close();
    reader.close();
    remove(dir);
  }
});

test("行映射解析 JSON、布尔值和删除标记", () => {
  const dir = tempDir();
  const file = join(dir, "workspace.db");
  const db = openWorkspaceDb(file, { create: true, workspaceId: "demo" });
  try {
    const home = getMeta(db, "home_board_id")!;
    const objectId = newId();
    const presentationId = newId();
    const relationTarget = newId();
    const relationId = newId();
    db.prepare(
      `INSERT INTO objects (
         id, type, type_version, title, data, source, version,
         created_at, created_by, updated_at, updated_by, rev, deleted_rev
       ) VALUES (?, 'base.note', 2, '便签', '{"body":"hi"}', '{"origin":"human"}', 3, 11, 'human', 12, 'agent', 4, NULL)`,
    ).run(objectId);
    db.prepare(
      `INSERT INTO objects (
         id, type, title, data, created_at, created_by, updated_at, updated_by, rev
       ) VALUES (?, 'base.note', '另一张', '{}', 11, 'human', 12, 'human', 4)`,
    ).run(relationTarget);
    db.prepare(
      `INSERT INTO presentations (
         id, board_id, object_id, parent_id, x, y, width, height, z, locked,
         appearance, version, updated_at, updated_by, rev, deleted_rev
       ) VALUES (?, ?, ?, NULL, 10.5, 20, 240, 160, 3, 1, '{"detail":"label","accent":"#abc"}', 5, 13, 'human', 6, 6)`,
    ).run(presentationId, home, objectId);
    db.prepare(
      `INSERT INTO relations (
         id, kind, source_id, target_id, status, basis, attributes, evidence,
         version, created_at, created_by, updated_at, updated_by, rev, deleted_rev
       ) VALUES (?, 'base.related', ?, ?, 'inferred', '并列出现', '{"note":"a"}', ?, 7, 14, 'human', 15, 'human', 8, NULL)`,
    ).run(
      relationId,
      objectId,
      relationTarget,
      JSON.stringify([{ kind: "url", uri: "https://example.test/a" }]),
    );
    const object = toObjectRow(row(db, "objects", objectId));
    assert.equal(object.typeVersion, 2);
    assert.deepEqual(object.data, { body: "hi" });
    assert.deepEqual(object.source, { origin: "human" });
    assert.equal(object.deleted, false);
    assert.equal(object.createdAt, 11);
    assert.equal(object.updatedBy, "agent");
    const deleted = toObjectRow({
      ...row(db, "objects", objectId),
      deleted_rev: 9,
    });
    assert.equal(deleted.deleted, true);
    const presentation = toPresentationRow(
      row(db, "presentations", presentationId),
    );
    assert.equal(presentation.boardId, home);
    assert.equal(presentation.parentId, null);
    assert.equal(presentation.x, 10.5);
    assert.equal(presentation.locked, true);
    assert.deepEqual(presentation.appearance, {
      detail: "label",
      accent: "#abc",
    });
    assert.equal(presentation.deleted, true);
    const unlocked = toPresentationRow({
      ...row(db, "presentations", presentationId),
      locked: 0,
      deleted_rev: null,
    });
    assert.equal(unlocked.locked, false);
    assert.equal(unlocked.deleted, false);
    const relation = toRelationRow(row(db, "relations", relationId));
    assert.equal(relation.status, "inferred");
    assert.equal(relation.basis, "并列出现");
    assert.deepEqual(relation.attributes, { note: "a" });
    assert.deepEqual(relation.evidence, [
      { kind: "url", uri: "https://example.test/a" },
    ]);
    assert.equal(relation.deleted, false);
    assert.throws(
      () =>
        toObjectRow({ ...row(db, "objects", objectId), id: "bad", data: "{" }),
      (error: unknown) =>
        error instanceof CommandError &&
        error.code === "INTERNAL" &&
        error.message.includes("objects") &&
        error.message.includes("bad"),
    );
  } finally {
    db.close();
    remove(dir);
  }
});

function row(db: Db, table: string, id: string) {
  return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Record<
    string,
    unknown
  >;
}

test("版本1升级保留设置和包，删除可通过墓碑同步", () => {
  const dir = tempDir(),
    file = join(dir, "workspace.db");
  const old = new DatabaseSync(file);
  old.exec(MIGRATIONS[0]);
  old.exec(
    `INSERT INTO meta VALUES ('schema_version','1'); INSERT INTO settings VALUES ('theme','"paper"',4); INSERT INTO packs VALUES ('reading-kit','data',1,1,'{}',4);`,
  );
  old.close();
  const db = openWorkspaceDb(file, { create: false });
  try {
    assert.equal(getMeta(db, "schema_version"), "2");
    assert.equal(
      db.prepare("SELECT value FROM settings").get()?.value,
      '"paper"',
    );
    for (const table of ["settings", "packs"]) {
      db.exec(`UPDATE ${table} SET rev=5, deleted_rev=5`);
      assert.equal(
        db.prepare(`SELECT deleted_rev FROM ${table} WHERE rev>4`).get()
          ?.deleted_rev,
        5,
      );
    }
  } finally {
    db.close();
    remove(dir);
  }
});

test("锁冲突后同一连接可以重试事务", () => {
  const dir = tempDir();
  const file = join(dir, "workspace.db");
  const writer = openWorkspaceDb(file, { create: true, workspaceId: "demo" });
  const contender = openWorkspaceDb(file, { create: false });
  contender.exec("PRAGMA busy_timeout = 1");
  let called = false;
  try {
    writer.exec("BEGIN IMMEDIATE");
    assert.throws(
      () =>
        transaction(contender, () => {
          called = true;
        }),
      /locked/,
    );
    assert.equal(called, false);
    writer.exec("ROLLBACK");
    transaction(contender, () => setMeta(contender, "title", "重试成功"));
    assert.equal(getMeta(writer, "title"), "重试成功");
    assert.throws(
      () =>
        transaction(contender, () => {
          throw Error("原始错误");
        }),
      /原始错误/,
    );
    transaction(contender, () => setMeta(contender, "title", "再次成功"));
    assert.equal(getMeta(writer, "title"), "再次成功");
  } finally {
    writer.close();
    contender.close();
    remove(dir);
  }
});
