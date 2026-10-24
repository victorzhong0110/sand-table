// 内置包声明的验收：任务卡 docs/kernel-v3/tasks/T12-builtin-packs.md 的「验收」。
//
// 这里只测声明本身：能不能注册、数据合不合格、字段有没有按规则删改、
// 模板里的类型和关系是不是都存在。

import assert from "node:assert/strict";
import { test } from "node:test";
import { createRegistry, type Registry } from "../kernel/index.ts";
import { builtinPacks } from "../packs/index.ts";

/** 按类型分组的合格与不合格样例：每个类型至少各一组。 */
const samples: {
  type: string;
  ok: Record<string, unknown>[];
  bad: Record<string, unknown>[];
}[] = [
  {
    type: "base.board",
    ok: [{}],
    bad: [{ name: "不是白板的字段" }],
  },
  {
    type: "base.frame",
    ok: [{}],
    bad: [{ title: "框" }],
  },
  {
    type: "base.note",
    ok: [{ body: "一段说明" }, { body: "" }],
    bad: [{ body: 42 }, { text: "旧字段名" }],
  },
  {
    type: "base.heading",
    ok: [{ text: "第一节", level: 1 }, { level: 3 }],
    bad: [{ level: 4 }, { level: 0 }, { text: 1 }],
  },
  {
    type: "base.link",
    ok: [{ url: "https://example.com/a", description: "说明" }, { url: "" }],
    bad: [{ url: 12 }, { description: 12 }, { url: "javascript:alert(1)" }],
  },
  {
    type: "base.media",
    ok: [
      {
        blob: "a".repeat(64),
        mime: "image/png",
        caption: "一张图",
        alt: "替代文字",
      },
    ],
    bad: [
      { blob: 12 },
      { mime: "image/png", caption: 12 },
      { blob: "A".repeat(64) },
      { blob: "not-a-sha256" },
    ],
  },
  {
    type: "base.code_snippet",
    ok: [{ language: "ts", text: "const a = 1;" }],
    bad: [{ language: "x".repeat(41) }, { text: 12 }],
  },
  {
    type: "base.metric",
    ok: [{ value: "12", unit: "%", description: "占比" }],
    bad: [{ value: 12 }, { unit: 12 }],
  },
  {
    type: "base.status",
    ok: [
      {
        state: "operational",
        description: "正常",
        sourceUrl: "https://status.example.com",
      },
    ],
    bad: [
      { state: "broken" },
      { state: 12 },
      { sourceUrl: "javascript:alert(1)" },
    ],
  },
  {
    type: "base.table",
    ok: [
      {
        columns: ["名称", "数量", "完成", "备注"],
        rows: [["甲", 1, true, null]],
      },
      { columns: [], rows: [] },
    ],
    bad: [{ columns: new Array(21).fill("列") }, { rows: "不是数组" }],
  },
  {
    type: "base.chart",
    ok: [{ kind: "bar", points: [{ label: "一月", value: 3 }] }],
    bad: [{ points: [{ label: "一月" }] }, { kind: "pie" }],
  },
  {
    type: "base.events",
    ok: [{ events: [{ at: "10:00", label: "开始", detail: "详情" }] }],
    bad: [
      { events: [{ at: "10:00", label: "开始", detail: 1 }] },
      { events: [{ at: 1, label: "x" }] },
    ],
  },
  {
    type: "base.task",
    ok: [{ goal: "把事情做完", items: [{ text: "第一步", done: false }] }],
    bad: [
      { items: [{ text: "第一步" }] },
      { items: [{ text: 1, done: false }] },
    ],
  },
  {
    type: "base.reasoning",
    ok: [
      {
        question: "为什么会这样",
        evidence: ["一条证据", { text: "另一条证据" }],
        options: ["甲", "乙"],
        decision: "因为",
        unknowns: "还不确定",
      },
    ],
    bad: [{ question: "为什么会这样", evidence: [42] }, { options: [12] }],
  },
  {
    type: "base.comparison",
    ok: [
      {
        left: { title: "方案 A", text: "内容" },
        right: { title: "方案 B", text: "内容" },
        conclusion: "A 更稳",
      },
    ],
    bad: [{ left: { title: 1, text: "内容" } }, { conclusion: 12 }],
  },
  {
    type: "base.tour",
    ok: [{ purpose: "带人走一遍流程" }],
    bad: [{ purpose: 12 }, { stops: ["不是关系"] }],
  },
  {
    type: "novel.character",
    ok: [
      {
        role: "主角",
        age: 30,
        traits: ["冷静"],
        goal: "复仇",
        arc: "从软弱到坚定",
      },
    ],
    bad: [{ name: "林舟" }, { age: -1 }, { traits: [""] }],
  },
  {
    type: "novel.event",
    ok: [
      {
        summary: "港口大火",
        storyTime: "第三年冬",
        narrativeOrder: 4,
        place: "港口",
      },
    ],
    bad: [
      { summary: "港口大火", participants: ["林舟"] },
      { narrativeOrder: -1 },
    ],
  },
  {
    type: "novel.chapter",
    ok: [
      { summary: "章节概要", narrativeOrder: 1, wordCount: 2000, body: "正文" },
    ],
    bad: [{ narrativeOrder: -1 }, { wordCount: -1 }],
  },
  {
    type: "research.hypothesis",
    ok: [
      {
        statement: "提高剂量能缩短恢复时间",
        scope: "某人群",
        testable: true,
        variables: ["剂量"],
      },
    ],
    bad: [{ statement: 12 }, { variables: [12] }],
  },
  {
    type: "research.evidence",
    ok: [
      {
        summary: "120 个样本中恢复时间显著缩短",
        method: "观察",
        strength: 0.8,
        citation: {
          kind: "pdf",
          uri: "https://example.com/a.pdf",
          fragment: "p.42",
          fingerprint: "abc123",
        },
        quote: "原文摘录",
        status: "valid",
      },
    ],
    bad: [{ citation: { kind: "pdf" } }, { status: "unknown" }],
  },
  {
    type: "research.conclusion",
    ok: [{ statement: "剂量与恢复时间正相关", confidence: 0.6 }],
    bad: [{ confidence: 2 }, { statement: 12 }],
  },
  {
    type: "code.repository",
    ok: [{ label: "仓库", head: "abc123", branch: "main" }],
    bad: [{ label: 12 }],
  },
  {
    type: "code.file",
    ok: [
      { path: "src/app/main.ts", hash: "a".repeat(64) },
      { path: "", hash: null },
      { path: ".gitignore" },
    ],
    bad: [
      { hash: "不是内容指纹" },
      { path: 12 },
      { path: "../secret" },
      { path: "/etc/passwd" },
      { path: "foo\\bar" },
    ],
  },
  {
    type: "code.symbol",
    ok: [{ name: "main", startLine: 1, endLine: 20 }],
    bad: [{ startLine: 0 }, { name: 12 }],
  },
  {
    type: "code.intent",
    ok: [
      {
        request: "把导出按钮补上",
        allowedFiles: [{ workspaceId: "w1", path: "src/app/main.ts" }],
        arrangement: { viewId: "main" },
      },
      { request: "a".repeat(4000) },
    ],
    bad: [
      { allowedFiles: [{ path: 12 }] },
      { request: 12 },
      { request: "a".repeat(4001) },
      {
        allowedFiles: Array.from({ length: 13 }, () => ({
          workspaceId: "w1",
          path: "src/app/main.ts",
        })),
      },
      { allowedFiles: [{ workspaceId: "w1", path: "../secret" }] },
    ],
  },
  {
    type: "code.proposal",
    ok: [
      {
        title: "补上导出按钮",
        explanation: "新增一个按钮",
        testPlan: "跑一遍测试",
        digest: "digest-1",
        decision: "pending",
        intentVersion: 1,
        agentId: "agent-1",
        files: [
          {
            workspaceId: "w1",
            path: "src/app/main.ts",
            beforeHash: null,
            afterHash: "b".repeat(64),
            before: "const a = 1;\n",
            after: null,
          },
        ],
        baseline: [
          {
            workspaceId: "w1",
            head: "abc",
            files: {},
            omitted: [],
            fingerprint: "f",
          },
        ],
      },
    ],
    bad: [
      { decision: "unknown-decision" },
      { files: [{ path: 12 }] },
      { title: "题".repeat(121) },
      { explanation: "说".repeat(4001) },
      { files: [{ workspaceId: "w1", path: "../secret" }] },
    ],
  },
  {
    type: "code.validation",
    ok: [
      {
        command: "npm test",
        environment: "node 22",
        outcome: "passed",
        output: "全部通过",
        reportedAt: 1,
        workspaceId: "w1",
        digest: "c".repeat(64),
        agentId: "agent-1",
        source: "agent-report",
      },
    ],
    bad: [
      { outcome: "maybe" },
      { command: 12 },
      { environment: "e".repeat(1001) },
      { output: "o".repeat(8001) },
      { source: "server" },
    ],
  },
];

/** 一个装好内置包的注册表。 */
function registryWithBuiltins(): Registry {
  const registry = createRegistry();
  for (const pack of builtinPacks) registry.registerPack(pack, "builtin");
  return registry;
}

/** 递归找出所有名叫 default 的键（x-sand-default 不算）。 */
function defaultKeys(value: unknown, path = ""): string[] {
  if (Array.isArray(value))
    return value.flatMap((item, index) =>
      defaultKeys(item, `${path}/${index}`),
    );
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const hits = Object.prototype.hasOwnProperty.call(record, "default")
    ? [path]
    : [];
  for (const [key, child] of Object.entries(record))
    hits.push(...defaultKeys(child, `${path}/${key}`));
  return hits;
}

test("内置包按顺序注册，全部合格", () => {
  const registry = registryWithBuiltins();
  assert.deepEqual(
    registry.listPacks().map((pack) => pack.spec.id),
    ["base", "novel", "research", "code"],
  );
});

test("每个类型都有合格样例与不合格样例", () => {
  const registry = registryWithBuiltins();
  const declared = builtinPacks.flatMap((pack) =>
    (pack.types ?? []).map((type) => type.type),
  );
  const covered = samples.map((sample) => sample.type);
  assert.deepEqual(
    [...covered].sort(),
    [...declared].sort(),
    "有类型没有样例，或样例里有不存在的类型",
  );
  for (const sample of samples) {
    for (const data of sample.ok) {
      const result = registry.validateData(sample.type, data);
      assert.ok(
        result.ok,
        `${sample.type} 的合格样例被拒：${JSON.stringify(data)} ${JSON.stringify(
          result.ok ? undefined : result.errors,
        )}`,
      );
    }
    for (const data of sample.bad) {
      const result = registry.validateData(sample.type, data);
      assert.equal(
        result.ok,
        false,
        `${sample.type} 的不合格样例居然通过了：${JSON.stringify(data)}`,
      );
    }
  }
});

test("事件没有参与者名单，人物没有姓名字段", () => {
  const registry = registryWithBuiltins();
  const event = registry.getType("novel.event");
  const character = registry.getType("novel.character");
  assert.ok(event && character);
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      event.schema.properties as Record<string, unknown>,
      "participants",
    ),
    false,
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      character.schema.properties as Record<string, unknown>,
      "name",
    ),
    false,
  );
});

test("所有 Schema 里没有 default 键", () => {
  for (const pack of builtinPacks)
    for (const type of pack.types ?? []) {
      const hits = defaultKeys(type.schema);
      assert.deepEqual(hits, [], `${type.type} 的 Schema 里出现了 default`);
    }
});

test("模板里的类型和关系都能在注册表里查到", () => {
  const registry = registryWithBuiltins();
  for (const pack of builtinPacks)
    for (const template of pack.templates ?? [])
      for (const command of template.commands) {
        if (command.op === "object.create")
          assert.ok(
            registry.getType(command.type),
            `${template.id} 用了不存在的类型「${command.type}」`,
          );
        if (command.op === "relation.create")
          assert.ok(
            registry.getRelationKind(command.kind),
            `${template.id} 用了不存在的关系「${command.kind}」`,
          );
      }
});

test("白板和人物可以进入，便签不行", () => {
  const registry = registryWithBuiltins();
  assert.equal(registry.getType("base.board")?.capabilities?.container, true);
  assert.equal(
    registry.getType("novel.character")?.capabilities?.container,
    true,
  );
  assert.notEqual(registry.getType("base.note")?.capabilities?.container, true);
});

test("代码包声明派生 ID 前缀，且只有代码包声明", () => {
  const registry = registryWithBuiltins();
  assert.equal(registry.getPack("code")?.spec.derivedIdPrefix, "code:");
  for (const pack of builtinPacks)
    if (pack.id !== "code")
      assert.equal(pack.derivedIdPrefix, undefined, `${pack.id} 不该声明前缀`);
});

const WIDGETS = new Set([
  "text",
  "longtext",
  "markdown",
  "number",
  "integer",
  "boolean",
  "enum",
  "tags",
  "date",
  "url",
  "color",
  "locator",
  "blob",
  "table",
  "list",
]);

/** 每个具名字段都要有中文标签和控件。嵌套的 items / anyOf 里的字段也算。 */
function fieldsMissingHints(schema: unknown, path: string, hits: string[]) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return;
  const record = schema as Record<string, unknown>;
  const properties = record.properties;
  if (
    properties &&
    typeof properties === "object" &&
    !Array.isArray(properties)
  )
    for (const [name, child] of Object.entries(properties)) {
      const here = `${path}/${name}`;
      if (!child || typeof child !== "object" || Array.isArray(child)) {
        hits.push(`${here} 不是对象`);
        continue;
      }
      const field = child as Record<string, unknown>;
      const label = field["x-sand-label"];
      const widget = field["x-sand-widget"];
      if (typeof label !== "string" || !/\p{Script=Han}/u.test(label))
        hits.push(`${here} 缺少中文标签`);
      if (typeof widget !== "string" || !WIDGETS.has(widget))
        hits.push(`${here} 的控件不合格`);
      fieldsMissingHints(child, here, hits);
    }
  for (const key of ["items", "additionalProperties"])
    if (key in record) fieldsMissingHints(record[key], `${path}/${key}`, hits);
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const list = record[key];
    if (!Array.isArray(list)) continue;
    list.forEach((child, index) =>
      fieldsMissingHints(child, `${path}/${key}/${index}`, hits),
    );
  }
}

function visibleFields(schema: Record<string, unknown>) {
  const properties = schema.properties;
  if (
    !properties ||
    typeof properties !== "object" ||
    Array.isArray(properties)
  )
    return [];
  return Object.entries(properties).filter(([, child]) => {
    if (!child || typeof child !== "object" || Array.isArray(child))
      return true;
    return (child as Record<string, unknown>)["x-sand-hidden"] !== true;
  });
}

test("每个字段都有中文标签和控件，摘要只取可见字段", () => {
  for (const pack of builtinPacks) {
    if (pack.id === "code")
      assert.equal(typeof pack.registerTools, "function", "代码包要注册工具");
    else assert.equal(pack.registerTools, undefined, `${pack.id} 不该注册工具`);
    for (const type of pack.types ?? []) {
      assert.equal(
        type.display.view,
        undefined,
        `${type.type} 不该指定自定义视图`,
      );
      const hits: string[] = [];
      fieldsMissingHints(type.schema, type.type, hits);
      assert.deepEqual(hits, []);
      const visible = visibleFields(type.schema as Record<string, unknown>).map(
        ([name]) => name,
      );
      const summary = type.display.summary ?? [];
      for (const field of summary)
        assert.ok(
          visible.includes(field),
          `${type.type} 的摘要「${field}」不是可见字段`,
        );
      if (visible.length >= 2)
        assert.ok(
          summary.length >= 2 && summary.length <= 3,
          `${type.type} 的摘要应是 2 到 3 个字段，现在是 ${summary.join("、")}`,
        );
      else
        assert.equal(
          summary.length,
          visible.length,
          `${type.type} 的摘要应覆盖它仅有的字段`,
        );
    }
  }
});

test("模板里新建对象的数据能通过该类型的校验", () => {
  const registry = registryWithBuiltins();
  for (const pack of builtinPacks)
    for (const template of pack.templates ?? [])
      for (const command of template.commands) {
        if (command.op !== "object.create") continue;
        const result = registry.validateData(command.type, command.data ?? {});
        assert.equal(
          result.ok,
          true,
          `${template.id} 里 ${command.ref ?? command.type} 的数据不合格：${JSON.stringify(result)}`,
        );
      }
});

test("关系两端和槽的目标类型都存在", () => {
  const registry = registryWithBuiltins();
  const types = new Set(
    builtinPacks.flatMap((pack) => (pack.types ?? []).map((type) => type.type)),
  );
  for (const pack of builtinPacks) {
    for (const relation of pack.relationKinds ?? [])
      for (const name of [
        ...(relation.sourceTypes ?? []),
        ...(relation.targetTypes ?? []),
      ])
        assert.ok(
          types.has(name),
          `${relation.kind} 指向了不存在的类型「${name}」`,
        );
    for (const type of pack.types ?? [])
      for (const slot of type.relationSlots ?? []) {
        assert.ok(
          registry.getRelationKind(slot.kind),
          `${type.type} 的槽「${slot.key}」用了不存在的关系「${slot.kind}」`,
        );
        for (const name of slot.targetTypes ?? [])
          assert.ok(
            types.has(name),
            `${type.type} 的槽「${slot.key}」指向了不存在的类型「${name}」`,
          );
      }
  }
});
