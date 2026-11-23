import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { commentSections } from "../board/comments/scope.ts";
import {
  applyCommands,
  createRegistry,
  exportWorkspaceBundle,
  getMeta,
  importWorkspaceBundle,
  openWorkspace,
  readCommentCounts,
  readComments,
  undo,
  type Command,
} from "../kernel/index.ts";
import { basePack } from "../packs/base/index.ts";

function fixture(t: { after(callback: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "sand-comments-"));
  const registry = createRegistry();
  registry.registerPack(basePack, "builtin");
  const { db } = openWorkspace(dir, "comments", registry);
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const actor = { id: "human", kind: "human" } as const;
  const edit = (...commands: Command[]) =>
    applyCommands(db, registry, { actor, commands }).created;
  const boardA = getMeta(db, "home_board_id")!;
  const { target, first, second, other, boardB } = edit(
    { op: "object.create", ref: "target", type: "base.note" },
    { op: "object.create", ref: "other", type: "base.note" },
    { op: "object.create", ref: "boardB", type: "base.board" },
    {
      op: "presentation.create",
      ref: "first",
      boardId: boardA,
      objectId: "@target",
    },
    {
      op: "presentation.create",
      ref: "second",
      boardId: "@boardB",
      objectId: "@target",
    },
  );
  const create = (
    body: string,
    options: { parent?: string; presentationId?: string } = {},
  ) =>
    edit(
      {
        op: "object.create",
        ref: "comment",
        type: "base.comment",
        data: { body },
      },
      {
        op: "relation.create",
        ref: "edge",
        sourceId: "@comment",
        kind: options.parent ? "base.reply_to" : "base.comments_on",
        targetId: options.parent ?? target,
        ...(options.presentationId
          ? {
              attributes: {
                scope: "presentation",
                presentationId: options.presentationId,
              },
            }
          : {}),
      },
    );
  return {
    dir,
    registry,
    db,
    edit,
    create,
    actor,
    target,
    first,
    second,
    other,
    boardA,
    boardB,
  };
}

test("共享与局部评论按展示显示，回复继承范围", (t) => {
  const s = fixture(t);
  const shared = s.create("共享").comment;
  const local = s.create("此处评论", { presentationId: s.first }).comment;
  const reply = s.create("回复此处评论", { parent: local }).comment;
  const read = (presentation: string) =>
    readComments(s.db, s.target, presentation).entries;
  const first = read(s.first);
  assert.deepEqual(
    new Set(first.map(({ id }) => id)),
    new Set([shared, local, reply]),
  );
  assert.deepEqual(
    commentSections(first, s.second).current.map(({ id }) => id),
    [shared],
  );
  assert.deepEqual(
    read(s.second).map(({ id }) => id),
    [shared],
  );
  assert.equal(first.find(({ id }) => id === reply)?.presentationId, s.first);
  assert.deepEqual(readCommentCounts(s.db, s.boardA).counts, { [s.first]: 3 });
  assert.deepEqual(readCommentCounts(s.db, s.boardB).counts, { [s.second]: 1 });
  s.edit({ op: "object.update", id: shared, set: { resolved: true } });
  assert.deepEqual(readCommentCounts(s.db, s.boardB).counts, {});
  undo(s.db, s.actor);
  assert.deepEqual(readCommentCounts(s.db, s.boardB).counts, { [s.second]: 1 });
  s.edit({ op: "presentation.delete", id: s.first });
  const result = commentSections(read(s.second), s.second);
  assert.deepEqual(
    result.current.map(({ id }) => id),
    [shared],
  );
  assert.deepEqual(
    new Set(result.removedPlacements.map(({ id }) => id)),
    new Set([local, reply]),
  );
  undo(s.db, s.actor);
  s.edit({ op: "object.delete", id: local });
  const retained = read(s.first);
  assert.equal(retained.find(({ id }) => id === local)?.removed, true);
  assert.equal(retained.find(({ id }) => id === reply)?.rootId, local);
});

test("评论写入拒绝脱离对象、重复关系、错误展示和回复环", (t) => {
  const s = fixture(t);
  assert.throws(
    () =>
      s.edit({
        op: "object.create",
        type: "base.comment",
        data: { body: "无关联" },
      }),
    /同一次提交/,
  );
  const local = s.create("局部", { presentationId: s.first });
  assert.throws(
    () =>
      s.edit({
        op: "relation.create",
        kind: "base.comments_on",
        sourceId: local.comment,
        targetId: s.target,
      }),
    /只能关联一个/,
  );
  assert.throws(
    () =>
      s.edit({
        op: "relation.update",
        id: local.edge,
        attributes: { scope: "presentation", presentationId: "foreign" },
      }),
    /必须属于当前评论对象/,
  );
  assert.throws(() => readComments(s.db, s.other, s.first), /此展示不属于/);
  const reply = s.create("回复", { parent: local.comment });
  assert.throws(
    () =>
      s.edit(
        { op: "relation.delete", id: local.edge },
        {
          op: "relation.create",
          kind: "base.reply_to",
          sourceId: local.comment,
          targetId: reply.comment,
        },
      ),
    /不能形成环/,
  );
  assert.throws(
    () =>
      s.edit({
        op: "relation.update",
        id: reply.edge,
        attributes: { scope: "object" },
      }),
    /沿用根评论/,
  );
});

test("组合文件拒绝展示和目标不一致，已移除的展示只保留批注定位", (t) => {
  const s = fixture(t);
  const local = s.create("需要保留的批注", { presentationId: s.first });
  const bundle = JSON.parse(exportWorkspaceBundle(s.db).json);
  bundle.relations.find(
    (entry: { id: string }) => entry.id === local.edge,
  ).targetId = s.other;
  assert.throws(
    () => importWorkspaceBundle(s.dir, s.registry, JSON.stringify(bundle)),
    /评论关系.*有误/,
  );
  s.edit({ op: "presentation.delete", id: s.first });
  const exported = exportWorkspaceBundle(s.db);
  const imported = importWorkspaceBundle(s.dir, s.registry, exported.json);
  const { db } = openWorkspace(s.dir, imported.workspaceId, s.registry);
  try {
    const { entries } = readComments(db, s.target, s.second);
    assert.equal(entries[0].id, local.comment);
    assert.equal(entries[0].originalRemoved, true);
    assert.deepEqual(readCommentCounts(db, s.boardB).counts, {});
  } finally {
    db.close();
  }
});
