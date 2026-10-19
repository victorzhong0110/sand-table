import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  chmodSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { BoardStore } from "../core/store.ts";
import { Changes } from "../server/changes.ts";
import { bind, scan } from "../server/repository.ts";
import { currentFile } from "../server/worktree.ts";
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "sand-change-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
  git("init");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "b.ts"), "export const b = 1;\n");
  git("add", ".");
  git("commit", "-m", "fixture");
  const bindings = bind([`unit=${root}`]),
    store = new BoardStore(),
    b = store.open(scan(bindings), "test"),
    changes = new Changes(store, bindings),
    workspaceId = bindings[0].id;
  return {
    root,
    store,
    b,
    changes,
    workspaceId,
    bindings,
    clean: () => rmSync(root, { recursive: true, force: true }),
  };
}
test("exact proposal confirmation, partial application, scope deviations and content-bound verification", () => {
  const f = fixture();
  try {
    const refs = ["a.ts", "b.ts"].map((path) => ({
      workspaceId: f.workspaceId,
      path,
    }));
    let b = f.changes.createIntent(f.b.id, 0, {
      request: "Change both exported values to 2",
      objectIds: [],
      allowedFiles: refs,
    });
    const i = b.intents[0];
    const draft = {
      intentId: i.id,
      intentVersion: i.version,
      agentId: "unit host",
      title: "Two values",
      explanation: "Unit test proposal",
      testPlan: "Check exported values",
      files: refs.map((r, n) => ({
        ...r,
        beforeHash: currentFile(f.bindings, r).hash,
        after: `export const ${n ? "b" : "a"} = 2;\n`,
      })),
    };
    const p = f.changes.publish(b.id, draft);
    assert.equal(
      readFileSync(join(f.root, "a.ts"), "utf8"),
      "export const a = 1;\n",
    );
    assert.throws(
      () => f.changes.prepare(b.id, p.id, p.version, p.digest),
      /not been accepted/,
    );
    assert.throws(
      () => f.changes.decide(b.id, p.id, p.version, "wrong", "accepted"),
      /changed/,
    );
    f.changes.decide(b.id, p.id, p.version, p.digest, "accepted");
    assert.equal(
      f.changes.prepare(b.id, p.id, p.version, p.digest).ready,
      true,
    );
    // The test stands in for the host; Sand Table itself never writes the proposal.
    writeFileSync(join(f.root, "a.ts"), draft.files[0].after!);
    let result = f.changes.observe(b.id, f.changes.proposal(b.id, p.id).p);
    assert.equal(result.state, "partial");
    writeFileSync(join(f.root, "b.ts"), draft.files[1].after!);
    result = f.changes.observe(b.id, f.changes.proposal(b.id, p.id).p);
    assert.equal(result.state, "matches");
    writeFileSync(join(f.root, "outside.md"), "unexpected host change");
    result = f.changes.observe(b.id, f.changes.proposal(b.id, p.id).p);
    assert.equal(result.state, "diverged");
    assert.ok(result.outsideChanges.some((r) => r.path === "outside.md"));
  } finally {
    f.clean();
  }
});
test("dirty contents, revised intentions and replacement proposals invalidate earlier acceptance", () => {
  const f = fixture();
  try {
    const ref = { workspaceId: f.workspaceId, path: "a.ts" };
    let b = f.changes.createIntent(f.b.id, 0, {
      request: "Change a",
      objectIds: [],
      allowedFiles: [ref],
    });
    const i = b.intents[0],
      before = currentFile(f.bindings, ref);
    const draft = {
      intentId: i.id,
      intentVersion: 1,
      agentId: "unit",
      title: "Change",
      explanation: "Test",
      testPlan: "Unit",
      files: [
        { ...ref, beforeHash: before.hash, after: "export const a = 2;\n" },
      ],
    };
    assert.throws(
      () =>
        f.changes.publish(b.id, {
          ...draft,
          files: [{ ...draft.files[0], path: "b.ts" }],
        }),
      /outside/,
    );
    const p = f.changes.publish(b.id, draft);
    f.changes.decide(b.id, p.id, 1, p.digest, "accepted");
    const second = f.changes.publish(b.id, {
      ...draft,
      proposalId: p.id,
      previousVersion: 1,
      files: [{ ...draft.files[0], after: "export const a = 3;\n" }],
    });
    assert.equal(second.decision, "pending");
    assert.notEqual(second.digest, p.digest);
    assert.throws(() => f.changes.prepare(b.id, p.id, 1, p.digest), /changed/);
    writeFileSync(join(f.root, "a.ts"), "export const a = 9;\n");
    assert.throws(
      () => f.changes.decide(b.id, p.id, 2, second.digest, "accepted"),
      /changed/,
    );
    assert.throws(() => f.changes.publish(b.id, draft), /Stale/);
    b = f.store.read(b.id);
    f.changes.createIntent(b.id, b.revision, {
      intentId: i.id,
      request: "Different request",
      objectIds: [],
      allowedFiles: [ref],
    });
    assert.throws(() => f.changes.publish(b.id, draft), /Intent changed/);
  } finally {
    f.clean();
  }
});

test("create/delete targets and file modes retain actual baselines", () => {
  const f = fixture();
  try {
    const refs = ["new.ts", "a.ts"].map((path) => ({
      workspaceId: f.workspaceId,
      path,
    }));
    let b = f.changes.createIntent(f.b.id, 0, {
      request: "Create new and delete old",
      objectIds: [],
      allowedFiles: refs,
    });
    const draft = {
      intentId: b.intents[0].id,
      intentVersion: 1,
      agentId: "unit",
      title: "Create/delete",
      explanation: "Unit",
      testPlan: "Unit",
      files: [
        { ...refs[0], beforeHash: null, after: "export const n=1;" },
        {
          ...refs[1],
          beforeHash: currentFile(f.bindings, refs[1]).hash,
          after: null,
        },
      ],
    };
    const p = f.changes.publish(b.id, draft);
    f.changes.decide(b.id, p.id, 1, p.digest, "accepted");
    writeFileSync(join(f.root, "new.ts"), draft.files[0].after!);
    unlinkSync(join(f.root, "a.ts"));
    assert.equal(
      f.changes.observe(b.id, f.changes.proposal(b.id, p.id).p).state,
      "matches",
    );
    b = f.store.read(b.id);
    b = f.changes.createIntent(b.id, b.revision, {
      request: "Different intent",
      objectIds: [],
      allowedFiles: [refs[0]],
    });
    assert.throws(
      () =>
        f.changes.publish(b.id, {
          ...draft,
          intentId: b.intents[1].id,
          proposalId: p.id,
          previousVersion: 1,
          files: [
            {
              ...refs[0],
              beforeHash: currentFile(f.bindings, refs[0]).hash,
              after: "different",
            },
          ],
        }),
      /another intent/,
    );
    const q = f.changes.publish(b.id, {
      ...draft,
      intentId: b.intents[1].id,
      files: [
        {
          ...refs[0],
          beforeHash: currentFile(f.bindings, refs[0]).hash,
          after: "export const n=2;",
        },
      ],
    });
    chmodSync(join(f.root, "new.ts"), 0o755);
    assert.equal(
      f.changes.observe(b.id, f.changes.proposal(b.id, q.id).p).state,
      "diverged",
    );
  } finally {
    f.clean();
  }
});
