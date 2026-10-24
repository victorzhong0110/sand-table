import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  applyCommands,
  applySystemCommands,
  CommandError,
  createRegistry,
  getMeta,
  isPackEnabled,
  openWorkspaceDb,
  parsePublicCommands,
  syncPacks,
  type Actor,
  type Command,
  type Db,
  type Registry,
} from "../kernel/index.ts";

const actor: Actor = { id: "hui", kind: "human" };

function demoManifest() {
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
            age: {
              type: "integer",
              minimum: 0,
              "x-sand-label": "年龄",
              "x-sand-widget": "integer",
            },
            label: {
              type: "string",
              "x-sand-label": "文字",
              "x-sand-widget": "text",
            },
          },
        },
        display: {
          material: "paper",
          defaultSize: { width: 200, height: 120 },
          summary: ["label"],
        },
      },
    ],
    relationKinds: [
      {
        kind: "demo.proves",
        title: "证明",
        inverseTitle: "依据",
        allowsInferred: true,
        requiresBasis: true,
      },
      {
        kind: "demo.guess",
        title: "猜测",
        inverseTitle: "被猜测",
        allowsInferred: false,
      },
      {
        kind: "demo.hint",
        title: "提示",
        inverseTitle: "被提示",
        allowsInferred: true,
      },
      {
        kind: "demo.typed",
        title: "同类",
        inverseTitle: "同类",
        allowsInferred: true,
        sourceTypes: ["demo.card"],
        targetTypes: ["demo.card"],
      },
    ],
    templates: [
      {
        id: "demo.drop",
        title: "放下",
        commands: [
          {
            op: "object.create",
            ref: "item",
            type: "demo.card",
            title: "模板卡片",
            data: { age: 1, label: "来自模板" },
          },
          {
            op: "presentation.create",
            boardId: "$board",
            objectId: "@item",
            x: 5,
            y: 7,
            width: 80,
            height: 40,
          },
        ],
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
  const dir = mkdtempSync(join(tmpdir(), "sand-commands-"));
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
      commands: [{ op: "pack.import", manifest: demoManifest() }],
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

function card(
  title = "卡片",
  data: Record<string, unknown> = { age: 1, label: title },
): Extract<Command, { op: "object.create" }> {
  return { op: "object.create", type: "demo.card", title, data };
}

function expectError(
  fn: () => void,
  code: CommandError["code"],
  commandIndex?: number | null,
) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof CommandError);
    assert.equal(error.code, code);
    if (commandIndex !== undefined)
      assert.equal(error.commandIndex, commandIndex);
    return error;
  }
  assert.fail("应该抛错");
}

function revision(db: Db) {
  return Number(getMeta(db, "revision"));
}

function history(db: Db) {
  return db.prepare("SELECT * FROM history ORDER BY seq").all() as {
    id: string;
    parent_id: string | null;
    label: string;
    kind: string;
    actor: string;
    changes: string;
    bytes: number;
  }[];
}

function audits(db: Db) {
  return db.prepare("SELECT * FROM audit ORDER BY seq").all() as {
    action: string;
    history_id: string | null;
    detail: string;
  }[];
}

function objectOf(db: Db, id: string) {
  return db.prepare("SELECT * FROM objects WHERE id = ?").get(id) as
    Record<string, unknown> | undefined;
}

test("每种命令都能写入，并读回结果", () => {
  const { db, registry, boardId, close } = scene();
  try {
    const created = applyCommands(db, registry, {
      actor,
      label: "自定义",
      commands: [card("甲", { age: 3, label: "原文" })],
    });
    const id = created.created["0"]!;
    const row = objectOf(db, id)!;
    assert.equal(row.title, "甲");
    assert.equal(row.version, 1);
    assert.equal(JSON.parse(String(row.data)).age, 3);
    assert.equal(created.historyId, history(db).at(-1)?.id);
    assert.equal(history(db).at(-1)?.label, "自定义");

    const updated = applyCommands(db, registry, {
      actor,
      commands: [
        {
          op: "object.update",
          id,
          expectedVersion: 1,
          title: "甲改",
          set: { label: "新文字" },
        },
      ],
    });
    assert.equal(updated.changed[0]?.version, 2);
    assert.equal(objectOf(db, id)?.title, "甲改");
    assert.equal(JSON.parse(String(objectOf(db, id)?.data)).label, "新文字");

    const cloned = applyCommands(db, registry, {
      actor,
      commands: [{ op: "object.clone", id, ref: "copy" }],
    });
    const copyId = cloned.created.copy!;
    assert.notEqual(copyId, id);
    assert.equal(objectOf(db, copyId)?.title, "甲改");
    assert.equal(
      JSON.parse(String(objectOf(db, copyId)?.data)).label,
      "新文字",
    );
    assert.equal(
      Number(
        (
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM presentations WHERE object_id = ? AND deleted_rev IS NULL",
            )
            .get(copyId) as { n: number }
        ).n,
      ),
      0,
    );

    const other = applyCommands(db, registry, {
      actor,
      commands: [card("乙")],
    }).created["0"]!;
    const placed = applyCommands(db, registry, {
      actor,
      commands: [
        {
          op: "presentation.create",
          boardId,
          objectId: id,
          x: 10,
          y: 30,
          width: 200,
          height: 120,
        },
      ],
    });
    const presentationId = placed.created["0"]!;
    const presentation = db
      .prepare("SELECT * FROM presentations WHERE id = ?")
      .get(presentationId) as { x: number; y: number; width: number };
    assert.equal(presentation.x, 10);
    assert.equal(presentation.y, 30);
    const shifted = applyCommands(db, registry, {
      actor,
      commands: [{ op: "presentation.create", boardId, objectId: other }],
    }).created["0"]!;
    const second = db
      .prepare("SELECT x, y, width, height FROM presentations WHERE id = ?")
      .get(shifted) as { x: number; y: number; width: number; height: number };
    assert.equal(second.x, 250);
    assert.equal(second.y, 30);
    assert.equal(second.width, 200);
    assert.equal(second.height, 120);

    applyCommands(db, registry, {
      actor,
      commands: [
        { op: "presentation.update", id: presentationId, x: 12, locked: true },
      ],
    });
    assert.equal(
      (
        db
          .prepare("SELECT x, locked FROM presentations WHERE id = ?")
          .get(presentationId) as {
          x: number;
          locked: number;
        }
      ).locked,
      1,
    );

    const related = applyCommands(db, registry, {
      actor,
      commands: [
        {
          op: "relation.create",
          kind: "demo.proves",
          sourceId: id,
          targetId: other,
          basis: "原文这么写",
        },
      ],
    });
    const relationId = related.created["0"]!;
    applyCommands(db, registry, {
      actor,
      commands: [
        { op: "relation.update", id: relationId, basis: "改过的依据" },
      ],
    });
    assert.equal(
      (
        db
          .prepare("SELECT basis FROM relations WHERE id = ?")
          .get(relationId) as { basis: string }
      ).basis,
      "改过的依据",
    );

    applyCommands(db, registry, {
      actor,
      commands: [{ op: "setting.set", key: "theme", value: "paper" }],
    });
    assert.equal(
      JSON.parse(
        (
          db
            .prepare("SELECT value FROM settings WHERE key = 'theme'")
            .get() as { value: string }
        ).value,
      ),
      "paper",
    );

    applyCommands(db, registry, {
      actor,
      commands: [
        {
          op: "pack.import",
          manifest: {
            format: "sand-table-pack",
            formatVersion: 2,
            id: "extra",
            title: "附加",
            version: 1,
          },
        },
      ],
    });
    applyCommands(db, registry, {
      actor,
      commands: [{ op: "pack.disable", id: "extra" }],
    });
    assert.equal(isPackEnabled(db, "extra"), false);
    applyCommands(db, registry, {
      actor,
      commands: [{ op: "pack.enable", id: "extra" }],
    });
    assert.equal(isPackEnabled(db, "extra"), true);

    const dropped = applyCommands(db, registry, {
      actor,
      commands: [
        {
          op: "template.apply",
          templateId: "demo.drop",
          boardId,
          x: 100,
          y: 50,
        },
      ],
    });
    const templated = db
      .prepare(
        `SELECT presentations.x AS x, presentations.y AS y
         FROM presentations JOIN objects ON objects.id = presentations.object_id
         WHERE objects.title = '模板卡片' AND presentations.deleted_rev IS NULL`,
      )
      .get() as { x: number; y: number };
    assert.equal(templated.x, 105);
    assert.equal(templated.y, 57);
    assert.ok(dropped.created.item);

    applyCommands(db, registry, {
      actor,
      commands: [{ op: "relation.delete", id: relationId }],
    });
    assert.ok(
      (
        db
          .prepare("SELECT deleted_rev FROM relations WHERE id = ?")
          .get(relationId) as {
          deleted_rev: number;
        }
      ).deleted_rev,
    );
    applyCommands(db, registry, {
      actor,
      commands: [{ op: "presentation.delete", id: shifted }],
    });
    assert.ok(
      (
        db
          .prepare("SELECT deleted_rev FROM presentations WHERE id = ?")
          .get(shifted) as {
          deleted_rev: number;
        }
      ).deleted_rev,
    );
    applyCommands(db, registry, {
      actor,
      commands: [{ op: "object.delete", id: copyId }],
    });
    assert.ok(objectOf(db, copyId)?.deleted_rev);
    applyCommands(db, registry, {
      actor,
      commands: [{ op: "pack.remove", id: "extra" }],
    });
    const removed = db
      .prepare("SELECT * FROM packs WHERE id = 'extra'")
      .get() as {
      deleted_rev: number;
      rev: number;
    };
    assert.equal(removed.deleted_rev, removed.rev);
    assert.equal(removed.rev, revision(db));
    assert.equal(isPackEnabled(db, "extra"), false);
  } finally {
    close();
  }
});

test("同一批可以用引用串起对象、展示和关系", () => {
  const { db, registry, boardId, close } = scene();
  try {
    const result = applyCommands(db, registry, {
      actor,
      commands: [
        { ...card("甲"), ref: "a" },
        { ...card("乙"), ref: "b" },
        { op: "presentation.create", boardId, objectId: "@a" },
        {
          op: "relation.create",
          kind: "demo.proves",
          sourceId: "@a",
          targetId: "@b",
          basis: "因为",
        },
      ],
    });
    const presentation = db
      .prepare("SELECT object_id FROM presentations WHERE object_id = ?")
      .get(result.created.a) as { object_id: string };
    assert.equal(presentation.object_id, result.created.a);
    const relation = db
      .prepare("SELECT source_id, target_id FROM relations WHERE source_id = ?")
      .get(result.created.a) as { source_id: string; target_id: string };
    assert.equal(relation.target_id, result.created.b);
    const before = revision(db);
    expectError(
      () =>
        applyCommands(db, registry, {
          actor,
          commands: [
            { op: "presentation.create", boardId, objectId: "@missing" },
          ],
        }),
      "NOT_FOUND",
      0,
    );
    assert.equal(revision(db), before);
  } finally {
    close();
  }
});

test("正文里的 @alice 不会被当成引用", () => {
  const { db, registry, close } = scene();
  try {
    const result = applyCommands(db, registry, {
      actor,
      commands: [
        { ...card("爱丽丝"), ref: "alice" },
        card("正文", { age: 2, label: "@alice" }),
      ],
    });
    const body = objectOf(db, result.created["1"]!)!;
    assert.equal(JSON.parse(String(body.data)).label, "@alice");
    assert.notEqual(result.created.alice, "@alice");
  } finally {
    close();
  }
});

test("第 3 条失败时，前两条和修订号、历史、审计都不变", () => {
  const { db, registry, close } = scene();
  try {
    const beforeRev = revision(db);
    const beforeHistory = history(db).length;
    const beforeAudit = audits(db).length;
    expectError(
      () =>
        applyCommands(db, registry, {
          actor,
          commands: [
            card("一"),
            card("二"),
            { op: "object.create", type: "missing.nope" },
          ],
        }),
      "UNKNOWN_TYPE",
      2,
    );
    assert.equal(revision(db), beforeRev);
    assert.equal(history(db).length, beforeHistory);
    assert.equal(audits(db).length, beforeAudit);
    assert.equal(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM objects WHERE title IN ('一', '二')",
          )
          .get() as { n: number }
      ).n,
      0,
    );
  } finally {
    close();
  }
});

test("校验表里的每个错误码都带正确的 commandIndex", () => {
  const { db, registry, boardId, close } = scene();
  try {
    const made = applyCommands(db, registry, {
      actor,
      commands: [card("锁定")],
    }).created["0"]!;
    const presentationId = applyCommands(db, registry, {
      actor,
      commands: [{ op: "presentation.create", boardId, objectId: made }],
    }).created["0"]!;
    applyCommands(db, registry, {
      actor,
      commands: [
        { op: "presentation.update", id: presentationId, locked: true },
      ],
    });

    expectError(
      () =>
        applyCommands(db, registry, {
          actor,
          commands: [card("先"), { op: "object.create", type: "missing.type" }],
        }),
      "UNKNOWN_TYPE",
      1,
    );
    expectError(
      () =>
        applyCommands(db, registry, {
          actor,
          commands: [card("坏", { age: -1, label: "x" })],
        }),
      "INVALID_DATA",
      0,
    );
    const invalid = expectError(
      () =>
        applyCommands(db, registry, {
          actor,
          commands: [
            {
              op: "relation.create",
              kind: "demo.proves",
              sourceId: made,
              targetId: boardId,
            },
          ],
        }),
      "INVALID_DATA",
      0,
    );
    assert.equal(invalid.details?.path, "/basis");
    expectError(
      () =>
        applyCommands(db, registry, {
          actor,
          commands: [
            {
              op: "relation.create",
              kind: "demo.guess",
              sourceId: made,
              targetId: boardId,
              status: "inferred",
              basis: "有依据也不行",
            },
          ],
        }),
      "INVALID_DATA",
      0,
    );
    const confirmed = applyCommands(db, registry, {
      actor,
      commands: [
        {
          op: "relation.create",
          kind: "demo.guess",
          sourceId: made,
          targetId: boardId,
          basis: "先确认",
        },
      ],
    }).created["0"]!;
    expectError(
      () =>
        applyCommands(db, registry, {
          actor,
          commands: [
            { op: "relation.update", id: confirmed, status: "inferred" },
          ],
        }),
      "INVALID_DATA",
      0,
    );
    expectError(
      () =>
        applyCommands(db, registry, {
          actor,
          commands: [
            {
              op: "relation.create",
              kind: "demo.hint",
              sourceId: made,
              targetId: boardId,
              status: "inferred",
            },
          ],
        }),
      "INVALID_DATA",
      0,
    );
    expectError(
      () =>
        applyCommands(db, registry, {
          actor,
          commands: [
            {
              op: "relation.create",
              kind: "demo.typed",
              sourceId: boardId,
              targetId: made,
              basis: "类型不对",
            },
          ],
        }),
      "INVALID_DATA",
      0,
    );
    expectError(
      () => applyCommands(db, registry, { actor, commands: [] }),
      "LIMIT",
      null,
    );
    expectError(
      () =>
        applyCommands(db, registry, {
          actor,
          commands: Array.from({ length: 201 }, () => card("多")),
        }),
      "LIMIT",
      null,
    );
    expectError(
      () =>
        applyCommands(db, registry, {
          actor,
          commands: [card("长".repeat(301))],
        }),
      "LIMIT",
      0,
    );
    expectError(
      () =>
        applyCommands(db, registry, {
          actor,
          commands: [card("大", { age: 1, label: "x".repeat(1_100_000) })],
        }),
      "LIMIT",
      0,
    );
    const conflict = expectError(
      () =>
        applyCommands(db, registry, {
          actor,
          commands: [
            {
              op: "object.update",
              id: made,
              expectedVersion: 9,
              title: "冲突",
            },
          ],
        }),
      "VERSION_CONFLICT",
      0,
    );
    assert.equal(conflict.details?.version, 1);
    expectError(
      () =>
        applyCommands(db, registry, {
          actor,
          commands: [{ op: "object.update", id: "missing-id", title: "无" }],
        }),
      "NOT_FOUND",
      0,
    );
    expectError(
      () =>
        applyCommands(db, registry, {
          actor,
          commands: [
            { op: "presentation.create", boardId: made, objectId: boardId },
          ],
        }),
      "NOT_CONTAINER",
      0,
    );
    expectError(
      () =>
        applyCommands(db, registry, {
          actor,
          commands: [{ op: "presentation.update", id: presentationId, x: 80 }],
        }),
      "LOCKED",
      0,
    );
    expectError(
      () =>
        applyCommands(db, registry, {
          actor,
          commands: [
            {
              op: "presentation.update",
              id: presentationId,
              locked: false,
              x: 80,
            },
          ],
        }),
      "LOCKED",
      0,
    );
    applyCommands(db, registry, {
      actor,
      commands: [
        { op: "presentation.update", id: presentationId, locked: false },
        { op: "presentation.update", id: presentationId, x: 80 },
      ],
    });
    assert.equal(
      (
        db
          .prepare("SELECT x, locked FROM presentations WHERE id = ?")
          .get(presentationId) as { x: number; locked: number }
      ).x,
      80,
    );
    const base = createRegistry();
    base.registerPack({ id: "base", title: "基础", version: 1 }, "builtin");
    syncPacks(db, base, actor);
    expectError(
      () =>
        applyCommands(db, base, {
          actor,
          commands: [{ op: "pack.disable", id: "base" }],
        }),
      "FORBIDDEN",
      0,
    );
    expectError(
      () =>
        applyCommands(db, base, {
          actor,
          commands: [{ op: "pack.remove", id: "base" }],
        }),
      "FORBIDDEN",
      0,
    );
  } finally {
    close();
  }
});

test("旧数据的别的字段可以改，正在改的非法字段不行", () => {
  const { db, registry, close } = scene();
  try {
    const id = applyCommands(db, registry, {
      actor,
      commands: [card("旧", { age: 1, label: "原" })],
    }).created["0"]!;
    db.prepare("UPDATE objects SET data = ? WHERE id = ?").run(
      JSON.stringify({ age: -1, label: "原" }),
      id,
    );
    const warned = applyCommands(db, registry, {
      actor,
      commands: [{ op: "object.update", id, set: { label: "新" } }],
    });
    assert.ok(warned.warnings.length > 0);
    assert.equal(warned.warnings[0]?.path, "/age");
    const data = JSON.parse(String(objectOf(db, id)?.data));
    assert.equal(data.label, "新");
    assert.equal(data.age, -1);
    expectError(
      () =>
        applyCommands(db, registry, {
          actor,
          commands: [{ op: "object.update", id, set: { age: -3 } }],
        }),
      "INVALID_DATA",
      0,
    );
    assert.equal(JSON.parse(String(objectOf(db, id)?.data)).age, -1);

    applyCommands(db, registry, {
      actor,
      commands: [
        {
          op: "pack.import",
          manifest: {
            format: "sand-table-pack",
            formatVersion: 2,
            id: "strict",
            title: "严格",
            version: 1,
            types: [
              {
                type: "strict.item",
                title: "条目",
                description: "至少要有两个字段",
                icon: "note",
                version: 1,
                schema: {
                  type: "object",
                  additionalProperties: false,
                  minProperties: 2,
                  properties: {
                    label: { type: "string" },
                    note: { type: "string" },
                  },
                },
                display: {
                  material: "paper",
                  defaultSize: { width: 200, height: 80 },
                },
              },
            ],
          },
        },
      ],
    });
    const rootId = applyCommands(db, registry, {
      actor,
      commands: [
        {
          op: "object.create",
          type: "strict.item",
          title: "根",
          data: { label: "原", note: "备注" },
        },
      ],
    }).created["0"]!;
    db.prepare("UPDATE objects SET data = ? WHERE id = ?").run(
      JSON.stringify({ label: "原" }),
      rootId,
    );
    const rootWarned = applyCommands(db, registry, {
      actor,
      commands: [{ op: "object.update", id: rootId, set: { label: "新" } }],
    });
    assert.ok(rootWarned.warnings.length > 0);
    assert.equal(rootWarned.warnings[0]?.path, "");
    assert.equal(rootWarned.warnings[0]?.commandIndex, 0);
    assert.equal(JSON.parse(String(objectOf(db, rootId)?.data)).label, "新");
  } finally {
    close();
  }
});

test("删除对象会软删除它的展示和关系，并记在同一条历史", () => {
  const { db, registry, boardId, close } = scene();
  try {
    const before = revision(db);
    const id = applyCommands(db, registry, { actor, commands: [card("删")] })
      .created["0"]!;
    const other = applyCommands(db, registry, { actor, commands: [card("留")] })
      .created["0"]!;
    const presentationId = applyCommands(db, registry, {
      actor,
      commands: [{ op: "presentation.create", boardId, objectId: id }],
    }).created["0"]!;
    const relationId = applyCommands(db, registry, {
      actor,
      commands: [
        {
          op: "relation.create",
          kind: "demo.proves",
          sourceId: id,
          targetId: other,
          basis: "相关",
        },
      ],
    }).created["0"]!;
    const result = applyCommands(db, registry, {
      actor,
      commands: [{ op: "object.delete", id }],
    });
    assert.equal(revision(db), before + 5);
    assert.equal(objectOf(db, id)?.deleted_rev, revision(db));
    assert.equal(objectOf(db, id)?.rev, revision(db));
    assert.equal(
      (
        db
          .prepare("SELECT deleted_rev FROM presentations WHERE id = ?")
          .get(presentationId) as {
          deleted_rev: number;
        }
      ).deleted_rev,
      revision(db),
    );
    assert.equal(
      (
        db
          .prepare("SELECT deleted_rev FROM relations WHERE id = ?")
          .get(relationId) as {
          deleted_rev: number;
        }
      ).deleted_rev,
      revision(db),
    );
    assert.equal(objectOf(db, other)?.deleted_rev, null);
    const nestedBoard = applyCommands(db, registry, {
      actor,
      commands: [
        { op: "object.create", type: "demo.board", title: "内层", data: {} },
      ],
    }).created["0"]!;
    const kept = applyCommands(db, registry, {
      actor,
      commands: [card("板上的卡片")],
    }).created["0"]!;
    const innerPresentation = applyCommands(db, registry, {
      actor,
      commands: [
        { op: "presentation.create", boardId: nestedBoard, objectId: kept },
      ],
    }).created["0"]!;
    applyCommands(db, registry, {
      actor,
      commands: [{ op: "object.delete", id: nestedBoard }],
    });
    assert.equal(
      (
        db
          .prepare("SELECT deleted_rev FROM presentations WHERE id = ?")
          .get(innerPresentation) as { deleted_rev: number }
      ).deleted_rev,
      revision(db),
    );
    assert.equal(objectOf(db, kept)?.deleted_rev, null);
    const entry = history(db).find((item) => item.id === result.historyId)!;
    const changes = JSON.parse(entry.changes) as {
      table: string;
      id: string;
    }[];
    assert.deepEqual(
      changes.map((change) => `${change.table}:${change.id}`).sort(),
      [
        `objects:${id}`,
        `presentations:${presentationId}`,
        `relations:${relationId}`,
      ].sort(),
    );
    assert.equal(entry.bytes, Buffer.byteLength(entry.changes));
  } finally {
    close();
  }
});

test("白板不能直接或间接放进自己里面", () => {
  const { db, registry, close } = scene();
  try {
    const a = applyCommands(db, registry, {
      actor,
      commands: [
        { op: "object.create", type: "demo.board", title: "A", data: {} },
      ],
    }).created["0"]!;
    const b = applyCommands(db, registry, {
      actor,
      commands: [
        { op: "object.create", type: "demo.board", title: "B", data: {} },
      ],
    }).created["0"]!;
    const c = applyCommands(db, registry, {
      actor,
      commands: [
        { op: "object.create", type: "demo.board", title: "C", data: {} },
      ],
    }).created["0"]!;
    applyCommands(db, registry, {
      actor,
      commands: [{ op: "presentation.create", boardId: a, objectId: b }],
    });
    const before = revision(db);
    expectError(
      () =>
        applyCommands(db, registry, {
          actor,
          commands: [{ op: "presentation.create", boardId: b, objectId: a }],
        }),
      "CYCLE",
      0,
    );
    assert.equal(revision(db), before);
    applyCommands(db, registry, {
      actor,
      commands: [{ op: "presentation.create", boardId: b, objectId: c }],
    });
    expectError(
      () =>
        applyCommands(db, registry, {
          actor,
          commands: [{ op: "presentation.create", boardId: c, objectId: a }],
        }),
      "CYCLE",
      0,
    );
  } finally {
    close();
  }
});

test("相同意图会合并，内容回到原样就删掉这条历史", () => {
  const { db, registry, close } = scene();
  try {
    const id = applyCommands(db, registry, {
      actor,
      intentId: "create",
      commands: [card("合并", { age: 1, label: "原" })],
    }).created["0"]!;
    const first = applyCommands(db, registry, {
      actor,
      intentId: "edit",
      commands: [{ op: "object.update", id, set: { age: 2 } }],
    });
    const second = applyCommands(db, registry, {
      actor,
      intentId: "edit",
      commands: [{ op: "object.update", id, set: { age: 3 } }],
    });
    assert.equal(first.historyId, second.historyId);
    const merged = JSON.parse(
      history(db).find((item) => item.id === first.historyId)!.changes,
    ) as {
      before: { data: { age: number } };
      after: { data: { age: number } };
    }[];
    assert.equal(merged.length, 1);
    assert.equal(merged[0]?.before.data.age, 1);
    assert.equal(merged[0]?.after.data.age, 3);

    const otherActor = applyCommands(db, registry, {
      actor: { id: "other", kind: "human" },
      intentId: "edit",
      commands: [{ op: "object.update", id, set: { age: 4 } }],
    });
    assert.notEqual(otherActor.historyId, first.historyId);
    const otherIntent = applyCommands(db, registry, {
      actor,
      intentId: "other",
      commands: [{ op: "object.update", id, set: { age: 5 } }],
    });
    const resumed = applyCommands(db, registry, {
      actor,
      intentId: "edit",
      commands: [{ op: "object.update", id, set: { age: 6 } }],
    });
    assert.notEqual(resumed.historyId, otherIntent.historyId);
    assert.notEqual(resumed.historyId, otherActor.historyId);

    const cursor = getMeta(db, "history_cursor");
    assert.ok(cursor);
    db.prepare(
      `INSERT INTO history (
         id, parent_id, seq, intent_id, label, kind, actor, actor_kind, at, changes, bytes
       ) VALUES ('child', ?, 1000, 'child', '隔开', 'edit', 'hui', 'human', ?, '[]', 2)`,
    ).run(cursor, Date.now());
    const blocked = applyCommands(db, registry, {
      actor,
      intentId: "edit",
      commands: [{ op: "object.update", id, set: { age: 7 } }],
    });
    assert.notEqual(blocked.historyId, cursor);

    const fresh = applyCommands(db, registry, {
      actor,
      intentId: "fresh-create",
      commands: [card("还原", { age: 1, label: "原" })],
    });
    const target = fresh.created["0"]!;
    const parent = fresh.historyId;
    const edited = applyCommands(db, registry, {
      actor,
      intentId: "fresh-edit",
      commands: [{ op: "object.update", id: target, set: { age: 2 } }],
    });
    const undone = applyCommands(db, registry, {
      actor,
      intentId: "fresh-edit",
      commands: [{ op: "object.update", id: target, set: { age: 1 } }],
    });
    assert.equal(undone.historyId, null);
    assert.equal(getMeta(db, "history_cursor"), parent);
    assert.equal(
      history(db).find((item) => item.id === edited.historyId),
      undefined,
    );
    assert.equal(JSON.parse(String(objectOf(db, target)?.data)).age, 1);
  } finally {
    close();
  }
});

test("不记录历史的写入不进历史，公开命令不能创建派生对象", () => {
  const { db, registry, close } = scene();
  try {
    const beforeHistory = history(db).length;
    const beforeAudit = audits(db).length;
    const beforeRev = revision(db);
    const hidden = applyCommands(db, registry, {
      actor,
      record: false,
      commands: [card("隐藏")],
    });
    assert.equal(hidden.historyId, null);
    assert.equal(history(db).length, beforeHistory);
    assert.equal(audits(db).length, beforeAudit + 1);
    assert.equal(revision(db), beforeRev + 1);
    assert.equal(JSON.parse(audits(db).at(-1)!.detail).revision, beforeRev + 1);

    expectError(
      () =>
        applyCommands(db, registry, {
          actor,
          commands: [
            {
              ...card("派生"),
              source: {
                origin: "derived",
                external: { kind: "file", uri: "file:///a" },
              },
            },
          ],
        }),
      "FORBIDDEN",
      0,
    );
    assert.equal(history(db).length, beforeHistory);
  } finally {
    close();
  }
});

test("自动标签：新建、移动、修改、删除", () => {
  const { db, registry, boardId, close } = scene();
  try {
    applyCommands(db, registry, { actor, commands: [card("便签")] });
    assert.equal(history(db).at(-1)?.label, "新建「便签」");
    const long = "一二三四五六七八九十一二三四五六七八九十一";
    applyCommands(db, registry, { actor, commands: [card(long)] });
    assert.equal(
      history(db).at(-1)?.label,
      "新建「一二三四五六七八九十一二三四五六七八九十…」",
    );

    const ids = [0, 1, 2].map(
      (index) =>
        applyCommands(db, registry, { actor, commands: [card(`移动${index}`)] })
          .created["0"]!,
    );
    const presentations = ids.map(
      (id) =>
        applyCommands(db, registry, {
          actor,
          commands: [{ op: "presentation.create", boardId, objectId: id }],
        }).created["0"]!,
    );
    applyCommands(db, registry, {
      actor,
      commands: presentations.map((id, index) => ({
        op: "presentation.update" as const,
        id,
        x: 20 + index,
      })),
    });
    assert.equal(history(db).at(-1)?.label, "移动 3 个组件");
    assert.equal(history(db).at(-1)?.kind, "move");
    applyCommands(db, registry, {
      actor,
      commands: [
        { op: "presentation.update", id: presentations[0]!, x: 4, z: 2 },
      ],
    });
    assert.equal(history(db).at(-1)?.kind, "edit");
    assert.equal(history(db).at(-1)?.label, "编辑 1 处");

    applyCommands(db, registry, {
      actor,
      commands: [{ op: "object.update", id: ids[0]!, set: { label: "改" } }],
    });
    assert.equal(history(db).at(-1)?.label, "修改「移动0」");
    applyCommands(db, registry, {
      actor,
      commands: [{ op: "object.delete", id: ids[1]! }],
    });
    assert.equal(history(db).at(-1)?.label, "删除「移动1」");
  } finally {
    close();
  }
});

test("v1 清单会转换后写入；不合格清单不会留在注册表", () => {
  const { db, registry, close } = scene();
  try {
    const before = registry.listPacks().map((pack) => pack.spec.id);
    applyCommands(db, registry, {
      actor,
      commands: [
        {
          op: "pack.import",
          manifest: {
            version: 1,
            id: "My Pack!",
            name: "我的包",
            components: [
              {
                key: "n",
                type: "text",
                title: "便签",
                width: 100,
                height: 80,
                data: { text: "你好", count: 0, tags: [] },
              },
            ],
          },
        },
      ],
    });
    const row = db
      .prepare("SELECT * FROM packs WHERE id = 'my-pack-'")
      .get() as {
      manifest: string;
      enabled: number;
    };
    const manifest = JSON.parse(row.manifest) as {
      title: string;
      presets: {
        type: string;
        data: { body: string; count: number; tags: unknown[] };
      }[];
    };
    assert.equal(manifest.title, "我的包");
    assert.equal(manifest.presets[0]?.type, "base.note");
    assert.equal(manifest.presets[0]?.data.body, "你好");
    assert.equal(manifest.presets[0]?.data.count, 0);
    assert.deepEqual(manifest.presets[0]?.data.tags, []);
    assert.equal(row.enabled, 1);

    const revisionBefore = revision(db);
    expectError(
      () =>
        applyCommands(db, registry, {
          actor,
          commands: [
            {
              op: "pack.import",
              manifest: {
                format: "sand-table-pack",
                formatVersion: 2,
                id: "bad",
                title: "坏",
                version: 1,
                types: [{ type: "bad.x" }],
              },
            },
          ],
        }),
      "INVALID_DATA",
      0,
    );
    assert.deepEqual(
      registry.listPacks().map((pack) => pack.spec.id),
      [...before, "my-pack-"],
    );
    assert.equal(
      db.prepare("SELECT id FROM packs WHERE id = 'bad'").get(),
      undefined,
    );
    assert.equal(revision(db), revisionBefore);

    const ids = registry.listPacks().map((pack) => pack.spec.id);
    expectError(
      () =>
        applyCommands(db, registry, {
          actor,
          commands: [
            {
              op: "pack.import",
              manifest: {
                format: "sand-table-pack",
                formatVersion: 2,
                id: "later",
                title: "稍后",
                version: 1,
              },
            },
            { op: "object.create", type: "missing.nope" },
          ],
        }),
      "UNKNOWN_TYPE",
      1,
    );
    assert.deepEqual(
      registry.listPacks().map((pack) => pack.spec.id),
      ids,
    );
    assert.equal(
      db.prepare("SELECT id FROM packs WHERE id = 'later'").get(),
      undefined,
    );
  } finally {
    close();
  }
});

test("内置包初始化可重复，派生编号可更新但不能覆盖人工对象", () => {
  const dir = mkdtempSync(join(tmpdir(), "sand-system-"));
  const db = openWorkspaceDb(join(dir, "workspace.db"), {
    create: true,
    workspaceId: "system",
  });
  const registry = createRegistry();
  try {
    registry.registerPack({ id: "base", title: "基础", version: 1 }, "builtin");
    registry.registerPack({ id: "code", title: "代码", version: 1 }, "builtin");
    registry.registerPack(
      {
        id: "kit",
        title: "工具",
        version: 1,
        derivedIdPrefix: "kit:",
        types: [
          {
            type: "kit.file",
            title: "文件",
            description: "一个文件",
            icon: "file",
            version: 1,
            schema: {
              type: "object",
              additionalProperties: false,
              properties: { path: { type: "string" } },
            },
            display: {
              material: "document",
              defaultSize: { width: 240, height: 80 },
            },
          },
        ],
      },
      "builtin",
    );
    syncPacks(db, registry, actor);
    assert.equal(isPackEnabled(db, "base"), true);
    assert.equal(isPackEnabled(db, "code"), false);
    assert.equal(isPackEnabled(db, "kit"), true);
    assert.equal(history(db).length, 0);
    applyCommands(db, registry, {
      actor,
      commands: [{ op: "pack.disable", id: "kit" }],
    });
    syncPacks(db, registry, actor);
    assert.equal(isPackEnabled(db, "kit"), false);
    assert.equal(isPackEnabled(db, "base"), true);
    applyCommands(db, registry, {
      actor,
      commands: [{ op: "pack.enable", id: "kit" }],
    });

    const source = {
      origin: "derived" as const,
      external: { kind: "file" as const, uri: "file:///a.ts", fragment: "src" },
    };
    const beforeHistory = history(db).length;
    const created = applySystemCommands(db, registry, {
      actor,
      commands: [
        {
          op: "object.upsert_derived",
          packId: "kit",
          id: "kit:a",
          type: "kit.file",
          title: "甲",
          data: { path: "a.ts" },
          source,
        },
      ],
    });
    assert.equal(created.historyId, null);
    assert.equal(history(db).length, beforeHistory);
    assert.equal(objectOf(db, "kit:a")?.title, "甲");
    applySystemCommands(db, registry, {
      actor,
      commands: [
        {
          op: "object.upsert_derived",
          packId: "kit",
          id: "kit:a",
          type: "kit.file",
          title: "甲改",
          data: { path: "a.ts" },
          source,
        },
      ],
    });
    assert.equal(objectOf(db, "kit:a")?.title, "甲改");
    assert.equal(objectOf(db, "kit:a")?.version, 2);
    assert.equal(history(db).length, beforeHistory);

    const human = applyCommands(db, registry, {
      actor,
      commands: [
        {
          op: "object.create",
          type: "kit.file",
          title: "手写",
          data: { path: "hand.ts" },
        },
      ],
    }).created["0"]!;
    expectError(
      () =>
        applySystemCommands(db, registry, {
          actor,
          commands: [
            {
              op: "object.upsert_derived",
              packId: "kit",
              id: human,
              type: "kit.file",
              title: "覆盖",
              data: { path: "hand.ts" },
              source,
            },
          ],
        }),
      "FORBIDDEN",
      0,
    );
    assert.equal(objectOf(db, human)?.title, "手写");
    expectError(
      () =>
        applySystemCommands(db, registry, {
          actor,
          commands: [
            {
              op: "object.upsert_derived",
              packId: "kit",
              id: "plain",
              type: "kit.file",
              title: "无前缀",
              data: {},
              source,
            },
          ],
        }),
      "INVALID_DATA",
      0,
    );

    const legacySource = JSON.stringify({
      origin: "derived",
      external: { kind: "file", uri: "file:///old.ts", fragment: "1" },
    });
    db.prepare(
      `INSERT INTO objects (
         id, type, title, data, source, created_at, created_by, updated_at, updated_by, rev
       ) VALUES ('old-1', 'kit.file', '旧文件', '{}', ?, 1, 'system', 1, 'system', 0)`,
    ).run(legacySource);
    applySystemCommands(db, registry, {
      actor,
      commands: [
        {
          op: "object.upsert_derived",
          packId: "kit",
          id: "old-1",
          type: "kit.file",
          title: "旧文件改",
          data: { path: "old.ts" },
          source: {
            origin: "derived",
            external: { kind: "file", uri: "file:///old.ts", fragment: "1" },
          },
        },
      ],
    });
    assert.equal(objectOf(db, "old-1")?.title, "旧文件改");
    expectError(
      () =>
        applySystemCommands(db, registry, {
          actor,
          commands: [
            {
              op: "object.upsert_derived",
              packId: "kit",
              id: "old-1",
              type: "kit.file",
              title: "对不上",
              data: {},
              source: {
                origin: "derived",
                external: {
                  kind: "file",
                  uri: "file:///other.ts",
                  fragment: "1",
                },
              },
            },
          ],
        }),
      "FORBIDDEN",
      0,
    );
    assert.equal(objectOf(db, "old-1")?.title, "旧文件改");

    expectError(
      () =>
        parsePublicCommands([
          { op: "pack.sync_builtin", id: "base", version: 1 },
        ]),
      "FORBIDDEN",
      0,
    );
    expectError(
      () =>
        parsePublicCommands([
          {
            op: "object.upsert_derived",
            packId: "kit",
            id: "kit:z",
            type: "kit.file",
            source,
          },
        ]),
      "FORBIDDEN",
      0,
    );
    const parsed = parsePublicCommands([
      { op: "setting.set", key: "theme", value: "dark" },
    ]);
    assert.equal(parsed[0]?.op, "setting.set");
    expectError(
      () =>
        applyCommands(db, registry, {
          actor,
          commands: [
            {
              op: "pack.sync_builtin",
              id: "base",
              version: 1,
              enabledByDefault: true,
            },
          ] as unknown as Command[],
        }),
      "FORBIDDEN",
      0,
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("创建设置的历史 before 为空，移除包留下墓碑", () => {
  const { db, registry, close } = scene();
  try {
    const set = applyCommands(db, registry, {
      actor,
      commands: [{ op: "setting.set", key: "density", value: 2 }],
    });
    const change = JSON.parse(
      history(db).find((item) => item.id === set.historyId)!.changes,
    )[0] as { before: null; after: { alive: boolean; value: number } };
    assert.equal(change.before, null);
    assert.equal(change.after.alive, true);
    assert.equal(change.after.value, 2);
    assert.equal(
      (
        db
          .prepare("SELECT deleted_rev FROM settings WHERE key = 'density'")
          .get() as {
          deleted_rev: number | null;
        }
      ).deleted_rev,
      null,
    );
    applyCommands(db, registry, {
      actor,
      commands: [
        {
          op: "pack.import",
          manifest: {
            format: "sand-table-pack",
            formatVersion: 2,
            id: "gone",
            title: "会移除",
            version: 1,
          },
        },
      ],
    });
    applyCommands(db, registry, {
      actor,
      commands: [{ op: "pack.remove", id: "gone" }],
    });
    const row = db
      .prepare("SELECT rev, deleted_rev FROM packs WHERE id = 'gone'")
      .get() as {
      rev: number;
      deleted_rev: number;
    };
    assert.equal(row.deleted_rev, row.rev);
    assert.equal(row.rev, revision(db));
    assert.equal(registry.getPack("gone"), undefined);
  } finally {
    close();
  }
});
