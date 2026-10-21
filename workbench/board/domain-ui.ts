// Browser registration is deliberately light: do not import the code indexer/server entry.
import {
  registerDomainPack,
  findObjectType,
  listDomainPacks,
} from "../core/domains.ts";
import { novelPack } from "../domains/novel/index.ts";
import { researchPack } from "../domains/research/index.ts";
import { componentTypes, defaultData } from "../core/spaces.ts";
registerDomainPack(novelPack);
registerDomainPack(researchPack);
export function paletteTypes(): { type: string; title: string }[] {
  const builtins = new Set<string>(componentTypes.map((t) => t.type));
  return [
    ...componentTypes,
    ...listDomainPacks()
      .flatMap((p) => p.componentTypes ?? [])
      .filter((t) => !builtins.has(t.type)),
  ];
}
export function initialData(
  type: string,
  title: string,
): Record<string, unknown> {
  const data = structuredClone(defaultData(type));
  for (const field of findObjectType(type)?.fields ?? [])
    if (
      field.required &&
      ["text", "longtext"].includes(field.kind) &&
      !data[field.key]
    )
      data[field.key] = title;
  return data;
}
