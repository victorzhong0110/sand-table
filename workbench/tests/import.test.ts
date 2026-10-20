import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { BoardStore } from "../core/store.ts";
import { openView } from "../core/space-state.ts";
import { registerRepositoryImport } from "../server/import.ts";
import { scan, type Binding } from "../server/repository.ts";
test(
  "explicit external import nests a scene and invalid import leaves the blank board untouched",
  { skip: !process.env.SAND_EXTERNAL_REPO },
  () => {
    const store = new BoardStore(),
      bindings: Binding[] = [],
      tools: Record<string, (a: any) => any> = {};
    registerRepositoryImport(
      (name, _description, shape, fn) => {
        tools[name] = (a) => fn(z.object(shape).parse(a));
      },
      store,
      bindings,
    );
    const opened = store.open(
        { workspaces: [], objects: [], relations: [] },
        "Blank",
      ),
      b = store.get(opened.id);
    b.presentation = "canvas";
    b.autoProjectSources = false;
    openView(b, "human");
    assert.throws(() =>
      tools.sand_import_repository({
        boardId: b.id,
        revision: b.revision,
        viewId: "human",
        path: "/no-such-sand-table-repository",
      }),
    );
    assert.equal(bindings.length, 0);
    assert.equal(b.instances.length, 0);
    const imported = tools.sand_import_repository({
      boardId: b.id,
      revision: b.revision,
      viewId: "human",
      path: process.env.SAND_EXTERNAL_REPO,
    });
    assert.equal(bindings.length, 1);
    assert.equal(imported.workspaces.length, 1);
    assert.equal(
      imported.instances.filter((i: any) => i.spaceId === "overview").length,
      1,
    );
    const entry = imported.instances.find((i: any) => i.spaceId === "overview");
    assert.equal(entry.type, "board");
    assert.ok(
      imported.instances.some(
        (i: any) => i.type === "object" && i.spaceId !== "overview",
      ),
    );
    const count = imported.instances.length;
    store.refresh(b.id, scan(bindings));
    assert.equal(
      store.read(b.id).instances.length,
      count,
      "Refresh never repopulates the blank root.",
    );
    assert.equal(store.context(b.id).focusedView?.spaceId, entry.data.spaceId);
  },
);
