// 领域包注册表：**机制**，不含任何领域语义。
//
// 契约见 docs/architecture/domain-packs.zh-CN.md。
// 领域包（类型/组件/关系/工具/模板）由 workbench/domains/<pack>/ 提供，
// 在启动时注册进来；内核只认这张表。
//
// 这里刻意不 import core/spaces.ts：注册表不认识「原生类型」是什么，
// 内置原生类型也当作一个普通领域包注册（见 server/main.ts）。

import type {
  DomainComponentType,
  DomainObjectType,
  DomainPack,
  DomainRelationType,
  DomainTemplate,
} from "./objects.ts";

const packs = new Map<string, DomainPack>();

/** 注册一个领域包。同 id 覆盖旧包（热重载与测试用）。 */
export function registerDomainPack(pack: DomainPack): void {
  if (!pack || typeof pack.id !== "string" || !pack.id.trim())
    throw new Error("领域包必须有非空 id。");
  if (typeof pack.version !== "number" || !Number.isFinite(pack.version))
    throw new Error(`领域包「${pack.id}」缺少合法的 version。`);
  const seen = new Set<string>();
  for (const t of pack.objectTypes ?? []) {
    if (!t || typeof t.type !== "string" || !t.type.trim())
      throw new Error(`领域包「${pack.id}」里有缺少 type 的对象类型。`);
    if (seen.has(t.type))
      throw new Error(`领域包「${pack.id}」重复声明对象类型「${t.type}」。`);
    seen.add(t.type);
  }
  packs.set(pack.id, pack);
}

/** 列出已注册的领域包。 */
export function listDomainPacks(): DomainPack[] {
  return [...packs.values()];
}

/** 取一个领域包。 */
export function getDomainPack(id: string): DomainPack | undefined {
  return packs.get(id);
}

/** 按类型名找对象类型定义。 */
export function findObjectType(type: string): DomainObjectType | undefined {
  for (const pack of packs.values()) {
    const found = pack.objectTypes?.find((t) => t.type === type);
    if (found) return found;
  }
  return undefined;
}

/** 按类型名找组件定义。 */
export function findComponentType(
  type: string,
): DomainComponentType | undefined {
  for (const pack of packs.values()) {
    const found = pack.componentTypes?.find((t) => t.type === type);
    if (found) return found;
  }
  return undefined;
}

/** 按关系类型名找定义。 */
export function findRelationType(kind: string): DomainRelationType | undefined {
  for (const pack of packs.values()) {
    const found = pack.relationTypes?.find((t) => t.kind === kind);
    if (found) return found;
  }
  return undefined;
}

/** 领域校验：没有领域规则时返回空数组（不是失败）。 */
export function checkDomainData(
  type: string,
  data: Record<string, unknown>,
): string[] {
  const spec = findObjectType(type);
  if (!spec?.check) return [];
  try {
    return spec.check(data ?? {}) ?? [];
  } catch (error) {
    return [
      `领域规则执行失败：${error instanceof Error ? error.message : String(error)}`,
    ];
  }
}

/**
 * 关系级校验入口。
 *
 * 「推测性关系必须给依据」「支持/反驳必须给依据」这类规则，
 * 以前只能住在领域包自己的函数里，调用方要记得调——没有强制点。
 * 现在写路径统一走这里，规则不登记就等于没有要求。
 */
export function checkDomainRelation(
  kind: string,
  relation: {
    status?: "confirmed" | "inferred";
    basis?: string;
    attributes?: Record<string, unknown>;
    evidence?: unknown[];
  },
): string[] {
  const spec = findRelationType(kind);
  if (!spec) return [];
  try {
    const check = (spec as { check?: (r: unknown) => string[] }).check;
    return typeof check === "function" ? (check(relation) ?? []) : [];
  } catch (error) {
    return [
      `领域规则执行失败：${error instanceof Error ? error.message : String(error)}`,
    ];
  }
}

/** 列出所有可用模板。模板是可选起点，不是强制流程。 */
export function listTemplates(): {
  packId: string;
  template: DomainTemplate;
}[] {
  const out: { packId: string; template: DomainTemplate }[] = [];
  for (const pack of packs.values()) {
    for (const template of pack.templates ?? [])
      out.push({ packId: pack.id, template });
  }
  return out;
}

/** 清空注册表。测试用。 */
export function resetDomainPacks(): void {
  packs.clear();
}
