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
export const PACK_SCHEMA: JsonSchema = obj(
  {
    format: { const: "sand-table-pack" },
    formatVersion: { const: 2 },
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
          commands: list({
            type: "object",
            required: ["op"],
            properties: { op: text },
          }),
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
