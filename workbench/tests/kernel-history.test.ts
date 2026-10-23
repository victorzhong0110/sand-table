import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  applyCommands,
  CommandError,
  createRegistry,
  getMeta,
  historyList,
  jump,
  openWorkspaceDb,
  pruneHistory,
  redo,
  transaction,
  undo,
  type Actor,
  type Db,
  type Registry,
} from "../kernel/index.ts";

const actor: Actor = { id: "hui", kind: "human" };

function manifest() {
  return {
    format: "sand-table-pack",
    formatVersion: 2,
    id: "demo",
    title: "演示",
    version: 1,
    types: [
      {
        type: "demo.board",
        title: "白板",
        description: "一块白板",
        icon: "board",
        version: 1,
        schema: { type: "object", additionalProperties: false, properties: {} },
        capabilities: { container: true },
        display: {
          material: "container",
          defaultSize: { width: 800, height: 600 },
        },
      },
      {
        type: "demo.card",
        title: "卡片",
        description: "一张卡片",
        icon: "note",
        version: 1,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            age: { type: "integer", minimum: 0 },
          },
        },
        display: {
          material: "paper",
          defaultSize: { width: 200, height: 120 },
        },
      },
    ],
    relationKinds: [
      {
        kind: "demo.link",
        title: "关联",
        inverseTitle: "被关联",
        allowsInferred: true,
      },
    ],
  };
}

type Scene = {
  db: Db;
  registry: Registry;
  boardId: string;
  close: () => void;
};

function scene(): Scene {
  const dir = mkdtempSync(join(tmpdir(), "sand-history-"));
  const db = openWorkspaceDb(join(dir, "workspace.db"), {
    create: true,
    workspaceId: "demo",
  });
  const registry = createRegistry();
  const close = () => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    applyCommands(db, registry, {
      actor,
      intentId: "setup-pack",
      commands: [{ op: "pack.import", manifest: manifest() }],
    });
    const board = applyCommands(db, registry, {
      actor,
      intentId: "setup-board",
      commands: [
        { op: "object.create", type: "demo.board", title: "主白板", data: {} },
      ],
    });
    return { db, registry, boardId: board.created["0"]!, close };
  } catch (error) {
    close();
    throw error;
  }
}

function revision(db: Db) {
  return Number(getMeta(db, "revision"));
}

function titleOf(db: Db, id: string) {
  const row = db.prepare("SELECT title FROM objects WHERE id = ?").get(id) as {
    title: string;
  };
  return row.title;
}

function countOf(db: Db, table: "history" | "audit", action?: string) {
  const row = action
    ? (db
        .prepare("SELECT COUNT(*) AS n FROM audit WHERE action = ?")
        .get(action) as { n: number })
    : (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number });
  return Number(row.n);
}

function deletedRev(
  db: Db,
  table: "objects" | "presentations" | "relations",
  id: string,
) {
  const row = db
    .prepare(`SELECT deleted_rev FROM ${table} WHERE id = ?`)
    .get(id) as { deleted_rev: number | null };
  return row.deleted_rev;
}

function beforeTitle(db: Db, historyId: string, objectId: string) {
  const row = db
    .prepare("SELECT changes FROM history WHERE id = ?")
    .get(historyId) as { changes: string };
  const changes = JSON.parse(row.changes) as {
    table: string;
    id: string;
    before: { title?: string } | null;
  }[];
  const change = changes.find(
    (item) => item.table === "objects" && item.id === objectId,
  );
  assert.ok(change?.before && typeof change.before.title === "string");
  return change.before.title;
}

test("连续撤销 30 次再重做 30 次，每一步都对上当时的内容", () => {
  const { db, registry, close } = scene();
  try {
    const created = applyCommands(db, registry, {
      actor,
      intentId: "create-card",
      commands: [
        {
          op: "object.create",
          type: "demo.card",
          title: "n-0",
          data: { age: 1 },
        },
      ],
    });
    const cardId = created.created["0"]!;
    for (let step = 1; step <= 30; step += 1) {
      applyCommands(db, registry, {
        actor,
        intentId: `edit-${step}`,
        commands: [{ op: "object.update", id: cardId, title: `n-${step}` }],
      });
    }
    assert.equal(titleOf(db, cardId), "n-30");
    for (let step = 1; step <= 30; step += 1) {
      const historyId = getMeta(db, "history_cursor");
      assert.ok(historyId);
      const expected = beforeTitle(db, historyId, cardId);
      undo(db, actor);
      const title = titleOf(db, cardId);
      assert.equal(title, expected);
      assert.equal(title, `n-${30 - step}`);
    }
    for (let step = 1; step <= 30; step += 1) {
      redo(db, actor);
      assert.equal(titleOf(db, cardId), `n-${step}`);
    }
  } finally {
    close();
  }
});

test("撤销后新编辑产生分支，旧路径仍可跳回", () => {
  const { db, registry, close } = scene();
  try {
    const created = applyCommands(db, registry, {
      actor,
      intentId: "create-card",
      commands: [
        {
          op: "object.create",
          type: "demo.card",
          title: "初稿",
          data: { age: 1 },
        },
      ],
    });
    const cardId = created.created["0"]!;
    for (const [intentId, title] of [
      ["step-1", "第一步"],
      ["step-2", "第二步"],
      ["step-3", "第三步"],
    ] as const) {
      applyCommands(db, registry, {
        actor,
        intentId,
        commands: [{ op: "object.update", id: cardId, title }],
      });
    }
    const tipId = getMeta(db, "history_cursor");
    assert.ok(tipId);
    const secondId = undo(db, actor).cursorId;
    assert.ok(secondId);
    const first = undo(db, actor);
    assert.equal(titleOf(db, cardId), "第一步");
    const branched = applyCommands(db, registry, {
      actor,
      intentId: "branch",
      commands: [{ op: "object.update", id: cardId, title: "分支" }],
    });
    const parent = db
      .prepare("SELECT parent_id FROM history WHERE id = ?")
      .get(branched.historyId) as { parent_id: string | null };
    assert.equal(parent.parent_id, first.cursorId);
    const list = historyList(db, 100);
    const byId = new Map(list.entries.map((entry) => [entry.id, entry]));
    assert.equal(byId.get(tipId)?.onCurrentPath, false);
    assert.equal(byId.get(secondId)?.onCurrentPath, false);
    assert.equal(byId.get(branched.historyId!)?.current, true);
    const jumped = jump(db, actor, tipId);
    assert.equal(jumped.cursorId, tipId);
    assert.equal(titleOf(db, cardId), "第三步");
  } finally {
    close();
  }
});

test("撤销删除会恢复对象、展示和关系，重做再删掉", () => {
  const { db, registry, boardId, close } = scene();
  try {
    const made = applyCommands(db, registry, {
      actor,
      intentId: "make",
      commands: [
        {
          op: "object.create",
          ref: "card",
          type: "demo.card",
          title: "要删的",
          data: { age: 1 },
        },
        {
          op: "object.create",
          ref: "other",
          type: "demo.card",
          title: "留下的",
          data: { age: 2 },
        },
        {
          op: "presentation.create",
          ref: "placed",
          boardId,
          objectId: "@card",
          x: 10,
          y: 20,
          width: 80,
          height: 40,
        },
        {
          op: "relation.create",
          ref: "link",
          kind: "demo.link",
          sourceId: "@card",
          targetId: "@other",
        },
      ],
    });
    const cardId = made.created.card!;
    const presentationId = made.created.placed!;
    const relationId = made.created.link!;
    applyCommands(db, registry, {
      actor,
      intentId: "remove",
      commands: [{ op: "object.delete", id: cardId }],
    });
    assert.ok(deletedRev(db, "objects", cardId) != null);
    assert.ok(deletedRev(db, "presentations", presentationId) != null);
    assert.ok(deletedRev(db, "relations", relationId) != null);
    undo(db, actor);
    assert.equal(deletedRev(db, "objects", cardId), null);
    assert.equal(deletedRev(db, "presentations", presentationId), null);
    assert.equal(deletedRev(db, "relations", relationId), null);
    assert.equal(titleOf(db, cardId), "要删的");
    redo(db, actor);
    assert.ok(deletedRev(db, "objects", cardId) != null);
    assert.ok(deletedRev(db, "presentations", presentationId) != null);
    assert.ok(deletedRev(db, "relations", relationId) != null);
  } finally {
    close();
  }
});

test("内容已被改过时撤销冲突，数据库保持原样", () => {
  const { db, registry, close } = scene();
  try {
    const created = applyCommands(db, registry, {
      actor,
      intentId: "create-card",
      commands: [
        {
          op: "object.create",
          type: "demo.card",
          title: "原稿",
          data: { age: 1 },
        },
      ],
    });
    const cardId = created.created["0"]!;
    applyCommands(db, registry, {
      actor,
      intentId: "recorded",
      commands: [{ op: "object.update", id: cardId, title: "已记录" }],
    });
    applyCommands(db, registry, {
      actor,
      record: false,
      commands: [{ op: "object.update", id: cardId, title: "被改过" }],
    });
    const before = db
      .prepare(
        "SELECT title, version, rev, deleted_rev FROM objects WHERE id = ?",
      )
      .get(cardId) as {
      title: string;
      version: number;
      rev: number;
      deleted_rev: number | null;
    };
    const mark = {
      revision: getMeta(db, "revision"),
      cursor: getMeta(db, "history_cursor"),
      history: countOf(db, "history"),
      audit: countOf(db, "audit"),
      ...before,
    };
    assert.throws(
      () => undo(db, actor),
      (error: unknown) => {
        assert.ok(error instanceof CommandError);
        assert.equal(error.code, "HISTORY_CONFLICT");
        const ids = error.details?.ids;
        assert.ok(Array.isArray(ids) && ids.includes(cardId));
        return true;
      },
    );
    const after = db
      .prepare(
        "SELECT title, version, rev, deleted_rev FROM objects WHERE id = ?",
      )
      .get(cardId) as typeof before;
    assert.deepEqual(
      {
        revision: getMeta(db, "revision"),
        cursor: getMeta(db, "history_cursor"),
        history: countOf(db, "history"),
        audit: countOf(db, "audit"),
        ...after,
      },
      mark,
    );
  } finally {
    close();
  }
});

test("撤销、重做、跳转不增加历史，但各写一条审计", () => {
  const { db, registry, close } = scene();
  try {
    const created = applyCommands(db, registry, {
      actor,
      intentId: "create-card",
      commands: [
        {
          op: "object.create",
          type: "demo.card",
          title: "起点",
          data: { age: 1 },
        },
      ],
    });
    const cardId = created.created["0"]!;
    applyCommands(db, registry, {
      actor,
      intentId: "a",
      commands: [{ op: "object.update", id: cardId, title: "甲" }],
    });
    applyCommands(db, registry, {
      actor,
      intentId: "b",
      commands: [{ op: "object.update", id: cardId, title: "乙" }],
    });
    const history = countOf(db, "history");
    const middle = undo(db, actor).cursorId;
    assert.ok(middle);
    assert.equal(countOf(db, "history"), history);
    assert.equal(countOf(db, "audit", "undo"), 1);
    redo(db, actor);
    assert.equal(countOf(db, "history"), history);
    assert.equal(countOf(db, "audit", "redo"), 1);
    jump(db, actor, middle);
    assert.equal(countOf(db, "history"), history);
    assert.equal(countOf(db, "audit", "jump"), 1);
    assert.equal(titleOf(db, cardId), "甲");
  } finally {
    close();
  }
});

test("历史超过 2000 条、审计超过 20000 条时裁到上限，游标还在", () => {
  const { db, registry, close } = scene();
  try {
    const created = applyCommands(db, registry, {
      actor,
      intentId: "create-card",
      commands: [
        {
          op: "object.create",
          type: "demo.card",
          title: "容量",
          data: { age: 1 },
        },
      ],
    });
    const cardId = created.created["0"]!;
    const oldest = db
      .prepare("SELECT id FROM history ORDER BY seq ASC LIMIT 1")
      .get() as { id: string };
    for (let step = 1; step <= 2050; step += 1) {
      applyCommands(db, registry, {
        actor,
        intentId: `bulk-${step}`,
        commands: [{ op: "object.update", id: cardId, title: `b-${step}` }],
      });
    }
    const cursor = getMeta(db, "history_cursor");
    assert.ok(cursor);
    assert.equal(countOf(db, "history"), 2000);
    assert.equal(
      db.prepare("SELECT id FROM history WHERE id = ?").get(oldest.id),
      undefined,
    );
    assert.ok(db.prepare("SELECT id FROM history WHERE id = ?").get(cursor));
    transaction(db, () => {
      const insert = db.prepare(
        "INSERT INTO audit (at, actor, actor_kind, action) VALUES (?, ?, 'human', 'note')",
      );
      for (let step = 0; step < 20_000; step += 1)
        insert.run(1_700_000_000_000 + step, actor.id);
    });
    assert.ok(countOf(db, "audit") > 20_000);
    pruneHistory(db);
    assert.equal(countOf(db, "audit"), 20_000);
  } finally {
    close();
  }
});

test("游标为空时撤销、没有子记录时重做，都不报错也不改修订号", () => {
  const dir = mkdtempSync(join(tmpdir(), "sand-history-empty-"));
  const db = openWorkspaceDb(join(dir, "workspace.db"), {
    create: true,
    workspaceId: "empty",
  });
  try {
    const rev = revision(db);
    const undone = undo(db, actor);
    assert.equal(undone.revision, rev);
    assert.equal(undone.cursorId, null);
    const redone = redo(db, actor);
    assert.equal(redone.revision, rev);
    assert.equal(redone.cursorId, null);
    assert.equal(countOf(db, "audit"), 0);
    assert.equal(revision(db), rev);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }

  const { db: lined, close } = scene();
  try {
    const rev = revision(lined);
    const cursor = getMeta(lined, "history_cursor");
    const redone = redo(lined, actor);
    assert.equal(redone.revision, rev);
    assert.equal(redone.cursorId, cursor);
    assert.equal(countOf(lined, "audit", "redo"), 0);
    assert.equal(revision(lined), rev);
  } finally {
    close();
  }
});
