import { test } from "node:test";
import assert from "node:assert/strict";
import { BoardStore } from "../core/store.ts";
import { Spaces } from "../server/spaces.ts";
import { openView } from "../core/space-state.ts";
import type { Projection } from "../core/model.ts";
import { HISTORY_LIMIT } from "../core/history.ts";

const p: Projection = {
  workspaces: [
    {
      id: "w",
      label: "unit",
      head: "head",
      branch: "main",
      snapshot: "s",
      files: 1,
      omitted: [],
    },
  ],
  objects: [],
  relations: [],
};

const theme = {
  base: "mono" as const,
  background: "#101010",
  surface: "#181818",
  ink: "#f2f2f2",
  muted: "#9a9a9a",
  line: "#303030",
  accent: "#8ab4f8",
  font: "mono" as const,
  density: "compact" as const,
  radius: 10,
  reduceMotion: true,
};

function setup() {
  const store = new BoardStore();
  const opened = store.open(p, "unit");
  const spaces = new Spaces(store);
  openView(store.get(opened.id), "view-a");
  const op = (operation: any, author = "human") => {
    const board = spaces.update(
      opened.id,
      store.get(opened.id).revision,
      "view-a",
      operation,
      author,
    );
    return board;
  };
  return { store, spaces, id: opened.id, op };
}

test("undo walks the board back one edit at a time", () => {
  const { store, spaces, id, op } = setup();
  op({ kind: "create", type: "text", title: "A" });
  op({ kind: "create", type: "text", title: "B" });
  op({ kind: "create", type: "text", title: "C" });
  assert.equal(store.get(id).instances.length, 3);

  spaces.undo(id, undefined, "human");
  assert.equal(store.get(id).instances.length, 2, "one edit is undone");
  spaces.undo(id, undefined, "human");
  assert.equal(store.get(id).instances.length, 1, "and the next one too");
  spaces.undo(id, undefined, "human");
  assert.equal(store.get(id).instances.length, 0, "all the way back");
  assert.equal(store.history(id).canUndo, false);
  assert.throws(() => spaces.undo(id, undefined, "human"), /回退/);
});

test("the undo is a record on the same history", () => {
  const { store, spaces, id, op } = setup();
  op({ kind: "create", type: "text", title: "便签 A" });
  assert.equal(store.history(id).records.length, 1);
  assert.equal(store.history(id).records[0].label, "新建「便签 A」");

  spaces.undo(id, undefined, "human");
  const records = store.history(id).records;
  assert.equal(records.length, 2, "the undo is pushed, not popped");
  const flip = records[1];
  assert.equal(flip.kind, "undo");
  assert.equal(flip.label, "撤销 · 新建「便签 A」");
  assert.equal(flip.author, "human");
  assert.equal(flip.current, true, "the newest record is where the board is");
});

test("an agent's undo is the same kind of record as a human's", () => {
  const { store, spaces, id, op } = setup();
  op({ kind: "create", type: "text", title: "便签 A" }, "agent");
  spaces.undo(id, undefined, "agent");
  const flip = store.history(id).records.at(-1)!;
  assert.equal(flip.kind, "undo");
  assert.equal(flip.author, "agent", "there is no privileged category");
  assert.equal(store.get(id).instances.length, 0);
});

test("redo brings the undone edit back, and the flip is itself a record", () => {
  const { store, spaces, id, op } = setup();
  op({ kind: "create", type: "text", title: "便签 A" });
  spaces.undo(id, undefined, "human");
  assert.equal(store.get(id).instances.length, 0);
  assert.equal(store.history(id).canRedo, true);

  spaces.redo(id, undefined, "human");
  assert.equal(store.get(id).instances.length, 1, "the edit is back");
  const records = store.history(id).records;
  assert.equal(records.length, 3);
  assert.equal(records[2].kind, "redo");
  assert.equal(records[2].label, "重做 · 新建「便签 A」");
  assert.equal(store.history(id).canRedo, false);
  assert.throws(() => spaces.redo(id, undefined, "human"), /重做/);
});

test("one intent token collapses a burst of edits into a single step", () => {
  const { store, spaces, id, op } = setup();
  op({ kind: "create", type: "text", title: "草稿" });
  const instance = store.get(id).instances[0];
  for (const title of ["第一版", "第二版", "第三版"])
    op({
      kind: "update",
      instanceId: instance.id,
      title,
      intent: "edit:" + instance.id + ":session-1",
    });
  const records = store.history(id).records;
  assert.equal(records.length, 2, "the three edits are one step");
  assert.equal(store.get(id).instances[0].title, "第三版");

  // One undo rewinds the whole burst to the state before the first edit.
  spaces.undo(id, undefined, "human");
  assert.equal(store.get(id).instances[0].title, "草稿");
});

test("a different intent token is a separate step", () => {
  const { store, spaces, id, op } = setup();
  op({ kind: "create", type: "text", title: "草稿" });
  const instance = store.get(id).instances[0];
  op({
    kind: "update",
    instanceId: instance.id,
    title: "一",
    intent: "edit:" + instance.id + ":session-1",
  });
  op({
    kind: "update",
    instanceId: instance.id,
    title: "二",
    intent: "edit:" + instance.id + ":session-2",
  });
  assert.equal(store.history(id).records.length, 3);
  spaces.undo(id, undefined, "human");
  assert.equal(store.get(id).instances[0].title, "一");
});

test("re-saving identical content is not a history step", () => {
  const { store, id, op } = setup();
  op({ kind: "create", type: "text", title: "便签 A" });
  const instance = store.get(id).instances[0];
  const before = store.history(id).records.length;
  op({ kind: "update", instanceId: instance.id, title: "便签 A" });
  assert.equal(
    store.history(id).records.length,
    before,
    "an unchanged save must not become a step the user has to undo away",
  );
});

test("undo restores spaces, links, groups, placements and theme", () => {
  const { store, spaces, id, op } = setup();
  op({ kind: "create", type: "text", title: "A" });
  op({ kind: "create", type: "text", title: "B" });
  const [a, b] = store.get(id).instances;
  op({ kind: "link", source: a.id, target: b.id, relation: "related" });
  op({ kind: "group", ids: [a.id, b.id], title: "一组" });
  op({ kind: "theme", theme });
  assert.equal(store.get(id).spaceLinks.length, 1);
  assert.equal(store.get(id).groups.length, 1);
  assert.equal(store.get(id).theme?.accent, "#8ab4f8");

  spaces.undo(id, undefined, "human");
  assert.equal(store.get(id).theme, null, "theme is back to the previous state");
  assert.equal(store.get(id).groups.length, 1, "one undo is one step, not all");
  assert.equal(store.get(id).spaceLinks.length, 1);

  spaces.undo(id, undefined, "human");
  assert.equal(store.get(id).groups.length, 0);
  assert.equal(store.get(id).spaceLinks.length, 1);

  spaces.undo(id, undefined, "human");
  assert.equal(store.get(id).spaceLinks.length, 0);
  assert.equal(store.get(id).instances.length, 2);
});

test("undoTo jumps to a recorded step and the jump is itself reversible", () => {
  const { store, spaces, id, op } = setup();
  op({ kind: "create", type: "text", title: "第一" });
  const first = store.history(id).records[0];
  op({ kind: "create", type: "text", title: "第二" });
  assert.equal(store.get(id).instances.length, 2);

  spaces.undoTo(id, undefined, first.id, "human");
  assert.equal(store.get(id).instances.length, 1);
  assert.equal(store.get(id).instances[0].title, "第一");
  assert.equal(
    store.history(id).records.at(-1)!.label,
    "回退到 · 新建「第一」",
  );

  spaces.undo(id, undefined, "human");
  assert.equal(store.get(id).instances.length, 0, "one step further back");
  spaces.redo(id, undefined, "human");
  assert.equal(store.get(id).instances.length, 1, "the jump is reversible");
  assert.equal(store.get(id).instances[0].title, "第一");
});

test("a registered change intent survives a content undo", () => {
  const { store, spaces, id, op } = setup();
  const live = store.get(id);
  (live.intents as any[]).push({
    id: "intent-1",
    version: 1,
    request: "改一处源码",
    objectIds: [],
    allowedFiles: [],
    createdAt: Date.now(),
  });
  op({ kind: "create", type: "text", title: "便签" });
  spaces.undo(id, undefined, "human");
  const after = store.get(id);
  assert.equal(after.instances.length, 0, "the board content was reverted");
  assert.equal(
    after.intents.length,
    1,
    "the human's change intent is not part of board content and must survive",
  );
  assert.equal(after.intents[0].id, "intent-1");
});

test("a new edit after an undo drops the abandoned steps", () => {
  const { store, spaces, id, op } = setup();
  op({ kind: "create", type: "text", title: "第一" });
  op({ kind: "create", type: "text", title: "第二" });
  spaces.undo(id, undefined, "human");
  assert.equal(store.get(id).instances.length, 1);
  op({ kind: "create", type: "text", title: "第三" });
  assert.equal(store.get(id).instances.length, 2);
  assert.equal(
    store.get(id).instances.some((i) => i.title === "第二"),
    false,
    "the abandoned step is gone",
  );
  spaces.undo(id, undefined, "human");
  assert.equal(store.get(id).instances.length, 1);
  assert.equal(store.get(id).instances[0].title, "第一");
});

test("history is bounded", () => {
  const { store, id, op } = setup();
  for (let i = 0; i < HISTORY_LIMIT + 20; i++)
    op({ kind: "create", type: "text", title: "便签 " + i });
  const records = store.history(id).records;
  assert.ok(records.length <= HISTORY_LIMIT * 2);
  assert.equal(store.get(id).instances.length, HISTORY_LIMIT + 20);
});

test("a recorded undo keeps pointing at its step after old steps are trimmed", () => {
  const { store, spaces, id, op } = setup();
  for (let i = 0; i < HISTORY_LIMIT; i++)
    op({ kind: "create", type: "text", title: "便签 " + i });
  assert.equal(store.get(id).instances.length, HISTORY_LIMIT);

  spaces.undo(id, undefined, "human");
  spaces.redo(id, undefined, "human");
  const redo = store.history(id).records.find((r) => r.kind === "redo")!;

  // One more edit pushes the oldest step out of the history. Every step
  // position moves by one, so a record that remembers a position instead of
  // a step would now name the wrong step.
  op({ kind: "create", type: "text", title: "后来的" });
  assert.equal(store.get(id).instances.length, HISTORY_LIMIT + 1);

  spaces.undoTo(id, undefined, redo.id, "human");
  assert.equal(
    store.get(id).instances.length,
    HISTORY_LIMIT,
    "jumping to the redo record must land on the step it named",
  );
});
