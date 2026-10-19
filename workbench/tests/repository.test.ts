import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { bind, scan, sourceFor, readFile } from "../server/repository.ts";
test("actual dirty contents invalidate source while HEAD stays unchanged; worktrees have distinct identities", () => {
  const root = mkdtempSync(join(tmpdir(), "sand-unit-")),
    other = root + "-worktree";
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
  try {
    git("init");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.invalid");
    writeFileSync(
      join(root, "index.ts"),
      "export function value(){return 1;}\n",
    );
    git("add", ".");
    git("commit", "-m", "fixture");
    git("worktree", "add", "-b", "other", other);
    const bindings = bind([`one=${root}`, `two=${other}`]);
    assert.notEqual(bindings[0].id, bindings[1].id);
    const before = scan(bindings);
    const item = before.objects.find((o) => o.kind === "symbol")!;
    assert.match(sourceFor(bindings, item).text, /return 1/);
    writeFileSync(
      join(root, "index.ts"),
      "export function value(){return 2;}\n",
    );
    const after = scan(bindings);
    assert.equal(before.workspaces[0].head, after.workspaces[0].head);
    assert.notEqual(
      before.workspaces[0].snapshot,
      after.workspaces[0].snapshot,
    );
    assert.equal(item.id, after.objects.find((o) => o.kind === "symbol")!.id);
    assert.throws(() => sourceFor(bindings, item), /changed/);
    assert.throws(() => readFile(bindings[0], "../outside"));
    symlinkSync("/etc/passwd", join(root, "link.ts"));
    assert.throws(() => readFile(bindings[0], "link.ts"), /Symlink/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});
