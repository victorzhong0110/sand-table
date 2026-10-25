import assert from "node:assert/strict";
import { test } from "node:test";
import {
  layoutHistory,
  type HistoryListEntry,
} from "../board/history-layout.ts";

function line(length: number, cursor: number): HistoryListEntry[] {
  return Array.from({ length }, (_, index) => {
    const seq = index + 1;
    return {
      id: `e${seq}`,
      parentId: seq === 1 ? null : `e${seq - 1}`,
      seq,
      current: seq === cursor,
      onCurrentPath: true,
    };
  });
}

test("四十条直线历史全部不缩进", () => {
  const rows = layoutHistory(line(40, 40), new Set());
  assert.equal(rows.length, 40);
  for (const row of rows) {
    assert.equal(row.kind, "entry");
    if (row.kind === "entry") assert.equal(row.indent, 0);
  }
});

test("撤销三步后再编辑，分叉处只有一个分支", () => {
  const entries: HistoryListEntry[] = [
    { id: "e1", parentId: null, seq: 1, current: false, onCurrentPath: true },
    { id: "e2", parentId: "e1", seq: 2, current: false, onCurrentPath: true },
    { id: "e3", parentId: "e2", seq: 3, current: false, onCurrentPath: true },
    { id: "e4", parentId: "e3", seq: 4, current: false, onCurrentPath: true },
    { id: "e5", parentId: "e4", seq: 5, current: false, onCurrentPath: false },
    { id: "e6", parentId: "e5", seq: 6, current: false, onCurrentPath: false },
    { id: "e7", parentId: "e6", seq: 7, current: false, onCurrentPath: false },
    { id: "e8", parentId: "e4", seq: 8, current: true, onCurrentPath: true },
  ];
  const collapsed = layoutHistory(entries, new Set());
  const marker = collapsed.find((row) => row.kind === "branches");
  assert.ok(marker && marker.kind === "branches");
  assert.equal(marker.atId, "e4");
  assert.equal(marker.count, 1);
  assert.equal(marker.expanded, false);
  assert.equal(
    collapsed.filter((row) => row.kind === "entry" && row.indent === 1).length,
    0,
  );
  const opened = layoutHistory(entries, new Set(["e4"]));
  const branch = opened.filter(
    (row) => row.kind === "entry" && row.state === "branch",
  );
  assert.deepEqual(
    branch.map((row) => (row.kind === "entry" ? row.id : "")),
    ["e5", "e6", "e7"],
  );
  for (const row of opened) {
    if (row.kind !== "entry") continue;
    assert.equal(row.indent, row.state === "branch" ? 1 : 0);
  }
});
