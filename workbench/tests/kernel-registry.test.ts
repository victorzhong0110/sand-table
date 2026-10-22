import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PackSpecError,
  createRegistry,
  type PackSpec,
  type TypeSpec,
} from "../kernel/index.ts";

const note = (patch: Partial<TypeSpec> = {}): TypeSpec => ({
  type: "demo.note",
  title: "便签",
  description: "一张便签",
  icon: "note",
  version: 1,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      age: {
        type: "integer",
        minimum: 0,
        "x-sand-label": "年龄",
        "x-sand-widget": "integer",
      },
    },
  },
  display: {
    material: "paper",
    defaultSize: { width: 200, height: 120 },
    summary: ["age"],
  },
  relationSlots: [
    {
      key: "about",
      label: "关于",
      kind: "demo.about",
      direction: "out",
      many: false,
    },
  ],
  ...patch,
});

function pack(patch: Partial<PackSpec> = {}): PackSpec {
  return {
    id: "demo",
    title: "示例",
    version: 1,
    types: [note()],
    relationKinds: [
      {
        kind: "demo.about",
        title: "关于",
        inverseTitle: "被提及",
        allowsInferred: false,
      },
    ],
    templates: [{ id: "demo.blank", title: "空白", commands: [] }],
    ...patch,
  };
}

function problems(spec: PackSpec, kind: "builtin" | "data" = "builtin") {
  try {
    createRegistry().registerPack(spec, kind);
  } catch (error) {
    assert.ok(error instanceof PackSpecError);
    return error.problems;
  }
  assert.fail("不合格的包应该被拒绝");
}

test("合格的包可以注册并查到类型、关系和模板", () => {
  const registry = createRegistry();
  registry.registerPack(pack(), "builtin");
  assert.equal(registry.getType("demo.note")?.title, "便签");
  assert.equal(registry.getRelationKind("demo.about")?.title, "关于");
  assert.equal(registry.getTemplate("demo.blank")?.title, "空白");
  assert.equal(registry.packIdOf("demo.note"), "demo");
});

test("类型名没有包前缀会被拒绝", () => {
  const found = problems(pack({ types: [note({ type: "note" })] }));
  assert.ok(found.some((problem) => problem.path === "/types/0/type"));
});

test("Schema 缺少 additionalProperties: false 会被拒绝", () => {
  const found = problems(
    pack({
      types: [
        note({
          schema: { type: "object", properties: { age: { type: "integer" } } },
        }),
      ],
    }),
  );
  assert.ok(
    found.some((problem) =>
      problem.path.endsWith("/schema/additionalProperties"),
    ),
  );
});

test("Schema 字段写了 default 会被拒绝", () => {
  const found = problems(
    pack({
      types: [
        note({
          schema: {
            type: "object",
            additionalProperties: false,
            properties: { age: { type: "integer", default: 0 } },
          },
        }),
      ],
    }),
  );
  assert.ok(found.some((problem) => problem.path.endsWith("/default")));
});

test("未知的 x-sand-widget 会被拒绝", () => {
  const found = problems(
    pack({
      types: [
        note({
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              age: { type: "integer", "x-sand-widget": "slider" },
            },
          },
        }),
      ],
    }),
  );
  assert.ok(found.some((problem) => problem.path.endsWith("/x-sand-widget")));
});

test("关系槽不能指向不存在的关系", () => {
  const found = problems(
    pack({
      types: [
        note({
          relationSlots: [
            {
              key: "about",
              label: "关于",
              kind: "demo.missing",
              direction: "out",
              many: false,
            },
          ],
        }),
      ],
    }),
  );
  assert.ok(found.some((problem) => problem.path.includes("relationSlots")));
});

test("摘要不能引用不存在的字段", () => {
  const found = problems(
    pack({
      types: [
        note({
          display: {
            material: "paper",
            defaultSize: { width: 200, height: 120 },
            summary: ["missing"],
          },
        }),
      ],
    }),
  );
  assert.ok(found.some((problem) => problem.path.includes("summary")));
});

test("数据包不能带自定义视图或注册工具", () => {
  const view = problems(
    pack({
      types: [
        note({
          display: {
            material: "paper",
            defaultSize: { width: 200, height: 120 },
            summary: ["age"],
            view: "custom",
          },
        }),
      ],
    }),
    "data",
  );
  assert.ok(view.some((problem) => problem.path.endsWith("/display/view")));
  const tools = problems(pack({ registerTools: () => undefined }), "data");
  assert.ok(tools.some((problem) => problem.path === "/registerTools"));
});

test("一次注册里的多个问题会一起返回", () => {
  const found = problems(
    pack({
      types: [
        note({
          type: "note",
          display: {
            material: "paper",
            defaultSize: { width: 200, height: 120 },
            summary: ["missing"],
          },
          relationSlots: [
            {
              key: "about",
              label: "关于",
              kind: "demo.missing",
              direction: "out",
              many: false,
            },
          ],
        }),
      ],
    }),
  );
  assert.equal(found.length, 3);
});

test("validateData 给出中文路径和原因", () => {
  const registry = createRegistry();
  registry.registerPack(pack(), "builtin");
  assert.deepEqual(registry.validateData("demo.note", { age: 3 }), {
    ok: true,
  });
  const tooSmall = registry.validateData("demo.note", { age: -1 });
  assert.equal(tooSmall.ok, false);
  if (!tooSmall.ok) {
    assert.deepEqual(tooSmall.errors, [
      { path: "/age", message: "年龄：不能小于 0" },
    ]);
  }
  const extra = registry.validateData("demo.note", { age: 1, extra: true });
  assert.equal(extra.ok, false);
  if (!extra.ok) {
    assert.equal(extra.errors.length, 1);
    assert.equal(extra.errors[0]?.path, "/extra");
    assert.match(extra.errors[0]?.message ?? "", /这个类型没有这个字段/);
  }
});

test("两个注册表互不影响", () => {
  const first = createRegistry();
  const second = createRegistry();
  first.registerPack(pack(), "builtin");
  assert.equal(second.getType("demo.note"), undefined);
  second.registerPack(
    pack({
      id: "other",
      types: [
        note({
          type: "other.note",
          relationSlots: [],
        }),
      ],
      relationKinds: [],
      templates: [{ id: "other.blank", title: "空白", commands: [] }],
    }),
    "builtin",
  );
  assert.equal(first.getType("other.note"), undefined);
  assert.equal(second.getType("demo.note"), undefined);
});

test("重新注册会替换旧类型", () => {
  const registry = createRegistry();
  registry.registerPack(
    pack({
      types: [
        note(),
        note({
          type: "demo.old",
          title: "旧便签",
          relationSlots: [],
          display: {
            material: "paper",
            defaultSize: { width: 200, height: 120 },
            summary: ["age"],
          },
        }),
      ],
    }),
    "builtin",
  );
  registry.registerPack(
    pack({
      version: 2,
      types: [note({ title: "新便签" })],
    }),
    "builtin",
  );
  assert.equal(registry.getPack("demo")?.spec.version, 2);
  assert.equal(registry.getType("demo.note")?.title, "新便签");
  assert.equal(registry.getType("demo.old"), undefined);
  assert.equal(registry.validateData("demo.note", { age: 1 }).ok, true);
});
