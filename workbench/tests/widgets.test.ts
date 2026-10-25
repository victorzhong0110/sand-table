import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatBlob,
  formatBoolean,
  formatColor,
  formatDate,
  formatEnum,
  formatList,
  formatLocator,
  formatLongText,
  formatMarkdown,
  formatNumber,
  formatTable,
  formatTags,
  formatUrl,
  normalizeTags,
  parseDateInput,
  parseFragment,
} from "../board/widgets/display.ts";
import { commitNumber, type JsonSchema } from "../board/views/format.ts";

const age: JsonSchema = {
  type: "integer",
  minimum: 0,
  maximum: 10000,
  "x-sand-widget": "integer",
  "x-sand-unit": "岁",
};

test("每个控件按自己的格式显示", () => {
  assert.equal(formatNumber(30, age), "30 岁");
  assert.equal(formatNumber(0, age), "0 岁");
  assert.equal(formatBoolean(true), "是");
  assert.equal(formatBoolean(false), "否");
  assert.equal(formatBoolean(undefined), "");
  assert.equal(
    formatEnum("lead", { "x-sand-enum-labels": { lead: "主角" } }),
    "主角",
  );
  assert.equal(formatTags(["冷静", "固执"]), "冷静、固执");
  assert.equal(formatLongText("字".repeat(210)).length, 200);
  assert.equal(formatMarkdown("# 标题\n**重点**"), "标题 重点");
  assert.equal(formatDate("2024-03-05"), "2024年3月5日");
  assert.equal(
    formatUrl("https://example.com/docs/guide"),
    "example.com/docs/guide",
  );
  assert.equal(formatColor("#336699"), "#336699");
  assert.equal(
    formatLocator({ kind: "pdf", uri: "file:///a.pdf", fragment: "page=3" }),
    "PDF 第 3 页",
  );
  assert.equal(
    formatLocator({
      kind: "file",
      uri: "file:///a.txt",
      fragment: "lines=12-20",
    }),
    "第 12–20 行",
  );
  assert.equal(formatBlob("a".repeat(64)), "aaaaaaaa");
  assert.equal(formatTable([["a", 1], ["b"]]), "2 行 × 2 列");
  assert.equal(formatList(["甲", "乙", "丙"]), "3 项");
});

test("数字空输入清空，0 保留，整数拒绝小数", () => {
  assert.deepEqual(commitNumber("", age), { ok: true, value: undefined });
  assert.deepEqual(commitNumber("0", age), { ok: true, value: 0 });
  assert.deepEqual(commitNumber("1.5", age), {
    ok: false,
    message: "整数不能有小数。请改成整数后再保存。",
  });
  assert.equal(commitNumber("-1", age).ok, false);
  assert.deepEqual(
    commitNumber("1.5", { type: "number", "x-sand-widget": "number" }),
    { ok: true, value: 1.5 },
  );
});

test("日期能按存储格式往返", () => {
  assert.equal(parseDateInput("2024-03-05"), "2024-03-05");
  assert.equal(formatDate(parseDateInput("2024-03-05")), "2024年3月5日");
  assert.equal(parseDateInput("2024-02-31"), undefined);
  assert.equal(formatDate("不是日期"), "");
});

test("定位片段按固定格式校验", () => {
  assert.equal(parseFragment("page=3").ok, true);
  assert.equal(parseFragment("lines=12-20").ok, true);
  assert.equal(parseFragment("lines=20-12").ok, false);
  assert.equal(parseFragment("page=三").ok, false);
  assert.equal(parseFragment("object=abc").ok, false);
  assert.equal(parseFragment("quote=a%3Db").ok, true);
  const encoded = parseFragment("quote=a%3Db");
  assert.equal(encoded.ok, true);
  if (encoded.ok) assert.equal(encoded.parts.quote, "a=b");
});

test("标签忽略重复和空白", () => {
  assert.deepEqual(normalizeTags(["冷静", " 冷静 ", "", "固执"]), [
    "冷静",
    "固执",
  ]);
});
