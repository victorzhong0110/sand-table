import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { toCommands } from "../board/data-client/adapter.ts";
import {
  applyCommands,
  createRegistry,
  getMeta,
  openWorkspace,
  query,
  type Command,
} from "../kernel/index.ts";
import { builtinPacks } from "../packs/index.ts";

test("交叉情境创建前按同一个事务核对命令上限", () => {
  const ctx = { boardId: "home", objects: new Map(), presentations: new Map() };
  const participants = Array.from(
    { length: 199 },
    (_, index) => `participant-${index}`,
  );
  const create = (contextParticipants: string[]) =>
    toCommands(
      { kind: "create", type: "base.context", contextParticipants },
      ctx,
    );
  assert.equal(create(participants.slice(0, 198)).length, 200);
  assert.throws(() => create(participants), /最多写入 200 条命令/);
});

test("多方交叉使用双向直接关系并保留推测状态，查询不写入事实", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sand-context-"));
  const registry = createRegistry();
  for (const pack of builtinPacks) registry.registerPack(pack, "builtin");
  const { db } = openWorkspace(dir, "context-test", registry);
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const actor = { id: "human", kind: "human" } as const;
  const edit = (commands: Command[]) =>
    applyCommands(db, registry, { actor, commands }).created;
  const note = (name: string): Command => ({
    op: "object.create",
    ref: name,
    title: name,
    type: "base.note",
  });
  const relate = (sourceId: string, targetId: string): Command => ({
    op: "relation.create",
    kind: "base.related",
    sourceId,
    targetId,
  });
  const ids = edit([
    { op: "pack.enable", id: "novel" },
    note("lin"),
    note("chapter"),
    note("teacher"),
    note("scene"),
    note("inferred"),
    note("partial"),
    note("unrelated"),
    { op: "object.create", ref: "context", type: "base.context" },
    relate("@scene", "@lin"),
    relate("@chapter", "@scene"),
    relate("@scene", "@teacher"),
    relate("@inferred", "@chapter"),
    {
      op: "relation.create",
      kind: "novel.precedes",
      status: "inferred",
      basis: "测试中的叙事顺序",
      sourceId: "@inferred",
      targetId: "@lin",
    },
    relate("@partial", "@lin"),
    relate("@chapter", "@lin"),
    {
      op: "relation.create",
      kind: "base.involves",
      sourceId: "@context",
      targetId: "@lin",
    },
    {
      op: "relation.create",
      kind: "base.involves",
      sourceId: "@context",
      targetId: "@chapter",
    },
  ]);
  const revision = getMeta(db, "revision");
  const count = () =>
    db.prepare("SELECT COUNT(*) AS count FROM relations").get();
  const originalCount = count();
  const two = [ids.lin, ids.chapter];
  const page1 = query(db, registry, { relatedToAll: two, limit: 1 });
  assert.equal(page1.total, 2);
  assert.ok(page1.nextCursor);
  const page2 = query(db, registry, {
    relatedToAll: two,
    limit: 1,
    cursor: page1.nextCursor,
  });
  const rows = [...page1.rows, ...page2.rows];
  assert.deepEqual(
    rows.map((row) => row.id),
    [ids.scene, ids.inferred].sort(),
  );
  assert.equal(page2.nextCursor, null);
  assert.deepEqual(
    rows
      .find((row) => row.id === ids.inferred)
      ?.participantRelations?.find(
        (relation) => relation.participantId === ids.lin,
      ),
    {
      participantId: ids.lin,
      title: "lin",
      kind: "novel.precedes",
      label: "先于",
      direction: "out",
      status: "inferred",
    },
  );
  assert.equal(
    rows
      .find((row) => row.id === ids.scene)
      ?.participantRelations?.find(
        (relation) => relation.participantId === ids.chapter,
      )?.direction,
    "in",
  );
  assert.deepEqual(
    query(db, registry, { relatedToAll: [...two, ids.teacher] }).rows.map(
      (row) => row.id,
    ),
    [ids.scene],
  );
  assert.equal(
    query(db, registry, { relatedToAll: [...two, ids.unrelated] }).total,
    0,
  );
  assert.equal(
    query(db, registry, { relatedToAll: [...two, ids.lin] }).total,
    2,
  );
  assert.throws(
    () => query(db, registry, { relatedToAll: [ids.lin, ids.lin] }),
    /至少两个不同/,
  );
  assert.equal(getMeta(db, "revision"), revision);
  assert.deepEqual(count(), originalCount);
  edit([{ op: "object.delete", id: page1.rows[0].id }]);
  assert.deepEqual(
    query(db, registry, {
      relatedToAll: two,
      limit: 1,
      cursor: page1.nextCursor,
    }).rows.map(({ id }) => id),
    [page2.rows[0].id],
  );
});
