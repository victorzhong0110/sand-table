import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  applyCommands,
  boardContents,
  createRegistry,
  getMeta,
  isMediaCrop,
  migrateData,
  openWorkspace,
  type ObjectRow,
} from "../kernel/index.ts";
import { basePack } from "../packs/base/index.ts";
import { cropFromPoints } from "../board/media/crop.ts";

test("同一对象可分别设置展示封面裁剪，无效修改不会覆盖上次设置", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sand-media-"));
  const registry = createRegistry();
  registry.registerPack(basePack, "builtin");
  const { db } = openWorkspace(dir, "media-test", registry);
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const boardId = getMeta(db, "home_board_id")!;
  const actor = { id: "human", kind: "human" } as const;
  const coverBlob = "a".repeat(64);
  const coverCrop = { x: 0.5, y: 0, w: 0.5, h: 1 };
  const { created } = applyCommands(db, registry, {
    actor,
    commands: [
      { op: "object.create", type: "base.board", ref: "note" },
      {
        op: "presentation.create",
        boardId,
        objectId: "@note",
        ref: "first",
        appearance: { coverBlob, coverCrop },
      },
      {
        op: "presentation.create",
        boardId,
        objectId: "@note",
        ref: "second",
        appearance: { coverBlob },
      },
    ],
  });
  assert.throws(
    () =>
      applyCommands(db, registry, {
        actor,
        commands: [
          {
            op: "presentation.update",
            id: created.first,
            appearance: { coverCrop },
          },
        ],
      }),
    /封面裁剪须位于/,
  );
  const shows = boardContents(db, registry, boardId).presentations;
  assert.deepEqual(shows.find(({ id }) => id === created.first)?.appearance, {
    coverBlob,
    coverCrop,
  });
  assert.deepEqual(shows.find(({ id }) => id === created.second)?.appearance, {
    coverBlob,
  });
});

test("裁剪坐标必须覆盖原图内的正面积", () => {
  assert.equal(isMediaCrop({ x: 0, y: 0.2, w: 1, h: 0.8 }), true);
  assert.equal(isMediaCrop({ x: 0.75, y: 0, w: 0.5, h: 1 }), false);
  assert.equal(isMediaCrop({ x: 0, y: 1, w: 1, h: 0 }), false);
  assert.equal(isMediaCrop({ x: NaN, y: 0, w: 1, h: 1 }), false);
  assert.deepEqual(cropFromPoints({ x: 2, y: 0.75 }, { x: 0.25, y: -1 }), {
    x: 0.25,
    y: 0,
    w: 0.75,
    h: 0.75,
  });
  assert.equal(
    cropFromPoints({ x: 0.1, y: 0.1 }, { x: 0.1, y: 0.2 }),
    undefined,
  );
});

test("媒体 v1 迁移保留原始附件和说明，新增裁剪校验原图边界", () => {
  const registry = createRegistry();
  registry.registerPack(basePack, "builtin");
  const row: ObjectRow = {
    id: "media",
    title: "原图",
    type: "base.media",
    typeVersion: 1,
    data: { blob: "a".repeat(64), mime: "image/png", caption: "原始说明" },
    source: null,
    version: 1,
    createdAt: 0,
    createdBy: "human",
    updatedAt: 0,
    updatedBy: "human",
    rev: 0,
    deleted: false,
  };
  const migrated = migrateData(registry, row);
  assert.deepEqual(migrated, { data: row.data, typeVersion: 2 });
  const data = { ...migrated.data, filename: "原图.png", size: 1024 };
  assert.equal(
    registry.validateData("base.media", {
      ...data,
      crop: { x: 0.2, y: 0.1, w: 0.8, h: 0.9 },
    }).ok,
    true,
  );
  assert.equal(
    registry.validateData("base.media", {
      ...data,
      crop: { x: 0.2, y: 0.1, w: 1, h: 1 },
    }).ok,
    false,
  );
});
