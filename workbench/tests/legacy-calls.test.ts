import assert from "node:assert/strict";
import { test } from "node:test";
import { toCommands } from "../board/data-client/adapter.ts";
import { translateLegacyTool } from "../board/data-client/legacy-calls.ts";
import type {
  V3ObjectRow,
  V3PresentationRow,
} from "../board/data-client/store.ts";

test("导入仓库转到 code_repo，并先启用代码包", () => {
  const translated = translateLegacyTool("sand_import_repository", {
    path: "  /tmp/repo  ",
  });
  assert.ok(translated && "steps" in translated);
  assert.deepEqual(translated.steps, [
    {
      name: "app_edit",
      args: { commands: [{ op: "pack.enable", id: "code" }] },
    },
    { name: "code_repo", args: { action: "import", path: "/tmp/repo" } },
  ]);
  assert.equal(translated.refreshBoard, true);
  assert.equal(translated.result, "ok");
});

test("刷新已导入仓库只带仓库编号", () => {
  const translated = translateLegacyTool("sand_import_repository", {
    workspaceId: "code:abc",
  });
  assert.ok(translated && "steps" in translated);
  assert.equal(translated.steps[1]?.name, "code_repo");
  assert.deepEqual(translated.steps[1]?.args, {
    action: "refresh",
    workspaceId: "code:abc",
  });
});

test("读源码转到 code_repo 的 read_source", () => {
  const translated = translateLegacyTool("sand_read_source", {
    objectId: "code:abc:src/index.js#clsx:1",
    startLine: 12,
  });
  assert.ok(translated && "steps" in translated);
  assert.deepEqual(translated.steps, [
    {
      name: "code_repo",
      args: {
        action: "read_source",
        objectId: "code:abc:src/index.js#clsx:1",
        startLine: 12,
      },
    },
  ]);
  assert.equal(translated.refreshBoard, false);
  assert.equal(translated.result, "last");
});

test("备注和讲解还没有对应工具，不假装能保存", () => {
  const note = translateLegacyTool("sand_edit_view", {
    viewId: "view",
    note: { objectId: "n1", text: "备注" },
  });
  assert.ok(note && "unsupported" in note);
  assert.match(note.unsupported, /备注/);
  const guide = translateLegacyTool("sand_edit_view", {
    viewId: "view",
    guideFocus: { guideId: "g", step: 0 },
  });
  assert.ok(guide && "unsupported" in guide);
  assert.match(guide.unsupported, /讲解/);
});

test("人物姓名写到标题上，不把 name 交给内核", () => {
  const object = {
    id: "o1",
    type: "novel.character",
    title: "人物",
  } as V3ObjectRow;
  const presentation = {
    id: "p1",
    objectId: "o1",
    boardId: "overview",
  } as V3PresentationRow;
  const commands = toCommands(
    {
      kind: "update",
      instanceId: "p1",
      data: { name: "林澈", role: "主角" },
      baseData: {},
    },
    {
      boardId: "overview",
      objects: new Map([["o1", object]]),
      presentations: new Map([["p1", presentation]]),
    },
  );
  assert.deepEqual(commands, [
    {
      op: "object.update",
      id: "o1",
      title: "林澈",
      set: { role: "主角" },
    },
  ]);
});

test("一次移除多份展示合成一批删除", () => {
  const presentations = new Map([
    ["p1", { id: "p1" } as V3PresentationRow],
    ["p2", { id: "p2" } as V3PresentationRow],
    ["p3", { id: "p3" } as V3PresentationRow],
  ]);
  const commands = toCommands(
    { kind: "remove", instanceIds: ["p1", "missing", "p3"] },
    {
      boardId: "overview",
      objects: new Map(),
      presentations,
    },
  );
  assert.deepEqual(commands, [
    { op: "presentation.delete", id: "p1" },
    { op: "presentation.delete", id: "p3" },
  ]);
});

test("视角选择转到 app_view", () => {
  const translated = translateLegacyTool("sand_edit_view", {
    viewId: "view-1",
    selection: ["p1"],
  });
  assert.ok(translated && "steps" in translated);
  assert.deepEqual(translated.steps, [
    {
      name: "app_view",
      args: { action: "select", viewId: "view-1", selection: ["p1"] },
    },
  ]);
});
