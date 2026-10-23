import { applySystemCommands } from "./commands.ts";
import type { Db } from "./db.ts";
import { CommandError } from "./errors.ts";
import { PackSpecError } from "./registry.ts";
import type { Registry } from "./registry.ts";
import type { Actor } from "./types.ts";

const CODE_PACK = "code";

export function syncPacks(db: Db, registry: Registry, actor: Actor): void {
  const commands: {
    op: "pack.sync_builtin";
    id: string;
    version: number;
    enabledByDefault: boolean;
  }[] = [];
  for (const pack of registry.listPacks()) {
    if (pack.kind !== "builtin") continue;
    if (!needsSync(db, pack.spec.id, pack.spec.version)) continue;
    commands.push({
      op: "pack.sync_builtin" as const,
      id: pack.spec.id,
      version: pack.spec.version,
      enabledByDefault: pack.spec.id !== CODE_PACK,
    });
  }
  if (commands.length) applySystemCommands(db, registry, { actor, commands });
  const rows = db
    .prepare(
      "SELECT id, manifest FROM packs WHERE kind = 'data' AND deleted_rev IS NULL",
    )
    .all() as { id: string; manifest: string | null }[];
  for (const row of rows) {
    if (!row.manifest) {
      throw new CommandError(
        "INTERNAL",
        `组件包「${row.id}」没有清单，无法装入注册表。`,
        null,
      );
    }
    let manifest: unknown;
    try {
      manifest = JSON.parse(row.manifest);
    } catch {
      throw new CommandError(
        "INVALID_DATA",
        `组件包「${row.id}」的清单不是合法 JSON，没有装入。`,
        null,
      );
    }
    try {
      registry.registerPack(manifest, "data");
    } catch (error) {
      if (error instanceof PackSpecError) {
        throw new CommandError(
          "INVALID_DATA",
          `组件包「${row.id}」的清单不合格，没有装入：${error.problems[0]?.message ?? error.message}`,
          null,
          {
            path: error.problems[0]?.path,
            message: error.problems[0]?.message ?? error.message,
          },
        );
      }
      throw error;
    }
  }
}

export function isPackEnabled(db: Db, packId: string): boolean {
  const row = db
    .prepare("SELECT enabled FROM packs WHERE id = ? AND deleted_rev IS NULL")
    .get(packId) as { enabled: number } | undefined;
  return row?.enabled === 1;
}

function needsSync(db: Db, id: string, version: number) {
  const row = db
    .prepare(
      "SELECT kind, version FROM packs WHERE id = ? AND deleted_rev IS NULL",
    )
    .get(id) as { kind: string; version: number } | undefined;
  if (!row) return true;
  if (row.kind !== "builtin") return true;
  return Number(row.version) !== version;
}
