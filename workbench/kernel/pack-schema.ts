import type { JsonSchema } from "./types.ts";
const text = { type: "string", minLength: 1 },
  version = { type: "integer", minimum: 1 };
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const list = (items: unknown) => ({ type: "array", items });
const names = { ...list(text), uniqueItems: true };
const size = { type: "number", exclusiveMinimum: 0 };
const record = { type: "object" };
const source = obj(
  {
    origin: {
      enum: ["human", "imported", "ai-generated", "ai-inferred", "derived"],
    },
    basis: { type: "string" },
    external: obj(
      {
        kind: { enum: ["file", "git", "pdf", "url", "dataset", "symbol"] },
        uri: text,
        fragment: { type: "string" },
        version: { type: "string" },
        fingerprint: { type: "string" },
      },
      ["kind", "uri"],
    ),
  },
  ["origin"],
);
const appearance = obj({
  detail: { enum: ["full", "label", "icon"] },
  coverBlob: text,
  accent: { type: "string" },
});
const op = (
  name: string,
  fields: Record<string, unknown>,
  required: string[],
) => obj({ op: { const: name }, ...fields }, ["op", ...required]);
const expectedVersion = { type: "integer", minimum: 1 };
const command = {
  oneOf: [
    op(
      "object.create",
      {
        ref: text,
        type: text,
        title: { type: "string" },
        data: record,
        source,
      },
      ["type"],
    ),
    op(
      "object.update",
      {
        id: text,
        expectedVersion,
        title: { type: "string" },
        set: record,
        unset: names,
        source,
      },
      ["id"],
    ),
    op("object.delete", { id: text, expectedVersion }, ["id"]),
    op("object.clone", { id: text, ref: text }, ["id"]),
    op(
      "presentation.create",
      {
        ref: text,
        boardId: text,
        objectId: text,
        x: { type: "number" },
        y: { type: "number" },
        width: size,
        height: size,
        parentId: text,
        appearance,
      },
      ["boardId", "objectId"],
    ),
    op(
      "presentation.update",
      {
        id: text,
        x: { type: "number" },
        y: { type: "number" },
        width: size,
        height: size,
        z: { type: "integer" },
        locked: { type: "boolean" },
        parentId: { type: ["string", "null"] },
        appearance,
      },
      ["id"],
    ),
    op("presentation.delete", { id: text }, ["id"]),
    op(
      "relation.create",
      {
        ref: text,
        kind: text,
        sourceId: text,
        targetId: text,
        status: { enum: ["confirmed", "inferred"] },
        basis: { type: "string" },
        attributes: record,
        evidence: list(record),
      },
      ["kind", "sourceId", "targetId"],
    ),
    op(
      "relation.update",
      {
        id: text,
        expectedVersion,
        status: { enum: ["confirmed", "inferred"] },
        basis: { type: ["string", "null"] },
        attributes: record,
        evidence: list(record),
      },
      ["id"],
    ),
    op("relation.delete", { id: text }, ["id"]),
    op("setting.set", { key: text, value: {} }, ["key", "value"]),
    ...["pack.enable", "pack.disable", "pack.remove"].map((name) =>
      op(name, { id: text }, ["id"]),
    ),
    op("pack.import", { manifest: record }, ["manifest"]),
    op(
      "template.apply",
      {
        templateId: text,
        boardId: text,
        x: { type: "number" },
        y: { type: "number" },
      },
      ["templateId", "boardId"],
    ),
  ],
};
export const PACK_SCHEMA: JsonSchema = obj(
  {
    format: { const: "sand-table-pack" },
    formatVersion: { const: 2 },
    derivedIdPrefix: text,
    id: text,
    title: text,
    version,
    description: { type: "string" },
    types: list(
      obj(
        {
          type: text,
          title: text,
          description: { type: "string" },
          icon: text,
          version,
          schema: { type: "object" },
          capabilities: obj({
            container: { type: "boolean" },
            cover: { type: "boolean" },
          }),
          display: obj(
            {
              material: {
                enum: [
                  "paper",
                  "document",
                  "screen",
                  "gauge",
                  "container",
                  "media",
                ],
              },
              defaultSize: obj({ width: size, height: size }, [
                "width",
                "height",
              ]),
              summary: names,
              view: text,
            },
            ["material", "defaultSize"],
          ),
          relationSlots: list(
            obj(
              {
                key: text,
                label: text,
                kind: text,
                direction: { enum: ["in", "out"] },
                targetTypes: names,
                many: { type: "boolean" },
              },
              ["key", "label", "kind", "direction", "many"],
            ),
          ),
          migrations: list(
            obj({ from: version, migrate: {} }, ["from", "migrate"]),
          ),
        },
        [
          "type",
          "title",
          "description",
          "icon",
          "version",
          "schema",
          "display",
        ],
      ),
    ),
    relationKinds: list(
      obj(
        {
          kind: text,
          title: text,
          inverseTitle: text,
          allowsInferred: { type: "boolean" },
          requiresBasis: { type: "boolean" },
          sourceTypes: names,
          targetTypes: names,
        },
        ["kind", "title", "inverseTitle", "allowsInferred"],
      ),
    ),
    templates: list(
      obj(
        {
          id: text,
          title: text,
          description: { type: "string" },
          commands: list(command),
        },
        ["id", "title", "commands"],
      ),
    ),
    presets: list(
      obj(
        {
          key: text,
          type: text,
          title: text,
          data: { type: "object" },
          width: size,
          height: size,
        },
        ["key", "type", "title"],
      ),
    ),
    registerTools: {},
  },
  ["id", "title", "version"],
);
