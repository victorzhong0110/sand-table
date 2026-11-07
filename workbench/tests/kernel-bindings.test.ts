import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  applyCommands,
  CommandError,
  createRegistry,
  openWorkspaceDb,
  readBindings,
  readObjectVersion,
  redo,
  undo,
  type Command,
} from "../kernel/index.ts";

const actor = { id: "tester", kind: "human" } as const;
const manifest = {
  format: "sand-table-pack",
  formatVersion: 2,
  id: "demo",
  title: "测试",
  version: 1,
  types: [
    {
      type: "demo.reader",
      title: "读取者",
      description: "读取者",
      icon: "note",
      version: 1,
      schema: { type: "object", properties: {}, additionalProperties: false },
      display: { material: "paper", defaultSize: { width: 200, height: 100 } },
      relationSlots: [
        {
          key: "source",
          label: "来源",
          kind: "demo.source",
          direction: "out",
          many: true,
          targetTypes: ["demo.table"],
        },
        {
          key: "other",
          label: "另一槽",
          kind: "demo.other",
          direction: "out",
          many: true,
          targetTypes: ["demo.table"],
        },
      ],
    },
    {
      type: "demo.table",
      title: "表格",
      description: "表格",
      icon: "note",
      version: 1,
      schema: {
        type: "object",
        properties: { value: { type: "integer" }, note: { type: "string" } },
        additionalProperties: false,
      },
      display: { material: "paper", defaultSize: { width: 200, height: 100 } },
    },
  ],
  relationKinds: ["source", "other"].map((id) => ({
    kind: `demo.${id}`,
    title: "来源",
    inverseTitle: "被引用",
    allowsInferred: false,
  })),
};
function scene() {
  const dir = mkdtempSync(join(tmpdir(), "sand-bindings-"));
  const db = openWorkspaceDb(join(dir, "workspace.db"), {
    create: true,
    workspaceId: "test",
  });
  const registry = createRegistry();
  function edit(commands: Command[], intentId?: string) {
    return applyCommands(db, registry, {
      actor,
      commands,
      ...(intentId ? { intentId } : {}),
    });
  }
  edit([{ op: "pack.import", manifest }]);
  const created = edit([
    { op: "object.create", type: "demo.reader", title: "读者" },
    {
      op: "object.create",
      type: "demo.table",
      title: "表一",
      data: { value: 1, note: "笔记" },
    },
    {
      op: "object.create",
      type: "demo.table",
      title: "表二",
      data: { value: 2 },
    },
    {
      op: "object.create",
      type: "demo.table",
      title: "表三",
      data: { value: 3 },
    },
  ]);
  const [reader, one, two, three] = [0, 1, 2, 3].map(
    (i) => created.created[String(i)]!,
  );
  const links = edit([
    {
      op: "relation.create",
      kind: "demo.source",
      sourceId: reader!,
      targetId: one!,
    },
    {
      op: "relation.create",
      kind: "demo.source",
      sourceId: reader!,
      targetId: two!,
    },
    {
      op: "relation.create",
      kind: "demo.other",
      sourceId: reader!,
      targetId: three!,
    },
  ]);
  return {
    db,
    registry,
    edit,
    reader: reader!,
    one: one!,
    two: two!,
    three: three!,
    firstLink: links.created["0"]!,
    close() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
function denied(fn: () => unknown) {
  assert.throws(
    fn,
    (error) => error instanceof CommandError && error.code === "FORBIDDEN",
  );
}

test("只读取当前槽绑定的对象，跨槽和未声明槽不能读取历史", () => {
  const s = scene();
  try {
    const result = readBindings(s.db, s.registry, {
      objectId: s.reader,
      slot: "source",
    });
    assert.deepEqual(
      result.items.map((x) => x.id).sort(),
      [s.one, s.two].sort(),
    );
    denied(() =>
      readBindings(s.db, s.registry, {
        objectId: s.reader,
        slot: "source",
        ids: [s.one, s.three],
      }),
    );
    denied(() =>
      readBindings(s.db, s.registry, { objectId: s.reader, slot: "missing" }),
    );
    denied(() =>
      readObjectVersion(s.db, s.registry, {
        objectId: s.reader,
        slot: "source",
        targetId: s.three,
        version: 1,
      }),
    );
    assert.equal(
      readBindings(s.db, s.registry, { objectId: s.reader, slot: "self" })
        .items[0]?.id,
      s.reader,
    );
  } finally {
    s.close();
  }
});

test("字段与分页", () => {
  const s = scene();
  try {
    const first = readBindings(s.db, s.registry, {
      objectId: s.reader,
      slot: "source",
      fields: ["value"],
      limit: 1,
    });
    assert.equal(first.items.length, 1);
    assert.deepEqual(Object.keys(first.items[0]!.data), ["value"]);
    assert.ok(first.nextCursor);
    const second = readBindings(s.db, s.registry, {
      objectId: s.reader,
      slot: "source",
      limit: 1,
      cursor: first.nextCursor,
    });
    assert.equal(second.items.length, 1);
    assert.notEqual(first.items[0]!.id, second.items[0]!.id);
    assert.equal(second.nextCursor, null);
    denied(() =>
      readBindings(s.db, s.registry, {
        objectId: s.reader,
        slot: "source",
        fields: ["sessionToken"],
      }),
    );
  } finally {
    s.close();
  }
});

test("删除目标显示失效，撤销恢复；解除关系后不恢复授权", () => {
  const s = scene();
  try {
    s.edit([{ op: "object.delete", id: s.one }]);
    assert.match(
      readBindings(s.db, s.registry, {
        objectId: s.reader,
        slot: "source",
      }).items.find((x) => x.id === s.one)?.unavailable ?? "",
      /删除/,
    );
    undo(s.db, actor);
    assert.equal(
      readBindings(s.db, s.registry, {
        objectId: s.reader,
        slot: "source",
      }).items.find((x) => x.id === s.one)?.unavailable,
      undefined,
    );
    s.edit([
      { op: "relation.delete", id: s.firstLink },
      { op: "object.delete", id: s.one },
    ]);
    denied(() =>
      readBindings(s.db, s.registry, {
        objectId: s.reader,
        slot: "source",
        ids: [s.one],
      }),
    );
  } finally {
    s.close();
  }
});

test("旧版本取 before 和 after；裁剪后不回退当前值", () => {
  const s = scene();
  try {
    for (let value = 2; value <= 4; value++)
      s.edit([{ op: "object.update", id: s.one, set: { value } }]);
    for (let version = 1; version <= 4; version++) {
      const found = readObjectVersion(s.db, s.registry, {
        objectId: s.reader,
        slot: "source",
        targetId: s.one,
        version,
      });
      assert.equal(found.ok, true);
      if (found.ok) {
        assert.equal(found.row.data.value, version);
        if (version < 4) assert.equal(found.row.rev, null);
        else assert.equal(typeof found.row.rev, "number");
      }
    }
    s.db.exec("PRAGMA foreign_keys=OFF");
    s.db.prepare("DELETE FROM history WHERE changes LIKE ?").run(`%${s.one}%`);
    const unavailable = readObjectVersion(s.db, s.registry, {
      objectId: s.reader,
      slot: "source",
      targetId: s.one,
      version: 1,
    });
    assert.equal(unavailable.ok, false);
    if (!unavailable.ok) assert.match(unavailable.reason, /清理/);
  } finally {
    s.close();
  }
});

test("批量删除目标与独立解除关系可区分，重做仍显示失效", () => {
  const s = scene();
  try {
    s.edit([
      { op: "object.update", id: s.three, title: "其他编辑" },
      { op: "object.delete", id: s.one },
    ]);
    assert.match(
      readBindings(s.db, s.registry, {
        objectId: s.reader,
        slot: "source",
      }).items.find((item) => item.id === s.one)?.unavailable ?? "",
      /删除/,
    );
    undo(s.db, actor);
    assert.ok(
      readBindings(s.db, s.registry, {
        objectId: s.reader,
        slot: "source",
      }).items.some((item) => item.id === s.one && !item.unavailable),
    );
    redo(s.db, actor);
    assert.match(
      readBindings(s.db, s.registry, {
        objectId: s.reader,
        slot: "source",
      }).items.find((item) => item.id === s.one)?.unavailable ?? "",
      /删除/,
    );
  } finally {
    s.close();
  }
});

test("包停用只显示失效，不提供数据或历史", () => {
  const s = scene();
  try {
    const viewer = {
      format: "sand-table-pack",
      formatVersion: 2,
      id: "viewer",
      title: "读取包",
      version: 1,
      types: [
        {
          type: "viewer.reader",
          title: "读取者",
          description: "读取者",
          icon: "note",
          version: 1,
          schema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          display: {
            material: "paper",
            defaultSize: { width: 200, height: 100 },
          },
          relationSlots: [
            {
              key: "source",
              label: "来源",
              kind: "viewer.source",
              direction: "out",
              many: true,
              targetTypes: ["demo.table"],
            },
          ],
        },
      ],
      relationKinds: [
        {
          kind: "viewer.source",
          title: "来源",
          inverseTitle: "被引用",
          allowsInferred: false,
        },
      ],
    };
    s.edit([{ op: "pack.import", manifest: viewer }]);
    const made = s.edit([
      { op: "object.create", type: "viewer.reader", title: "读取者" },
    ]);
    const reader = made.created["0"]!;
    s.edit([
      {
        op: "relation.create",
        kind: "viewer.source",
        sourceId: reader,
        targetId: s.one,
      },
    ]);
    s.edit([{ op: "pack.disable", id: "demo" }]);
    const item = readBindings(s.db, s.registry, {
      objectId: reader,
      slot: "source",
    }).items[0]!;
    assert.match(item.unavailable ?? "", /未启用/);
    assert.deepEqual(item.data, {});
    assert.equal(item.source, null);
    const version = readObjectVersion(s.db, s.registry, {
      objectId: reader,
      slot: "source",
      targetId: s.one,
      version: 1,
    });
    assert.equal(version.ok, false);
  } finally {
    s.close();
  }
});

test("仅 before 的版本可读；同一版本快照冲突明确报错", () => {
  const s = scene();
  try {
    s.edit([{ op: "object.update", id: s.one, set: { value: 2 } }]);
    const histories = s.db.prepare("SELECT id, changes FROM history").all() as {
      id: string;
      changes: string;
    }[];
    for (const entry of histories) {
      const changes = JSON.parse(entry.changes);
      for (const change of changes)
        if (
          change.table === "objects" &&
          change.id === s.one &&
          change.after?.version === 1
        )
          change.after = null;
      s.db
        .prepare("UPDATE history SET changes = ? WHERE id = ?")
        .run(JSON.stringify(changes), entry.id);
    }
    const input = {
      objectId: s.reader,
      slot: "source",
      targetId: s.one,
      version: 1,
    };
    const before = readObjectVersion(s.db, s.registry, input);
    assert.ok(before.ok && before.row.data.value === 1);
    const update = histories
      .map((entry) => ({
        ...entry,
        changes: JSON.parse(
          (
            s.db
              .prepare("SELECT changes FROM history WHERE id = ?")
              .get(entry.id) as { changes: string }
          ).changes,
        ),
      }))
      .find((entry) =>
        entry.changes.some(
          (change: any) =>
            change.table === "objects" &&
            change.id === s.one &&
            change.before?.version === 1,
        ),
      )!;
    const conflicting = structuredClone(
      update.changes.find(
        (change: any) =>
          change.table === "objects" &&
          change.id === s.one &&
          change.before?.version === 1,
      ),
    );
    conflicting.before.data.value = 999;
    update.changes.push(conflicting);
    s.db
      .prepare("UPDATE history SET changes = ? WHERE id = ?")
      .run(JSON.stringify(update.changes), update.id);
    const ambiguous = readObjectVersion(s.db, s.registry, input);
    assert.equal(ambiguous.ok, false);
    if (!ambiguous.ok) assert.match(ambiguous.reason, /不一致/);
  } finally {
    s.close();
  }
});

test("合并历史中区分级联删除和先解除绑定", () => {
  const s = scene();
  try {
    s.edit([{ op: "object.update", id: s.three, title: "其他编辑" }], "group");
    s.edit([{ op: "object.delete", id: s.one }], "group");
    assert.match(
      readBindings(s.db, s.registry, {
        objectId: s.reader,
        slot: "source",
      }).items.find((item) => item.id === s.one)?.unavailable ?? "",
      /删除/,
    );
    undo(s.db, actor);
    s.edit([{ op: "relation.delete", id: s.firstLink }], "detached");
    s.edit([{ op: "object.delete", id: s.one }], "detached");
    denied(() =>
      readBindings(s.db, s.registry, {
        objectId: s.reader,
        slot: "source",
        ids: [s.one],
      }),
    );
  } finally {
    s.close();
  }
});
