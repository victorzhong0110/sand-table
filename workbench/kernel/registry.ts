import Ajv2020 from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import { PACK_SCHEMA } from "./pack-schema.ts";
import { ajvErrorsToFieldErrors, type SchemaProblem } from "./messages.ts";
import type {
  JsonSchema,
  PackSpec,
  RelationKindSpec,
  TemplateSpec,
  TypeSpec,
} from "./types.ts";

const PACK_ID = /^[a-z][a-z0-9-]{1,40}$/;
const LOCAL_NAME = /^[a-z][a-z0-9_]{0,40}$/;
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
const SCHEMA_KEYWORDS = [
  "x-sand-label",
  "x-sand-widget",
  "x-sand-placeholder",
  "x-sand-unit",
  "x-sand-enum-labels",
  "x-sand-default",
  "x-sand-hidden",
];

export class PackSpecError extends Error {
  problems: SchemaProblem[];

  constructor(problems: SchemaProblem[]) {
    super(
      problems
        .map((problem) => `${problem.path} ${problem.message}`)
        .join("\n") || "包声明不合格。",
    );
    this.name = "PackSpecError";
    this.problems = problems;
  }
}

type RegisteredPack = { spec: PackSpec; kind: "builtin" | "data" };

export type Registry = {
  registerPack(spec: unknown, kind: "builtin" | "data"): void;
  unregisterPack(id: string): void;
  getPack(id: string): RegisteredPack | undefined;
  listPacks(): RegisteredPack[];
  getType(type: string): TypeSpec | undefined;
  getRelationKind(kind: string): RelationKindSpec | undefined;
  getTemplate(id: string): TemplateSpec | undefined;
  packIdOf(name: string): string;
  validateData(
    type: string,
    data: unknown,
  ): { ok: true } | { ok: false; errors: SchemaProblem[] };
};

export function createRegistry(): Registry {
  const packs = new Map<string, RegisteredPack>();
  const validators = new Map<string, ValidateFunction>();
  const validatePack = new Ajv2020({ strict: true, allErrors: true }).compile(
    PACK_SCHEMA,
  );

  function typesOf(spec: PackSpec) {
    return spec.types ?? [];
  }
  function relationsOf(spec: PackSpec) {
    return spec.relationKinds ?? [];
  }
  function templatesOf(spec: PackSpec) {
    return spec.templates ?? [];
  }

  function removePack(id: string) {
    const existing = packs.get(id);
    if (!existing) return;
    for (const type of typesOf(existing.spec)) validators.delete(type.type);
    packs.delete(id);
  }

  function taken(exceptId: string) {
    const typeNames = new Set<string>();
    const relationNames = new Set<string>();
    const templateIds = new Set<string>();
    for (const pack of packs.values()) {
      if (pack.spec.id === exceptId) continue;
      for (const type of typesOf(pack.spec)) typeNames.add(type.type);
      for (const relation of relationsOf(pack.spec))
        relationNames.add(relation.kind);
      for (const template of templatesOf(pack.spec))
        templateIds.add(template.id);
    }
    return { typeNames, relationNames, templateIds };
  }

  function registerPack(input: unknown, kind: "builtin" | "data") {
    if (!validatePack(input))
      throw new PackSpecError(
        ajvErrorsToFieldErrors(validatePack.errors, PACK_SCHEMA),
      );
    if (kind !== "builtin" && kind !== "data")
      throw new PackSpecError([
        { path: "/kind", message: "包种类必须是 builtin 或 data。" },
      ]);
    const spec = copySpec(input as PackSpec);
    const problems = checkPack(spec, kind, taken(spec.id));
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    for (const keyword of SCHEMA_KEYWORDS) ajv.addKeyword(keyword);
    const compiled = new Map<string, ValidateFunction>();
    for (const [index, type] of typesOf(spec).entries()) {
      if (!isSchemaRecord(type.schema)) continue;
      try {
        compiled.set(type.type, ajv.compile(type.schema));
      } catch (error) {
        problems.push({
          path: `/types/${index}/schema`,
          message:
            error instanceof Error
              ? `数据 Schema 无法编译：${error.message}`
              : "数据 Schema 无法编译。",
        });
      }
    }
    if (problems.length) throw new PackSpecError(problems);
    removePack(spec.id);
    packs.set(spec.id, Object.freeze({ spec: freezeSpec(spec), kind }));
    for (const [type, validate] of compiled) validators.set(type, validate);
  }

  return {
    registerPack,
    unregisterPack: removePack,
    getPack: (id) => packs.get(id),
    listPacks: () => [...packs.values()],
    getType: (type) => {
      for (const pack of packs.values()) {
        const found = typesOf(pack.spec).find((item) => item.type === type);
        if (found) return found;
      }
      return undefined;
    },
    getRelationKind: (kind) => {
      for (const pack of packs.values()) {
        const found = relationsOf(pack.spec).find((item) => item.kind === kind);
        if (found) return found;
      }
      return undefined;
    },
    getTemplate: (id) => {
      for (const pack of packs.values()) {
        const found = templatesOf(pack.spec).find((item) => item.id === id);
        if (found) return found;
      }
      return undefined;
    },
    packIdOf: (name) => {
      const dot = name.indexOf(".");
      return dot === -1 ? name : name.slice(0, dot);
    },
    validateData: (type, data) => {
      const validate = validators.get(type);
      const spec = findType(packs, type);
      if (!validate || !spec)
        return {
          ok: false,
          errors: [{ path: "", message: `没有这个类型「${type}」。` }],
        };
      if (validate(data)) return { ok: true };
      return {
        ok: false,
        errors: ajvErrorsToFieldErrors(validate.errors, spec.schema),
      };
    },
  };
}

function findType(packs: Map<string, RegisteredPack>, type: string) {
  for (const pack of packs.values()) {
    const found = (pack.spec.types ?? []).find((item) => item.type === type);
    if (found) return found;
  }
  return undefined;
}

function checkPack(
  spec: PackSpec,
  kind: "builtin" | "data",
  taken: {
    typeNames: Set<string>;
    relationNames: Set<string>;
    templateIds: Set<string>;
  },
) {
  const problems: SchemaProblem[] = [];
  if (!PACK_ID.test(spec.id))
    problems.push({
      path: "/id",
      message: `包 id「${spec.id}」必须是小写字母开头，后面 1 到 40 位小写字母、数字或连字符。`,
    });
  if (kind === "data") {
    if ((spec.types?.length ?? 0) > 30)
      problems.push({ path: "/types", message: "数据包最多 30 个类型。" });
    if ((spec.relationKinds?.length ?? 0) > 30)
      problems.push({
        path: "/relationKinds",
        message: "数据包最多 30 个关系类型。",
      });
    if ((spec.presets?.length ?? 0) > 50)
      problems.push({ path: "/presets", message: "数据包最多 50 个预设。" });
    if (Object.prototype.hasOwnProperty.call(spec, "registerTools"))
      problems.push({
        path: "/registerTools",
        message: "数据包不能注册工具。",
      });
  }
  if (
    spec.registerTools !== undefined &&
    typeof spec.registerTools !== "function"
  )
    problems.push({
      path: "/registerTools",
      message: "工具注册器必须是函数。",
    });
  const relationNames = new Set(taken.relationNames);
  for (const [index, relation] of (spec.relationKinds ?? []).entries()) {
    const path = `/relationKinds/${index}/kind`;
    if (!prefixedName(spec.id, relation.kind))
      problems.push({
        path,
        message: `关系名「${relation.kind}」必须以「${spec.id}.」开头，名字用小写字母、数字或下划线。`,
      });
    if (relationNames.has(relation.kind))
      problems.push({
        path,
        message: `关系名「${relation.kind}」重复了。`,
      });
    relationNames.add(relation.kind);
  }
  const typeNames = new Set(taken.typeNames);
  for (const [index, type] of (spec.types ?? []).entries()) {
    const base = `/types/${index}`;
    if (!prefixedName(spec.id, type.type))
      problems.push({
        path: `${base}/type`,
        message: `类型名「${type.type}」必须以「${spec.id}.」开头，名字用小写字母、数字或下划线。`,
      });
    if (typeNames.has(type.type))
      problems.push({
        path: `${base}/type`,
        message: `类型名「${type.type}」重复了。`,
      });
    typeNames.add(type.type);
    if (
      kind === "data" &&
      Object.prototype.hasOwnProperty.call(type.display, "view")
    )
      problems.push({
        path: `${base}/display/view`,
        message: "数据包的类型不能指定自定义视图。",
      });
    if (
      kind === "data" &&
      Object.prototype.hasOwnProperty.call(type, "migrations")
    )
      problems.push({
        path: `${base}/migrations`,
        message: "数据包的类型不能带迁移函数。",
      });
    for (const [i, migration] of (type.migrations ?? []).entries())
      if (typeof migration.migrate !== "function")
        problems.push({
          path: `${base}/migrations/${i}/migrate`,
          message: "迁移必须是函数。",
        });
    checkSchema(type, base, problems);
    const properties = schemaProperties(type.schema);
    for (const [fieldIndex, field] of (type.display.summary ?? []).entries()) {
      if (
        !properties ||
        !Object.prototype.hasOwnProperty.call(properties, field)
      )
        problems.push({
          path: `${base}/display/summary/${fieldIndex}`,
          message: `摘要字段「${field}」不在这个类型的数据字段里。`,
        });
    }
    for (const [slotIndex, slot] of (type.relationSlots ?? []).entries()) {
      if (!relationNames.has(slot.kind))
        problems.push({
          path: `${base}/relationSlots/${slotIndex}/kind`,
          message: `关系槽「${slot.label}」要用的关系「${slot.kind}」还不存在。`,
        });
    }
  }
  const templateIds = new Set(taken.templateIds);
  for (const [index, template] of (spec.templates ?? []).entries()) {
    if (!prefixedName(spec.id, template.id))
      problems.push({
        path: `/templates/${index}/id`,
        message: "模板 id 必须以本包前缀开头。",
      });
    if (templateIds.has(template.id))
      problems.push({
        path: `/templates/${index}/id`,
        message: `模板 id「${template.id}」重复了。`,
      });
    templateIds.add(template.id);
  }
  return problems;
}

function checkSchema(type: TypeSpec, base: string, problems: SchemaProblem[]) {
  const schema = type.schema;
  if (!isSchemaRecord(schema)) {
    problems.push({
      path: `${base}/schema`,
      message: "数据 Schema 必须是一个对象。",
    });
    return;
  }
  if (schema.type !== "object")
    problems.push({
      path: `${base}/schema/type`,
      message: "数据 Schema 的顶层必须是 object。",
    });
  if (!isSchemaRecord(schema.properties))
    problems.push({
      path: `${base}/schema/properties`,
      message: "数据 Schema 必须声明 properties。",
    });
  if (schema.additionalProperties !== false)
    problems.push({
      path: `${base}/schema/additionalProperties`,
      message: "数据 Schema 必须写 additionalProperties: false。",
    });
  walkSchema(schema, `${base}/schema`, problems);
}

function walkSchema(schema: unknown, path: string, problems: SchemaProblem[]) {
  if (!isSchemaRecord(schema)) return;
  if (Object.prototype.hasOwnProperty.call(schema, "default"))
    problems.push({
      path: `${path}/default`,
      message: "内容字段不能写 default。没填就是这个字段不存在。",
    });
  if (Object.prototype.hasOwnProperty.call(schema, "x-sand-widget")) {
    const widget = schema["x-sand-widget"];
    if (typeof widget !== "string" || !WIDGETS.has(widget))
      problems.push({
        path: `${path}/x-sand-widget`,
        message: `x-sand-widget 只能是规定的控件，不能是「${String(widget)}」。`,
      });
  }
  const properties = schema.properties;
  if (isSchemaRecord(properties)) {
    for (const [name, child] of Object.entries(properties))
      walkSchema(child, `${path}/properties/${escapePointer(name)}`, problems);
  }
  for (const key of [
    "items",
    "additionalProperties",
    "not",
    "if",
    "then",
    "else",
    "contains",
    "propertyNames",
    "unevaluatedItems",
    "unevaluatedProperties",
  ]) {
    if (key in schema) walkSchema(schema[key], `${path}/${key}`, problems);
  }
  for (const key of ["anyOf", "oneOf", "allOf", "prefixItems"]) {
    const list = schema[key];
    if (!Array.isArray(list)) continue;
    list.forEach((child, index) =>
      walkSchema(child, `${path}/${key}/${index}`, problems),
    );
  }
  for (const key of [
    "$defs",
    "definitions",
    "patternProperties",
    "dependentSchemas",
  ]) {
    const record = schema[key];
    if (!isSchemaRecord(record)) continue;
    for (const [name, child] of Object.entries(record))
      walkSchema(child, `${path}/${key}/${escapePointer(name)}`, problems);
  }
}

function schemaProperties(schema: JsonSchema) {
  if (!isSchemaRecord(schema) || !isSchemaRecord(schema.properties))
    return undefined;
  return schema.properties;
}

function prefixedName(packId: string, name: string) {
  const prefix = `${packId}.`;
  return name.startsWith(prefix) && LOCAL_NAME.test(name.slice(prefix.length));
}

function isSchemaRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function escapePointer(name: string) {
  return name.replaceAll("~", "~0").replaceAll("/", "~1");
}

function copySpec<T>(v: T): T {
  if (Array.isArray(v)) return v.map(copySpec) as T;
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [k, copySpec(x)]),
    ) as T;
  return v;
}
function freezeSpec<T>(v: T): T {
  if (v && typeof v === "object") {
    for (const x of Object.values(v)) freezeSpec(x);
    Object.freeze(v);
  }
  return v;
}
