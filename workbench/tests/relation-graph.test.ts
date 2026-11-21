import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  applyCommands,
  CommandError,
  createRegistry,
  expandBindings,
  openWorkspaceDb,
  syncPacks,
  type Command,
} from "../kernel/index.ts";
import { builtinPacks } from "../packs/index.ts";

function setup(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "sand-relation-graph-"));
  const db = openWorkspaceDb(join(directory, "workspace.db"), {
    create: true,
    workspaceId: "graph-test",
  });
  t.after(() => {
    db.close();
    rmSync(directory, { force: true, recursive: true });
  });
  const registry = createRegistry();
  for (const pack of builtinPacks) registry.registerPack(pack, "builtin");
  const actor = { id: "test", kind: "human" } as const;
  syncPacks(db, registry, actor);
  const edit = (commands: Command[]) =>
    applyCommands(db, registry, { actor, commands });
  const expand = (objectId: string, slot = "focus") =>
    expandBindings(db, registry, { objectId, slot });
  return { edit, expand };
}

function create(ref: string, type = "base.note"): Command {
  return { op: "object.create", ref, type, title: ref };
}
function link(
  sourceId: string,
  targetId: string,
  kind = "base.related",
): Command {
  return { op: "relation.create", sourceId, targetId, kind };
}

test("只从内置关系图的中心展开，保留有向事实并按层去重", (t) => {
  const { edit, expand } = setup(t);
  const { created } = edit([
    create("graph", "base.relation_graph"),
    create("a"),
    create("b"),
    create("c"),
    create("outside"),
    link("@graph", "@a", "base.graph_focus"),
    link("@b", "@a"),
    link("@b", "@c", "base.depends_on"),
    link("@c", "@b"),
  ]);
  const { graph, a, b, c, outside } = created;
  const ids = (objectId: string) => expand(objectId).nodes.map(({ id }) => id);
  assert.deepEqual(ids(graph), [a, b]);
  assert.deepEqual(
    expand(graph).edges.map(({ sourceId, targetId }) => [sourceId, targetId]),
    [[b, a]],
  );
  const denied = (error: unknown) =>
    error instanceof CommandError && error.code === "FORBIDDEN";
  assert.throws(() => expand(outside), denied);
  assert.throws(() => expand(graph, "self"), denied);
  edit([{ op: "object.update", id: graph, set: { depth: 3 } }]);
  assert.deepEqual(ids(graph), [a, b, c]);
  assert.equal(expand(graph).edges.length, 3);
  assert.equal(expand(graph).truncated, false);
  edit([
    { op: "object.update", id: graph, set: { kinds: ["base.depends_on"] } },
  ]);
  assert.deepEqual(ids(graph), [a]);
  assert.deepEqual(expand(graph).edges, []);
  edit([{ op: "object.delete", id: graph }]);
  assert.throws(() => expand(graph), denied);
});

test("最多返回 200 个节点和 1000 条边，截断稳定且无悬空端点", (t) => {
  const { edit, expand } = setup(t);
  const { created } = edit([
    create("graph", "base.relation_graph"),
    create("center"),
    link("@graph", "@center", "base.graph_focus"),
  ]);
  for (let batch = 0; batch < 3; batch++)
    edit(
      Array.from({ length: 70 }, (_, i) => {
        const name = `row-${batch}-${i}`;
        return [create(name), link(created.center, `@${name}`)];
      }).flat(),
    );
  const first = expand(created.graph);
  assert.equal(first.nodes.length, 200);
  assert.equal(first.edges.length, 199);
  assert.equal(first.truncated, true);
  assert.deepEqual(first, expand(created.graph));
  for (let batch = 0; batch < 5; batch++)
    edit(
      Array.from({ length: 180 }, () =>
        link(created.center, first.nodes[1].id),
      ),
    );
  const dense = expand(created.graph);
  assert.equal(dense.edges.length, 1000);
  assert.equal(dense.truncated, true);
  const nodes = new Set(dense.nodes.map(({ id }) => id));
  assert.ok(
    dense.edges.every(
      ({ sourceId, targetId }) => nodes.has(sourceId) && nodes.has(targetId),
    ),
  );
});
