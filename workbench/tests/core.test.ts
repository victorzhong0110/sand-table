import { test } from "node:test";
import assert from "node:assert/strict";
import { BoardStore } from "../core/store.ts";
import type { Projection } from "../core/model.ts";
const p: Projection = {
  workspaces: [
    {
      id: "w",
      label: "w",
      head: "h",
      branch: "b",
      snapshot: "s",
      files: 1,
      omitted: [],
    },
  ],
  objects: ["a", "b"]
    .map((id) => ({ id, workspaceId: "w", kind: "symbol" }) as const)
    .map((o) => ({ ...o, title: o.id })),
  relations: [],
};
test("arrangement is shared context with revision, identity and pin constraints", () => {
  const s = new BoardStore();
  let b = s.open(p, "test");
  b = s.edit(b.id, b.revision, {
    selection: ["a", "b"],
    group: { title: "Path", objectIds: ["a", "b"] },
    placements: { a: { x: 1, y: 2, pinned: true } },
    note: { objectId: "a", text: "Explain this" },
  });
  assert.throws(() => s.edit(b.id, 0, { selection: [] }));
  assert.throws(() =>
    s.edit(b.id, b.revision, {
      placements: { a: { x: 8, y: 2, pinned: false } },
    }),
  );
  const c = s.context(b.id);
  assert.equal(c.notes.a, "Explain this");
  assert.equal(c.groups.length, 1);
  assert.match(c.authority, /not permission/);
  assert.throws(() =>
    s.report(b.id, {
      agentId: "agent",
      workspaceId: "another",
      objectIds: ["a"],
      task: "task",
      action: "read",
      state: "running",
    }),
  );
});
test("expiry, activity staleness and independent boards", () => {
  let now = 0;
  const s = new BoardStore(() => now, 120000);
  const a = s.open(p, "a"),
    b = s.open(p, "b");
  s.edit(a.id, 0, { selection: ["a"] });
  assert.deepEqual(s.read(b.id).selection, []);
  s.report(a.id, {
    agentId: "test",
    workspaceId: "w",
    objectIds: ["a"],
    task: "inspect",
    action: "reading",
    state: "waiting",
  });
  now = 61000;
  assert.equal(s.read(a.id).activities[0].stale, true);
  s.refresh(a.id, { ...p, objects: [] });
  assert.equal(s.read(a.id).activities[0].state, "unknown");
  s.end(a.id);
  assert.throws(() => s.read(a.id));
  now = 200000;
  s.sweep();
  assert.equal(s.boards.size, 0);
});
