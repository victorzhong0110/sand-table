import assert from "node:assert/strict";
import { test } from "node:test";
import {
  commitNumberDraft,
  formatValue,
  hasValue,
  imageDataUrl,
  listEditorKind,
  nextListItem,
  parseNumberDraft,
  parseScalar,
  summaryLines,
  type JsonSchema,
} from "../board/views/format.ts";
import { planLinkedComponent } from "../board/views/actions.ts";
import { selectionForShortcut } from "../board/canvas/selection.ts";

const age: JsonSchema = {
  type: "integer",
  "x-sand-label": "年龄",
  "x-sand-widget": "integer",
  "x-sand-unit": "岁",
};
const role: JsonSchema = {
  type: "string",
  enum: ["lead", "support"],
  "x-sand-label": "定位",
  "x-sand-enum-labels": { lead: "主角", support: "配角" },
};
const traits: JsonSchema = {
  type: "array",
  items: { type: "string" },
  "x-sand-label": "性格",
  "x-sand-widget": "tags",
};
const nested: JsonSchema = {
  type: "object",
  properties: {
    name: { type: "string", "x-sand-label": "方案名称" },
    body: { type: "string", "x-sand-label": "方案内容" },
  },
};

test("没填的不显示，0 和枚举、列表按声明显示", () => {
  assert.equal(hasValue(undefined), false);
  assert.equal(hasValue(0), true);
  assert.equal(formatValue(undefined, age), "");
  assert.equal(formatValue(0, age), "0 岁");
  assert.equal(formatValue(30, age), "30 岁");
  assert.equal(formatValue("lead", role), "主角");
  assert.equal(formatValue(["冷静", "固执"], traits), "冷静、固执");
  assert.equal(
    formatValue({ name: "甲", body: "先做" }, nested),
    "方案名称 甲，方案内容 先做",
  );
  assert.equal(
    String({ name: "甲" }) === formatValue({ name: "甲" }, nested),
    false,
  );
  const lines = summaryLines(
    { role: "lead", age: 0 },
    ["role", "age", "goal"],
    {
      role,
      age,
      goal: { type: "string", "x-sand-label": "动机" },
    },
  );
  assert.deepEqual(
    lines.map((line) => `${line.label} ${line.text}`),
    ["定位 主角", "年龄 0 岁"],
  );
});

const cell: JsonSchema = {
  anyOf: [
    { type: "string" },
    { type: "number" },
    { type: "boolean" },
    { type: "null" },
  ],
};
const row: JsonSchema = { type: "array", items: cell };
const tableRows: JsonSchema = {
  type: "array",
  items: row,
  "x-sand-label": "数据",
  "x-sand-widget": "table",
};

test("表格行保持数组的数组，数字格不被拆成标签", () => {
  assert.equal(listEditorKind(tableRows), "nested");
  assert.equal(listEditorKind(traits), "tags");
  assert.equal(parseScalar("1", cell), 1);
  assert.equal(parseScalar("a", cell), "a");
  assert.equal(parseScalar("true", cell), true);
  const editedRow = nextListItem(["a", 1], 1, parseScalar("3", cell), cell);
  assert.deepEqual(editedRow, ["a", 3]);
  assert.deepEqual(
    nextListItem(
      [
        ["a", 1],
        ["b", 2],
      ],
      0,
      editedRow,
      row,
    ),
    [
      ["a", 3],
      ["b", 2],
    ],
  );
  assert.equal(
    formatValue(
      [
        ["a", 1],
        ["b", 2],
      ],
      tableRows,
    ),
    "2 行 × 2 列",
  );
  assert.equal(
    formatValue([["a", 1]], tableRows).includes("[object Object]"),
    false,
  );
});

test("没写完的数字先留在草稿里", () => {
  assert.deepEqual(parseNumberDraft("0.", false), {
    complete: false,
    value: undefined,
  });
  assert.deepEqual(parseNumberDraft("-", false), {
    complete: false,
    value: undefined,
  });
  assert.deepEqual(parseNumberDraft("0.5", false), {
    complete: true,
    value: 0.5,
  });
  assert.deepEqual(parseNumberDraft("30", true), { complete: true, value: 30 });
  assert.equal(commitNumberDraft("0.", false), 0);
  assert.equal(commitNumberDraft("-", false), undefined);
  assert.equal(commitNumberDraft("", true), undefined);
});

test("封面附件能认出图片，读失败时没有可用地址", () => {
  assert.equal(
    imageDataUrl("data:application/octet-stream;base64,iVBORw0KGgo="),
    "data:image/png;base64,iVBORw0KGgo=",
  );
  assert.equal(imageDataUrl("data:text/plain;base64,aGVsbG8="), undefined);
  assert.equal(imageDataUrl(""), undefined);
});

test("清掉的选区不再退回服务器上的旧选区", () => {
  assert.deepEqual(selectionForShortcut([], ["card-a"], ["card-a"]), []);
  assert.deepEqual(selectionForShortcut(["card-b"], ["card-a"], ["card-a"]), [
    "card-b",
  ]);
  assert.deepEqual(selectionForShortcut(null, ["card-a"], ["card-b"]), [
    "card-a",
  ]);
  assert.deepEqual(selectionForShortcut(null, [], ["card-b"]), ["card-b"]);
});

test("新建关联对象前先核对类型和版本", () => {
  const specs = new Map([
    ["novel.character", { type: "novel.character", title: "人物" }],
  ]);
  const missing = planLinkedComponent({
    sourceId: "event",
    type: "novel.scene",
    title: "场景",
    relationKind: "novel.participates",
    direction: "in",
    specs,
  });
  assert.equal(missing.ok, false);
  const stale = planLinkedComponent({
    sourceId: "event",
    sourceVersion: 4,
    expectedVersion: 3,
    type: "novel.character",
    title: "林",
    relationKind: "novel.participates",
    direction: "in",
    specs,
  });
  assert.equal(stale.ok, false);
  const plan = planLinkedComponent({
    sourceId: "event",
    sourceVersion: 3,
    expectedVersion: 3,
    type: "novel.character",
    title: "林",
    relationKind: "novel.participates",
    direction: "in",
    specs,
  });
  assert.equal(plan.ok, true);
  if (plan.ok) {
    assert.equal(plan.commands[0]?.op, "object.create");
    assert.equal(plan.commands[1]?.op, "relation.create");
    assert.equal((plan.commands[1] as { targetId?: string }).targetId, "event");
  }
});
