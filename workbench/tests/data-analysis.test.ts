import assert from "node:assert/strict";
import { test } from "node:test";
import { compileFormula, FormulaError } from "../board/data/formula.ts";
import { formatCsv, parseCsv } from "../board/data/csv.ts";
import {
  deriveTable,
  resolveFormulaColumn,
} from "../board/data/derive-table.ts";
import type { Cell, TableData } from "../board/data/table-model.ts";

function calculate(formula: string, cells: Record<string, Cell> = {}) {
  return compileFormula(formula).run((key) => {
    if (!Object.hasOwn(cells, key))
      throw new FormulaError(`列 ${key} 不存在。`);
    return cells[key];
  });
}

test("四则优先级、括号、符号及使用稳定列 key 的公式", () => {
  assert.equal(calculate(" 2 + 3 * -(1 + 4) "), -13);
  assert.equal(calculate("1e2 / 2 + .5"), 50.5);
  const keys = new Map([
    ["单价", "price"],
    ["数]量", "quantity"],
  ]);
  const compiled = compileFormula("=[单价] * [数]]量]", (label) =>
    keys.get(label)!,
  );
  assert.equal(compiled.source, "[price]*[quantity]");
  assert.deepEqual(compiled.dependencies, ["price", "quantity"]);
  assert.equal(calculate(compiled.source, { price: 2.5, quantity: 5 }), 12.5);
});

test("聚合忽略空值，COUNT 计非空，IF 只计算当前分支", () => {
  const cells = { a: 4, b: null, c: 2 };
  assert.equal(calculate("SUM([a],[b],[c])", cells), 6);
  assert.equal(calculate("AVG([a],[b],[c])", cells), 3);
  assert.equal(calculate("MIN([a],[b],[c])", cells), 2);
  assert.equal(calculate("MAX([a],[b],[c])", cells), 4);
  assert.equal(calculate("COUNT([a],[b],[c],1=2)", cells), 3);
  assert.equal(calculate("IF([a]>=3,ROUND(-1.25,1),1/0)", cells), -1.3);
  assert.equal(calculate("IF(1<>1,[不存在],7)"), 7);
});

test("公式错误保留具体原因，拒绝任意代码和过长或过深的表达式", () => {
  assert.throws(() => calculate("[a]*[b]", { a: 3, b: null }), /为空/);
  assert.throws(() => calculate("[a]+1", { a: "2" }), /数字类型/);
  assert.throws(() => calculate("[a]+[missing]", { a: 2 }), /不存在/);
  assert.throws(() => calculate("10/0"), /除以零/);
  assert.throws(() => calculate("1e999"), /数值|数字/);
  assert.throws(() => calculate("AVG([a])", { a: null }), /没有可求平均/);
  assert.throws(() => calculate("IF(1,2,3)"), /真或假/);
  assert.throws(() => calculate("globalThis.process.exit()"), /无法识别/);
  assert.throws(
    () => calculate("(".repeat(33) + "1" + ")".repeat(33)),
    /32 层/,
  );
  assert.throws(() => calculate("1+".repeat(1001) + "1"), /2,000/);
});

test("CSV 往返保留中文、引号、逗号、换行和两种空值", () => {
  const table = parseCsv(
    '\uFEFF名字,得分,记录,空白,空字符串\r\n中文,3,"摘录,""甲""\n第二行",,""\r\n',
  );
  const values = (data: typeof table) =>
    data.rows.map((row) => data.columns.map(({ key }) => row.cells[key]));
  assert.deepEqual(
    table.columns.map(({ type }) => type),
    ["text", "number", "text", "text", "text"],
  );
  assert.deepEqual(values(table), [["中文", 3, '摘录,"甲"\n第二行', null, ""]]);
  assert.deepEqual(values(parseCsv(formatCsv(table))), values(table));
  assert.equal(parseCsv("字段\r\n\r\n").rows.length, 1);
});

test("TSV 推断布尔与日期，保留有前导零的文本并拒绝损坏记录", () => {
  const table = parseCsv("编号,代码\t是否参加\t日期\n007\tfalse\t2024-02-29\n");
  assert.deepEqual(
    table.columns.map(({ type }) => type),
    ["text", "boolean", "date"],
  );
  assert.deepEqual(Object.values(table.rows[0].cells), [
    "007",
    false,
    "2024-02-29",
  ]);
  assert.throws(() => parseCsv('名称\n"未闭合'), /未闭合/);
  assert.throws(() => parseCsv("名称\n甲,乙"), /列数/);
});

const source: TableData = {
  columns: [
    { key: "category", label: "分类", type: "text" },
    { key: "price", label: "单价", type: "number" },
    { key: "quantity", label: "数量", type: "number" },
  ],
  rows: [
    { key: "a", cells: { category: "蔬菜", price: 3, quantity: 2 } },
    { key: "b", cells: { category: "水果", price: 6, quantity: 4 } },
    { key: "c", cells: { category: "蔬菜", price: 2, quantity: 3 } },
    { key: "d", cells: { category: "蔬菜", price: 3, quantity: null } },
  ],
};

test("计算后先叠加连接与本表筛选，再稳定排序和分组，原始行保持完整", () => {
  const original = structuredClone(source);
  const calculated = [
    { key: "total", label: "金额", formula: "[price]*[quantity]" },
  ];
  const filtered = deriveTable(
    source,
    {
      calculated,
      filters: [{ column: "total", op: "between", value: 5, upper: 12 }],
      sort: [{ column: "total", direction: "desc" }],
      groupBy: "category",
    },
    [{ column: "category", op: "eq", value: "蔬菜" }],
  );
  assert.deepEqual(
    filtered.rows.map(({ key }) => key),
    ["a", "c"],
  );
  assert.equal(filtered.groups[0].count, 2);
  assert.equal(filtered.groups[0].totals.total, 12);
  assert.match(filtered.errors.get("d")!.get("total")!, /为空/);
  assert.deepEqual(source, original);
  assert.deepEqual(
    deriveTable(source, {
      calculated,
      sort: [{ column: "total", direction: "desc" }],
    }).rows.map(({ key }) => key),
    ["b", "a", "c", "d"],
  );
});

test("计算列可互相引用，同名列要求用标识，循环或删除来源有明确错误", () => {
  const columns = [...source.columns, { ...source.columns[0], key: "another" }];
  assert.throws(() => resolveFormulaColumn(columns, "分类"), /重名/);
  assert.equal(resolveFormulaColumn(columns, "another"), "another");
  const result = deriveTable(source, {
    calculated: [
      { key: "base", label: "基础", formula: "[price]*2" },
      { key: "dependent", label: "依赖", formula: "[base]+1" },
      { key: "bad", label: "缺来源", formula: "[deleted]" },
      { key: "first", label: "第一列", formula: "[second]" },
      { key: "second", label: "第二列", formula: "[first]" },
    ],
    filters: [{ column: "price", op: "gt", value: "不合法" }],
  });
  assert.equal(result.rows[0].cells.dependent, 7);
  assert.match(result.errors.get("a")!.get("bad")!, /不存在/);
  assert.match(result.errors.get("a")!.get("first")!, /循环引用/);
  assert.ok(
    result.configurationErrors.some((error) => error.includes("类型不符")),
  );
});
