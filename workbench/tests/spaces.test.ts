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
