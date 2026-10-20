import { z } from "zod";
import { registerSpaceTools } from "../server/spaces.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { BoardStore } from "../core/store.ts";
import { Spaces } from "../server/spaces.ts";
import { openView } from "../core/space-state.ts";
import type { Projection } from "../core/model.ts";
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
  objects: [
    {
      id: "obj",
      workspaceId: "w",
      kind: "file",
      title: "one.ts",
      source: {
        workspaceId: "w",
        path: "one.ts",
        startLine: 1,
        endLine: 2,
        hash: "hash",
      },
    },
  ],
  relations: [],
};
test("nested whiteboards, independent object instances, pins, view identity and broken references", () => {
  const store = new BoardStore();
  let b = store.open(p, "unit");
  const spaces = new Spaces(store);
  openView(store.get(b.id), "view-a");
  openView(store.get(b.id), "view-b");
  const op = (operation: any) => {
    b = spaces.update(b.id, store.get(b.id).revision, "view-a", operation);
    return b;
  };
  const original = b.instances[0];
  op({ kind: "duplicate", instanceId: original.id });
  const copy = b.instances.at(-1)!;
  assert.equal(copy.objectId, original.objectId);
  assert.notEqual(copy.id, original.id);
  op({
    kind: "place",
    items: [{ id: copy.id, rect: { ...copy.rect, x: 450, pinned: true } }],
  });
  assert.notEqual(b.instances[0].rect.x, 450);
  assert.throws(
    () =>
      op({
        kind: "place",
        items: [{ id: copy.id, rect: { ...copy.rect, x: 500, pinned: true } }],
      }),
    /Unpin/,
  );
  op({ kind: "create", type: "board", title: "Child", data: {} });
  const container = b.instances.find((c) => c.type === "board")!,
    child = String(container.data.spaceId);
  op({ kind: "move", instanceId: original.id, spaceId: child });
  op({ kind: "navigate", spaceId: child });
  assert.equal(b.views["view-a"].spaceId, child);
  assert.equal(b.views["view-b"].spaceId, "overview");
  assert.throws(
    () => op({ kind: "move", instanceId: container.id, spaceId: child }),
    /cycle/,
  );
  op({ kind: "select", ids: [original.id] });
  assert.deepEqual(store.context(b.id).selection, ["obj"]);
  assert.equal(store.context(b.id).focusedView?.id, "view-a");
  b = store.refresh(b.id, { ...p, objects: [] });
  assert.ok(b.instances.some((c) => c.id === original.id));
  assert.equal(store.context(b.id).objects.length, 0);
  assert.equal(store.context(b.id).instances[0].objectId, "obj");
});
test("non-code components, typed data validation and presets use the same spatial core", () => {
  const store = new BoardStore();
  let b = store.open({ ...p, objects: [] }, "research");
  const spaces = new Spaces(store);
  openView(store.get(b.id), "v");
  const op = (operation: any) => {
    b = spaces.update(b.id, store.get(b.id).revision, "v", operation);
    return b;
  };
  op({
    kind: "create",
    type: "board",
    title: "Comparison",
    data: { preset: "research" },
  });
  const container = b.instances.find((c) => c.type === "board")!;
  op({ kind: "navigate", spaceId: container.data.spaceId });
  assert.ok(
    b.instances.some(
      (c) => c.spaceId === container.data.spaceId && c.type === "chart",
    ),
  );
  op({
    kind: "create",
    type: "chart",
    title: "Measurements",
    data: {
      kind: "bar",
      points: [
        { label: "A", value: 2 },
        { label: "B", value: 4 },
      ],
    },
  });
  const chart = b.instances.at(-1)!;
  assert.throws(
    () =>
      op({
        kind: "update",
        instanceId: chart.id,
        data: { points: [{ label: "bad", value: NaN }] },
      }),
    /finite/,
  );
  op({ kind: "select", ids: [chart.id] });
  const context = store.context(b.id);
  assert.equal(context.objects.length, 0);
  assert.equal(context.instances[0].type, "chart");
  op({
    kind: "create",
    type: "unrecognized-type",
    title: "Preserved",
    data: { description: "Kept as data" },
  });
  assert.equal(b.instances.at(-1)!.type, "unrecognized-type");
});

test("containment cannot cycle even beyond twenty nested spaces", () => {
  const store = new BoardStore();
  let b = store.open({ ...p, objects: [] }, "deep");
  const spaces = new Spaces(store);
  openView(store.get(b.id), "v");
  const op = (operation: any) => {
    b = spaces.update(b.id, store.get(b.id).revision, "v", operation);
  };
  let first = "",
    last = "";
  for (let n = 0; n < 25; n++) {
    op({ kind: "create", type: "board", title: "Level " + n, data: {} });
    const entry = b.instances.find((i) => i.id === b.views.v.selection[0])!;
    if (n === 0) first = entry.id;
    last = String(entry.data.spaceId);
    op({ kind: "navigate", spaceId: last });
  }
  assert.throws(
    () => op({ kind: "move", instanceId: first, spaceId: last }),
    /cycle/,
  );
});

test("space activity works without code roots, validates instance location and becomes last-known", () => {
  let now = Date.now();
  const store = new BoardStore(() => now);
  let b = store.open({ ...p, objects: [], workspaces: [] }, "blank");
  const spaces = new Spaces(store),
    tools: Record<string, (args: any) => any> = {};
  registerSpaceTools((name, _description, shape, fn) => {
    tools[name] = (args) => fn(z.object(shape).parse(args));
  }, spaces);
  openView(store.get(b.id), "v");
  b = spaces.update(b.id, b.revision, "v", {
    kind: "create",
    type: "text",
    title: "Note",
    data: { text: "" },
  });
  const instance = b.instances.at(-1)!;
  const args = {
    boardId: b.id,
    agentId: "Unit probe",
    spaceId: "overview",
    instanceIds: [instance.id],
    task: "Arrange note",
    action: "Check data",
    state: "running",
  };
  assert.throws(
    () => tools.sand_report_space_activity({ ...args, spaceId: "missing" }),
    /actual space/,
  );
  b = tools.sand_report_space_activity(args);
  assert.equal(b.workspaces.length, 0);
  assert.equal(b.spaceActivities?.[0].stale, false);
  now = Date.now() + 61000;
  assert.equal(store.read(b.id).spaceActivities?.[0].stale, true);
  assert.equal(store.context(b.id).spaceActivities?.[0].stale, true);
});

test("appearance levels preserve source identity, expanded geometry and component data", () => {
  const store = new BoardStore();
  let b = store.open(p, "appearance");
  openView(store.get(b.id), "appearance-view");
  const spaces = new Spaces(store);
  const original = structuredClone(b.instances[0]);
  for (const detail of ["label", "icon", "full"] as const) {
    b = spaces.update(b.id, store.get(b.id).revision, "appearance-view", {
      kind: "update",
      instanceId: original.id,
      appearance: { detail },
    });
    const c = b.instances.find((c) => c.id === original.id)!;
    assert.deepEqual(c.rect, original.rect);
    assert.deepEqual(c.data, original.data);
    assert.equal(c.objectId, original.objectId);
    assert.equal(c.appearance?.detail, detail);
    assert.equal(c.appearance?.icon, undefined);
  }
});

test("builtin icons are fixed and custom icons are assigned only at creation", () => {
  const store = new BoardStore();
  let b = store.open(p, "icons");
  openView(store.get(b.id), "icons-view");
  const spaces = new Spaces(store);
  const op = (operation: any) =>
    (b = spaces.update(
      b.id,
      store.get(b.id).revision,
      "icons-view",
      operation,
    ));
  op({ kind: "create", type: "text", title: "Note", icon: "task" });
  const note = b.instances.at(-1)!;
  assert.equal(note.appearance?.icon, undefined);
  op({
    kind: "update",
    instanceId: note.id,
    appearance: { icon: "task", detail: "icon" },
  });
  assert.equal(
    b.instances.find((c) => c.id === note.id)?.appearance?.icon,
    undefined,
  );
  op({ kind: "create", type: "custom-example", title: "Custom", icon: "task" });
  const custom = b.instances.at(-1)!;
  assert.equal(custom.appearance?.icon, "task");
  op({
    kind: "update",
    instanceId: custom.id,
    appearance: { icon: "chart", detail: "label" },
  });
  assert.equal(
    b.instances.find((c) => c.id === custom.id)?.appearance?.icon,
    "task",
  );
});
