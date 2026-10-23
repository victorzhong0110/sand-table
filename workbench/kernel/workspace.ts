// 打开工作空间的统一入口。
//
// 有 workspace.db 就直接开；没有但有 workspace.json（旧版文件）就先导入一次；
// 都没有就新建一个空的。导入器在 kernel/legacy/ 里，它写旧版的字段名，
// 但它只依赖内核自己的东西（docs/kernel-v3/01-data-model.md §9 的 V8）。

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getMeta, openWorkspaceDb, type Db } from "./db.ts";
import { importV2, type ImportReport } from "./legacy/import-v2.ts";
import { syncPacks } from "./packs-state.ts";
import { createRegistry, PackSpecError, type Registry } from "./registry.ts";
import type { Actor } from "./types.ts";

/**
 * 卡片没有给 openWorkspace 的调用者。同步内置包必须有 actor，
 * 这条路径统一用「import」。
 */
const IMPORT_ACTOR: Actor = { id: "import", kind: "human" };

/** 打开结果。imported 不是空就说明这次是从旧版文件导入的。 */
export type OpenWorkspaceResult = {
  db: Db;
  imported: ImportReport | null;
  /** 库里不合格、被跳过的组件包。空数组表示没有。 */
  skippedPacks: SkippedPack[];
};

/** 一个被跳过的组件包：id 与能照着做的提示。 */
export type SkippedPack = { id: string; reason: string };

/**
 * 打开一个工作空间。
 *
 * root 是工作空间的根目录，工作空间自己的目录是 `<root>/<workspaceId>/`；
 * 数据库在 `<root>/<workspaceId>/workspace.db`，旧版文件在同目录的 workspace.json。
 *
 * registry 应当已经注册好内置包：内置包要靠它同步，导入器也要靠它判断类型版本。
 */
export function openWorkspace(
  root: string,
  workspaceId: string,
  registry: Registry,
  options?: { title?: string; now?: () => number },
): OpenWorkspaceResult {
  const now = options?.now ?? Date.now;
  const dir = join(root, workspaceId);
  const dbFile = join(dir, "workspace.db");
  const jsonFile = join(dir, "workspace.json");
  if (existsSync(dbFile)) {
    const db = openWorkspaceDb(dbFile, { create: false });
    const skippedPacks = skipInvalidPacks(db, registry, now);
    syncPacks(db, registry, IMPORT_ACTOR);
    return { db, imported: null, skippedPacks };
  }
  if (existsSync(jsonFile)) {
    const report = importV2(jsonFile, dbFile, registry, now);
    const db = openWorkspaceDb(dbFile, { create: false });
    const skippedPacks = skipInvalidPacks(db, registry, now);
    syncPacks(db, registry, IMPORT_ACTOR);
    return { db, imported: report, skippedPacks };
  }
  mkdirSync(dir, { recursive: true });
  const db = openWorkspaceDb(dbFile, {
    create: true,
    workspaceId,
    ...(options?.title ? { title: options.title } : {}),
    now,
  });
  const skippedPacks = skipInvalidPacks(db, registry, now);
  syncPacks(db, registry, IMPORT_ACTOR);
  return { db, imported: null, skippedPacks };
}

/**
 * 库里已经有不合格的组件包时，不让整个打开流程失败。
 *
 * syncPacks 装入每个数据包时都要过一遍清单校验，不合格就抛错，于是这个
 * 工作空间以后每次打开都会失败。这里先把不合格的包跳过（软删除这一行，
 * 清单原文还留在库里），再让 syncPacks 装入其余的包。
 */
function skipInvalidPacks(
  db: Db,
  registry: Registry,
  now: () => number,
): SkippedPack[] {
  const rows = db
    .prepare(
      "SELECT id, manifest FROM packs WHERE kind = 'data' AND deleted_rev IS NULL ORDER BY rowid",
    )
    .all() as { id: string; manifest: string | null }[];
  if (!rows.length) return [];
  const staged = createRegistry();
  for (const pack of registry.listPacks())
    staged.registerPack(pack.spec, pack.kind);
  const rev = Number(getMeta(db, "revision") ?? "0") || 0;
  const skipped: SkippedPack[] = [];
  for (const row of rows) {
    const problem = manifestProblem(row.manifest);
    if (problem) {
      skipped.push(skipPack(db, row.id, rev, problem));
      continue;
    }
    try {
      staged.registerPack(JSON.parse(row.manifest!), "data");
    } catch (error) {
      skipped.push(skipPack(db, row.id, rev, problemOf(error)));
    }
  }
  if (skipped.length)
    db.prepare(
      "INSERT INTO audit (at, actor, actor_kind, action, history_id, detail) VALUES (?, 'import', 'human', 'pack', NULL, ?)",
    ).run(now(), JSON.stringify({ skipped }));
  return skipped;
}

/** 清单本身的问题：不是合法 JSON，或没有清单。 */
function manifestProblem(manifest: string | null): string | undefined {
  if (!manifest) return "这个包没有清单。";
  try {
    JSON.parse(manifest);
  } catch {
    return "这个包的清单不是合法的 JSON。";
  }
  return undefined;
}

function problemOf(error: unknown): string {
  if (error instanceof PackSpecError)
    return (error.problems[0]?.message ?? error.message).replace(/。$/, "");
  return error instanceof Error ? error.message : String(error);
}

/** 跳过这个包：软删除这一行，syncPacks 就不会再装入它。 */
function skipPack(
  db: Db,
  id: string,
  rev: number,
  problem: string,
): SkippedPack {
  db.prepare("UPDATE packs SET deleted_rev = ?, rev = ? WHERE id = ?").run(
    rev,
    rev,
    id,
  );
  return {
    id,
    reason: `组件包「${id}」的清单不合格（${problem}），已跳过。请检查这个工作空间的组件包，或删掉 workspace.db 后重新导入。`,
  };
}
