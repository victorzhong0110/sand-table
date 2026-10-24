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
 * 缺一步（包括类型升了版却整个没写迁移函数）、函数抛错、结果不是普通对象、
 * 存不成原来的 JSON、超过 1 MB，或者迁完不符合当前 Schema 时，
 * 返回原来的数据与原来的版本，并带上原因。原因写卡住的那一步和实际保留的原版本。
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
    return preserved(
      row,
      `缺少从版本 ${row.typeVersion} 升到 ${row.typeVersion + 1} 的迁移函数。`,
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
      return preserved(
        row,
        `缺少从版本 ${version} 升到 ${version + 1} 的迁移函数。`,
      );
    if (typeof step.migrate !== "function")
      return preserved(
        row,
        `从版本 ${version} 升到 ${version + 1} 的迁移函数不是函数。`,
      );
    const migrate = step.migrate;
    let next: unknown;
    try {
      next = migrate(deepCopy(data));
    } catch (error) {
      return preserved(
        row,
        `从版本 ${version} 升到 ${version + 1} 时迁移函数抛错：${describe(error)}。`,
      );
    }
    const encoded = encodeObject(next);
    if (!encoded.ok)
      return preserved(
        row,
        encoded.kind === "not-object"
          ? `从版本 ${version} 升到 ${version + 1} 后结果不是普通对象。`
          : `从版本 ${version} 升到 ${version + 1} 后的数据无法原样保存成 JSON。`,
      );
    if (encoded.bytes > DATA_LIMIT)
      return preserved(
        row,
        `从版本 ${version} 升到 ${version + 1} 后的数据超过 1 MB。`,
      );
    data = encoded.data;
    version += 1;
  }
  const validated = registry.validateData(row.type, data);
  if (!validated.ok)
    return preserved(
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

/** 失败时写明保留的是原版本。中间步骤成功也不会留下来。 */
function preserved(row: ObjectRow, reason: string): MigrationResult {
  return failed(
    row,
    `${reason}「${row.type}」仍是版本 ${row.typeVersion}，数据没有改。`,
  );
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
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * 迁出来的数据必须能原样存成 JSON。
 * Date、类实例、toJSON、NaN、循环引用都会在保存时变成别的值，这里直接拒绝。
 * 成功时返回解析后的副本，调用方改结果不会改到迁移函数手里的那份。
 */
function encodeObject(
  value: unknown,
):
  | { ok: true; data: Record<string, unknown>; bytes: number }
  | { ok: false; kind: "not-object" | "invalid" } {
  if (!isPlainObject(value)) return { ok: false, kind: "not-object" };
  let json: string;
  try {
    const encoded = JSON.stringify(value);
    if (typeof encoded !== "string") return { ok: false, kind: "invalid" };
    json = encoded;
  } catch {
    return { ok: false, kind: "invalid" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, kind: "invalid" };
  }
  if (!isPlainObject(parsed) || !sameTree(value, parsed))
    return { ok: false, kind: "invalid" };
  return { ok: true, data: parsed, bytes: Buffer.byteLength(json) };
}

function sameTree(value: unknown, parsed: unknown): boolean {
  if (value === parsed) return true;
  if (Array.isArray(value) || Array.isArray(parsed)) {
    if (!Array.isArray(value) || !Array.isArray(parsed)) return false;
    if (value.length !== parsed.length) return false;
    return value.every((item, index) => sameTree(item, parsed[index]));
  }
  if (isPlainObject(value) && isPlainObject(parsed)) {
    const keys = Object.keys(value);
    if (keys.length !== Object.keys(parsed).length) return false;
    return keys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(parsed, key) &&
        sameTree(value[key], parsed[key]),
    );
  }
  return false;
}

function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
