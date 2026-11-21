import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createRegistry,
  migrateData,
  type ObjectRow,
} from "../kernel/index.ts";
import { basePack } from "../packs/base/index.ts";
import {
  chartOf,
  initialMapping,
  seriesFor,
} from "../board/data/chart-config.ts";
import { pasteCells } from "../board/data/paste.ts";
import { reinterpretColumn, tableOf } from "../board/data/table-model.ts";

const row = (type: string, data: Record<string, unknown>): ObjectRow => ({
  id: "old",
  type,
  typeVersion: 1,
  title: "原作品",
  data,
  source: null,
  version: 1,
  createdAt: 0,
  createdBy: "human",
  updatedAt: 0,
  updatedBy: "human",
  rev: 0,
  deleted: false,
});
test("旧表格无损迁移：数字推断、空串、布尔、日期和超出列名的单元格", () => {
  const registry = createRegistry();
  registry.registerPack(basePack, "builtin");
  const legacy = {
    columns: ["数量", "混合", "日期"],
    rows: [
      ["8", true, "2026-11-20", "无列名的原值"],
      ["", "007", null],
    ],
  };
  const result = migrateData(registry, row("base.table", legacy));
  assert.equal(result.typeVersion, 2, result.error);
  const saved = tableOf(result.data);
  assert.deepEqual(
    saved.columns.map((item) => item.type),
    ["number", "text", "text", "text"],
  );
  assert.deepEqual(
    saved.rows.map(({ cells }) => cells),
    [
      { c1: 8, c2: true, c3: "2026-11-20", c4: "无列名的原值" },
      { c1: "", c2: "007", c3: null, c4: null },
    ],
  );
  assert.deepEqual(legacy.rows[0], ["8", true, "2026-11-20", "无列名的原值"]);
  const oldChart = migrateData(
    registry,
    row("base.chart", { kind: "line", points: [{ label: "原点", value: 3 }] }),
  );
  assert.equal(oldChart.typeVersion, 2, oldChart.error);
  assert.equal(
    seriesFor(chartOf(oldChart.data)).series[0].values[0].value[1],
    3,
  );
});

test("粘贴时扩行，类型转换保留非法值，图表跳过缺值", () => {
  const table = pasteCells(
    {
      columns: [
        { key: "x", label: "组别", type: "text" },
        { key: "y", label: "数值", type: "number", unit: "次" },
      ],
      rows: [],
    },
    "甲\t7\r\n乙\t\r\n丙\t错误",
    0,
    0,
  );
  assert.deepEqual(
    table.rows.map(({ cells }) => cells.y),
    [7, null, "错误"],
  );
  assert.equal(reinterpretColumn(table, "y", "date").invalid, 2);
  assert.deepEqual(initialMapping(table.columns.slice(0, 1)), {
    x: "x",
    y: [],
  });
  const chart = seriesFor({ kind: "line" }, table);
  assert.deepEqual(
    chart.series[0].values.map(({ value }) => value[1]),
    [7, null, null],
  );
  assert.deepEqual(chart.categories, ["甲", "乙", "丙"]);
});
