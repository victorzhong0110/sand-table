import assert from "node:assert/strict";
import { test } from "node:test";
import {
  axisLabel,
  axisPosition,
  axisValue,
  layoutTimeline,
  timelineTicks,
} from "../board/timeline/scale.ts";
import { timelineFields } from "../board/timeline/fields.ts";

test("时间维度仅列出公开的数值和日期字段", () => {
  assert.deepEqual(
    timelineFields({
      type: "test.event",
      title: "示例事件",
      schema: {
        properties: {
          order: { "x-sand-widget": "integer", "x-sand-label": "事件顺序" },
          date: { "x-sand-widget": "date" },
          contentVersion: { "x-sand-widget": "integer", "x-sand-hidden": true },
          storyTime: { "x-sand-widget": "text" },
        },
      },
    }),
    [
      { kind: "number", field: "order", label: "事件顺序" },
      { kind: "date", field: "date", label: "date" },
    ],
  );
});

test("时间轴数值与 ISO 日期严格按所选维度读取", () => {
  assert.equal(axisValue("3", "number"), undefined);
  assert.equal(axisValue(3, "date"), undefined);
  assert.equal(axisValue("三年前的冬天", "date"), undefined);
  assert.equal(axisValue("2025-02-29", "date"), undefined);
  const leap = axisValue("2024-02-29", "date")!;
  assert.equal(axisLabel(leap, "date"), "2024-02-29");
  assert.equal(axisValue("2024-03-01", "date")! - leap, 1);
});
test("点、区间、缺值、非法值和倒序区间都有确定位置和提示", () => {
  const items = [
    { id: "b", data: { order: 3, end: 4 } },
    { id: "a", data: { order: 1 } },
    { id: "c", data: {} },
    { id: "d", data: { order: 8, end: 7 } },
    { id: "e", data: { order: "2" } },
  ].map((item) => ({ ...item, title: item.id, type: "novel.event" }));
  const result = layoutTimeline(items, {
    kind: "number",
    field: "order",
    endField: "end",
    label: "顺序",
  });
  assert.deepEqual(
    result.placed.map(({ item, start, end }) => [item.id, start, end]),
    [
      ["a", 1, undefined],
      ["b", 3, 4],
    ],
  );
  assert.deepEqual(
    result.unsorted.map(({ item }) => item.id),
    ["c", "d", "e"],
  );
  assert.match(result.unsorted[1].reason, /早于/);
  assert.equal(axisPosition(3, result.low, result.high), 2 / 3);
});
test("刻度有限且覆盖极端数值，单一时间点居中", () => {
  assert.deepEqual(timelineTicks(0, 25, "number"), [0, 5, 10, 15, 20, 25]);
  assert.deepEqual(timelineTicks(8, 8, "number"), [8]);
  assert.equal(axisPosition(8, 8, 8), 0.5);
  assert.equal(axisPosition(0, -Number.MAX_VALUE, Number.MAX_VALUE), 0.5);
  assert.deepEqual(timelineTicks(1, 3, "date"), [1, 2, 3]);
});
