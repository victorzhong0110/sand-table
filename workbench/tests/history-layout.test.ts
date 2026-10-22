import { test } from "node:test";
import assert from "node:assert/strict";
import { indentOf } from "../board/history-layout.ts";
test("a long run of edits stays on one left edge", () => {
  const records = Array.from({ length: 40 }, () => ({ branch: false }));
  for (const record of records) assert.equal(indentOf(record), 0);
});
test("a superseded branch is indented one step", () => {
  assert.equal(indentOf({ branch: true }), 1);
  assert.equal(indentOf({}), 0);
});
