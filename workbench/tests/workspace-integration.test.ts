import test from "node:test";
import { once } from "node:events";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardStore } from "../core/store.ts";
import { WorkspaceStore } from "../core/workspace.ts";
import { workspacePort } from "../core/persistence.ts";
import { createWorkspaceManager } from "../server/workspaces.ts";
const empty = { objects: [], workspaces: [], relations: [] };
function setup(root: string) {
  const store = new BoardStore();
  store.attachPersistence(workspacePort(new WorkspaceStore(root)), "default");
  const b = store.open(empty, "Original");
  return { store, b: store.get(b.id) };
}
test("stale writers cannot overwrite another writer, including an automatic retry", async () => {
  const root = mkdtempSync(join(tmpdir(), "sand-conflict-"));
  try {
    const initial = setup(root);
    await initial.store.flushSave();
    const a = setup(root),
      b = setup(root);
    a.store.createContent(a.b, { type: "text", title: "A" }, "human");
    b.store.createContent(b.b, { type: "text", title: "B" }, "human");
    await a.store.flushSave();
    await assert.rejects(b.store.flushSave(), /另一个进程/);
    await assert.rejects(b.store.flushSave(), /另一个进程/);
    assert.deepEqual(
      new WorkspaceStore(root)
        .load("default")
        .workspace.objects.map((o) => o.title),
      ["A"],
    );
    assert.deepEqual(
      b.b.contentObjects.map((o) => o.title),
      ["B"],
      "unsaved edits remain available",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("real workspace host: create, switch, edit, rename, switch back and reopen", async () => {
  const root = mkdtempSync(join(tmpdir(), "sand-switch-"));
  try {
    const { store, b } = setup(root);
    await store.flushSave();
    const manager = createWorkspaceManager(store, root, "default");
    await manager.save(manager.create({ id: "novel", title: "Novel" }));
    await manager.switch("novel");
    assert.equal(
      store.boards.size,
      1,
      "previous workspace must not leak into snapshots",
    );
    const novel = [...store.boards.values()][0];
    assert.notEqual(novel.id, b.id);
    store.createContent(novel, { type: "text", title: "Character" }, "human");
    await manager.rename("novel", "Renamed");
    await store.flushSave();
    assert.equal(manager.open("novel").workspace.title, "Renamed");
    await manager.switch("default");
    assert.equal([...store.boards.values()][0].id, b.id);
    await manager.switch("novel");
    assert.equal(
      [...store.boards.values()][0].contentObjects[0].title,
      "Character",
    );
    await assert.rejects(manager.delete("novel"), /正在使用/);
    await store.flushSave();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("two real processes with the same baseline: second save is refused", async () => {
  const { spawn } = await import("node:child_process");
  const root = mkdtempSync(join(tmpdir(), "sand-two-process-"));
  const children: import("node:child_process").ChildProcess[] = [];
  try {
    const initial = setup(root);
    await initial.store.flushSave();
    const source = `import {BoardStore} from ${JSON.stringify(new URL("../core/store.ts", import.meta.url).href)};
      import {WorkspaceStore} from ${JSON.stringify(new URL("../core/workspace.ts", import.meta.url).href)};
      import {workspacePort} from ${JSON.stringify(new URL("../core/persistence.ts", import.meta.url).href)};
      const s=new BoardStore();s.attachPersistence(workspacePort(new WorkspaceStore(process.env.REVIEW_ROOT)),'default');
      const b=s.open({objects:[],relations:[],workspaces:[]},'Original');console.log('READY');
      process.stdin.once('data',async()=>{s.createContent(s.get(b.id),{type:'text',title:process.env.REVIEW_NAME},'human');
      try{await s.flushSave();console.log('SAVED')}catch{console.log('CONFLICT')}process.exit(0)});`;
    const make = (name: string) => {
      const child = spawn(
        process.execPath,
        ["--experimental-strip-types", "--input-type=module", "-e", source],
        {
          env: { ...process.env, REVIEW_ROOT: root, REVIEW_NAME: name },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      children.push(child);
      let output = "";
      child.stdout!.on("data", (data) => (output += data));
      return {
        child,
        ready: once(child.stdout!, "data"),
        output: () => output,
      };
    };
    const a = make("A"),
      b = make("B");
    await Promise.all([a.ready, b.ready]);
    const aExit = once(a.child, "exit");
    a.child.stdin!.write("save");
    await aExit;
    const bExit = once(b.child, "exit");
    b.child.stdin!.write("save");
    await bExit;
    assert.match(a.output(), /SAVED/);
    assert.match(b.output(), /CONFLICT/);
    assert.deepEqual(
      new WorkspaceStore(root)
        .load("default")
        .workspace.objects.map((o) => o.title),
      ["A"],
    );
  } finally {
    for (const child of children) child.kill();
    rmSync(root, { recursive: true, force: true });
  }
});

test("attach retains the exact loaded baseline, not a later disk version", async () => {
  const root = mkdtempSync(join(tmpdir(), "sand-attach-baseline-"));
  try {
    const initial = setup(root);
    await initial.store.flushSave();
    const disk = new WorkspaceStore(root);
    const loaded = disk.load("default").workspace;
    const writer = setup(root);
    writer.store.createContent(
      writer.b,
      { type: "text", title: "newer" },
      "human",
    );
    await writer.store.flushSave();
    const old = new BoardStore();
    old.restore(loaded);
    old.attachPersistence(workspacePort(disk, loaded), "default");
    await assert.rejects(old.flushSave(), /另一个进程/);
    assert.equal(disk.load("default").workspace.objects[0].title, "newer");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
