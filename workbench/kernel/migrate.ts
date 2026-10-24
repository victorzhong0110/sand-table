// 类型版本迁移运行时。
//
// 内置包升级某个类型的结构时（TypeSpec.version 加一并补上 migrations），
// 旧对象在读的时候换成新结构，在写的时候落盘成新结构。
// 迁移函数是纯函数，所以转换只在内存里发生：库里那一行保持原样，
// 直到有人真的改了它的内容。

import type { Registry } from "./registry.ts";
import type { ObjectRow } from "./types.ts";

/** 迁移后数据的字节上限，与内核写入时的限制一致。 */
const DATA_LIMIT = 1024 * 1024;

export type MigrationResult = {
  /** 迁移后的数据；迁移没成功时是原来的数据。 */
  data: Record<string, unknown>;
  /** 迁移后的类型版本；迁移没成功时是原来的版本。 */
  typeVersion: number;
  /** 迁移没成功的原因（中文）。成功时没有这个字段。 */
  error?: string;
};

/** 读到的对象：数据与版本是迁移后的，迁移失败时带着原因。 */
export type MigratedObjectRow = ObjectRow & { migrationError?: string };

/**
 * 把一行对象的数据换成当前类型版本的结构。
 *
 * 类型不存在、数据比当前版本还新（不降级）时原样返回。
 * 缺一步（包括类型升了版却整个没写迁移函数）、函数抛错、结果不是对象、
 * 或者迁完不符合当前 Schema 时，返回原来的数据与原来的版本，并带上原因。
 */
export function migrateData(
  registry: Registry,
  row: ObjectRow,
): MigrationResult {
  const spec = registry.getType(row.type);
  if (!spec) return { data: row.data, typeVersion: row.typeVersion };
  if (row.typeVersion >= spec.version)
    return { data: row.data, typeVersion: row.typeVersion };
  const steps = spec.migrations ?? [];
  // 类型升了版却整个没写迁移函数，等于缺了从旧版本升上来的那一步：数据停在旧版本。
  // 这里必须带原因返回。静默原样返回会让读的人分不出「本来就在当前版本」和
  // 「卡在旧版本了」，写路径也拦不住——新数据会以旧结构落盘，type_version 永远不前进。
  if (steps.length === 0)
    return failed(
      row,
      `缺少从版本 ${row.typeVersion} 升到 ${row.typeVersion + 1} 的迁移函数，「${row.type}」的数据停在版本 ${row.typeVersion}。`,
    );
  const owner = registry
    .listPacks()
    .find((pack) =>
      (pack.spec.types ?? []).some((item) => item.type === row.type),
    );
  // 数据包只能带数据，不能带迁移函数。注册时已经拒过一次，这里再挡一次。
  if (owner?.kind === "data")
    return failed(
      row,
      `数据包「${owner.spec.id}」的类型「${row.type}」不能带迁移函数。`,
    );
  let data = row.data;
  let version = row.typeVersion;
  while (version < spec.version) {
    const step = steps.find((item) => item.from === version);
    if (!step)
      return failed(
        row,
        `缺少从版本 ${version} 升到 ${version + 1} 的迁移函数，「${row.type}」的数据停在版本 ${version}。`,
      );
    if (typeof step.migrate !== "function")
      return failed(
        row,
        `从版本 ${version} 升到 ${version + 1} 的迁移函数不是函数，「${row.type}」的数据停在版本 ${version}。`,
      );
    const migrate = step.migrate;
    let next: unknown;
    try {
      next = migrate(deepCopy(data));
    } catch (error) {
      return failed(
        row,
        `从版本 ${version} 升到 ${version + 1} 时迁移函数抛错：${describe(error)}。「${row.type}」的数据停在版本 ${version}。`,
      );
    }
    if (!isPlainObject(next))
      return failed(
        row,
        `从版本 ${version} 升到 ${version + 1} 后结果不是对象，「${row.type}」的数据停在版本 ${version}。`,
      );
    const size = byteSize(next);
    if (size === null)
      return failed(
        row,
        `从版本 ${version} 升到 ${version + 1} 后的数据无法保存成 JSON，「${row.type}」的数据停在版本 ${version}。`,
      );
    if (size > DATA_LIMIT)
      return failed(
        row,
        `从版本 ${version} 升到 ${version + 1} 后的数据超过 1 MB，「${row.type}」的数据停在版本 ${version}。`,
      );
    data = next;
    version += 1;
  }
  const validated = registry.validateData(row.type, data);
  if (!validated.ok)
    return failed(
      row,
      `迁移后的数据不符合「${row.type}」当前版本的要求：${validated.errors[0]?.message ?? "数据不合格"}。`,
    );
  return { data, typeVersion: version };
}

/** 一行对象按迁移后的数据与版本重新拼一遍，迁移失败时带上原因。 */
export function migrateRow(
  registry: Registry,
  row: ObjectRow,
): MigratedObjectRow {
  const result = migrateData(registry, row);
  return {
    ...row,
    data: result.data,
    typeVersion: result.typeVersion,
    ...(result.error ? { migrationError: result.error } : {}),
  };
}

/** 迁移没成功：原数据、原版本，外加一句原因。 */
function failed(row: ObjectRow, error: string): MigrationResult {
  return { data: row.data, typeVersion: row.typeVersion, error };
}

/** 深拷贝：迁移函数改坏了入参也不影响原来的数据。 */
function deepCopy<T>(value: T): T {
  if (Array.isArray(value)) return value.map(deepCopy) as T;
  if (isPlainObject(value)) {
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) copy[key] = deepCopy(item);
    return copy as T;
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 数据的字节数；存不成 JSON 时没有字节数。 */
function byteSize(value: unknown): number | null {
  try {
    const json = JSON.stringify(value);
    if (typeof json !== "string") return null;
    return Buffer.byteLength(json);
  } catch {
    return null;
  }
}

function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
