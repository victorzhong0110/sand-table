// 打开工作空间的统一入口。
//
// 有 workspace.db 就直接开；没有但有 workspace.json（旧版文件）就先导入一次；
// 都没有就新建一个空的。导入器在 kernel/legacy/ 里，它写旧版的字段名，
// 但它只依赖内核自己的东西（docs/kernel-v3/01-data-model.md §9 的 V8）。

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { openWorkspaceDb, type Db } from "./db.ts";
import { importV2, type ImportReport } from "./legacy/import-v2.ts";
import { syncPacks } from "./packs-state.ts";
import type { Registry } from "./registry.ts";
import type { Actor } from "./types.ts";

/** 导入时写库的账号：不是人也不是助手，是系统自己。 */
const SYSTEM_ACTOR: Actor = { id: "system", kind: "human" };

/** 打开结果。imported 不是空就说明这次是从旧版文件导入的。 */
export type OpenWorkspaceResult = {
  db: Db;
  imported: ImportReport | null;
};

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
    syncPacks(db, registry, SYSTEM_ACTOR);
    return { db, imported: null };
  }
  if (existsSync(jsonFile)) {
    const report = importV2(jsonFile, dbFile, registry, now);
    const db = openWorkspaceDb(dbFile, { create: false });
    syncPacks(db, registry, SYSTEM_ACTOR);
    return { db, imported: report };
  }
  mkdirSync(dir, { recursive: true });
  const db = openWorkspaceDb(dbFile, {
    create: true,
    workspaceId,
    ...(options?.title ? { title: options.title } : {}),
    now,
  });
  syncPacks(db, registry, SYSTEM_ACTOR);
  return { db, imported: null };
}
