import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compareBoundTables,
  compareTables,
  compareText,
} from "../board/compare/diff.ts";
import type { TableData } from "../board/data/table-model.ts";

test("文字比较对齐共同的行，并标出行内的增删", () => {
  const result = compareText(
    "共同\n第一个版本\n结尾",
    "共同\n第二个版本\n新增\n结尾",
    true,
  );
  assert.deepEqual(
    result.rows.map(({ left, right, changed }) => [
      left?.number,
      right?.number,
      changed,
    ]),
    [
      [1, 1, false],
      [2, 2, true],
      [undefined, 3, true],
      [3, 4, false],
    ],
  );
  assert.ok(result.rows[1].left?.pieces?.some(({ changed }) => changed));
  assert.ok(result.rows[1].right?.pieces?.some(({ changed }) => changed));
});

test("代码比较保留双侧行号和行尾，超长内容可回退原文", () => {
  const result = compareText(
    "let x = 1;\n\nreturn x;\n",
    "let x = 1;\nreturn x;",
    false,
  );
  assert.deepEqual(
    result.rows.map(({ left, right }) => [left?.text, right?.text]),
    [
      ["let x = 1;\n", "let x = 1;\n"],
      ["\n", "return x;"],
      ["return x;\n", undefined],
    ],
  );
  assert.match(
    compareText("a".repeat(20_001), "", true).unsupported ?? "",
    /超过/,
  );
});

test("表格按行列 key 对齐，保留真空值与缺失的区别", () => {
  const left: TableData = {
    columns: [
      { key: "x", label: "旧名称", type: "text" },
      { key: "y", label: "删列", type: "number" },
    ],
    rows: [
      { key: "keep", cells: { x: "甲", y: null } },
      { key: "drop", cells: { x: "乙", y: 1 } },
    ],
  };
  const right: TableData = {
    columns: [
      { key: "z", label: "新列", type: "number" },
      { key: "x", label: "新名称", type: "text" },
    ],
    rows: [
      { key: "add", cells: { x: "丙", z: 0 } },
      { key: "keep", cells: { x: "丁", z: 2 } },
    ],
  };
  const result = compareTables(left, right);
  assert.deepEqual(
    result.columns.map(({ key, changed }) => [key, changed]),
    [
      ["x", true],
      ["y", true],
      ["z", true],
    ],
  );
  assert.deepEqual(
    result.rows.map(({ key, presence }) => [key, presence]),
    [
      ["keep", "both"],
      ["drop", "removed"],
      ["add", "added"],
    ],
  );
  assert.deepEqual(
    result.rows[0].cells.map(({ left, right, changed }) => [
      left,
      right,
      changed,
    ]),
    [
      ["甲", "丁", true],
      [null, undefined, true],
      [undefined, 2, true],
    ],
  );
  assert.equal(result.rows[2].cells.find((cell) => cell.key === "z")?.right, 0);
});

test("固定的旧表格版本通过按需比较资源保留行列身份", () => {
  const result = compareBoundTables(
    { typeVersion: 1, data: { columns: ["数量"], rows: [["3"]] } },
    {
      typeVersion: 2,
      data: {
        columns: [{ key: "c1", label: "数量", type: "number" }],
        rows: [{ key: "r1", cells: { c1: 4 } }],
      },
    },
  );
  assert.deepEqual(result.rows[0], {
    key: "r1",
    presence: "both",
    cells: [{ key: "c1", left: 3, right: 4, changed: true }],
  });
});
