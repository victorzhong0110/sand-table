import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatValue,
  hasValue,
  summaryLines,
  type JsonSchema,
} from "../board/views/format.ts";
import { planLinkedComponent } from "../board/views/actions.ts";

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
