import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readConnection,
  writeConnection,
  removeConnection,
  validateConnection,
} from "../local/session.ts";
test("local connection descriptor stays private, rejects external targets and cannot overwrite an active descriptor", () => {
  const dir = mkdtempSync(join(tmpdir(), "sand-session-unit-")),
    file = join(dir, "connection.json");
  const c = {
    url: "http://127.0.0.1:4317/",
    token: "a".repeat(48),
    pid: 123,
    startedAt: Date.now(),
  };
  try {
    writeConnection(file, c);
    /* The descriptor carries the link a human can paste, and the token never
       leaks into `url`. */
    assert.deepEqual(readConnection(file), {
      ...c,
      link: "http://127.0.0.1:4317/#session=" + c.token,
    });
    assert.equal(readConnection(file).url, "http://127.0.0.1:4317/");
    assert.throws(() => writeConnection(file, c));
    assert.throws(() =>
      validateConnection({ ...c, url: "https://external.example/" }),
    );
    assert.throws(() =>
      validateConnection({ ...c, url: "http://127.0.0.1:4317/redirect" }),
    );
    assert.throws(() =>
      validateConnection({
        ...c,
        link: "http://127.0.0.1:4317/#session=wrong",
      }),
    );
    assert.throws(() =>
      validateConnection({
        ...c,
        link: "http://127.0.0.1:4317/#session=" + "b".repeat(48),
      }),
    );
    if (process.getuid) {
      chmodSync(file, 0o644);
      assert.throws(() => readConnection(file), /private/);
      chmodSync(file, 0o600);
    }
    removeConnection(file, "different-token");
    assert.ok(readFileSync(file));
    removeConnection(file, c.token);
    assert.throws(() => readConnection(file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
