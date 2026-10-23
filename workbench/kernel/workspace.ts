// 打开工作空间的统一入口。
//
// 有 workspace.db 就直接开；没有但有 workspace.json（旧版文件）就先导入一次；
// 都没有就新建一个空的。导入器在 kernel/legacy/ 里，它写旧版的字段名，
// 但它只依赖内核自己的东西（docs/kernel-v3/01-data-model.md §9 的 V8）。

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  getMeta,
  openWorkspaceDb,
  setMeta,
  transaction,
  type Db,
} from "./db.ts";
import { auditFrameCoordinates, type FrameCoordAudit } from "./frame-coords.ts";
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
  /**
   * 框内坐标的体检结果。
   *
   * state 是 needs-review 时，库里有说不准是相对还是绝对的框内坐标。
   * 这时候不改任何数据，只是报给人确认。
   */
  frameCoords: FrameCoordAudit;
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
    const { skippedPacks, frameCoords } = prepareOpen(db, registry, now);
    return { db, imported: null, skippedPacks, frameCoords };
  }
  if (existsSync(jsonFile)) {
    const report = importV2(jsonFile, dbFile, registry, now);
    const db = openWorkspaceDb(dbFile, { create: false });
    const { skippedPacks, frameCoords } = prepareOpen(db, registry, now);
    return { db, imported: report, skippedPacks, frameCoords };
  }
  mkdirSync(dir, { recursive: true });
  const db = openWorkspaceDb(dbFile, {
    create: true,
    workspaceId,
    ...(options?.title ? { title: options.title } : {}),
    now,
  });
  const { skippedPacks, frameCoords } = prepareOpen(db, registry, now);
  return { db, imported: null, skippedPacks, frameCoords };
}

/**
 * 框内坐标说不准时记一笔审计。
 *
 * 同一批展示只记一次：每次打开都记一条，审计表就成了噪声，
 * 真要人工确认时反而找不到那一条。
 */
function noteFrameCoordReview(
  db: Db,
  audit: FrameCoordAudit,
  now: () => number,
): void {
  if (audit.state !== "needs-review") return;
  const detail = JSON.stringify({
    items: audit.items.map((item) => item.presentationId),
  });
  const last = db
    .prepare(
      "SELECT detail FROM audit WHERE action = 'frame_coords' ORDER BY seq DESC LIMIT 1",
    )
    .get() as { detail: string | null } | undefined;
  if (last?.detail === detail) return;
  db.prepare(
    "INSERT INTO audit (at, actor, actor_kind, action, history_id, detail) VALUES (?, 'system', 'system', 'frame_coords', NULL, ?)",
  ).run(now(), detail);
}

/**
 * 跳过不合格的包，再同步内置包。
 * 中途失败要把连接关掉，否则这次打开占着文件，调用方重试也进不去。
 */
function prepareOpen(
  db: Db,
  registry: Registry,
  now: () => number,
): { skippedPacks: SkippedPack[]; frameCoords: FrameCoordAudit } {
  try {
    const skippedPacks = skipInvalidPacks(db, registry, now);
    syncPacks(db, registry, IMPORT_ACTOR);
    const frameCoords = auditFrameCoordinates(db);
    noteFrameCoordReview(db, frameCoords, now);
    return { skippedPacks, frameCoords };
  } catch (error) {
    try {
      db.close();
    } catch {
      /* 仍抛出原来的错误 */
    }
    throw error;
  }
}

/**
 * 库里已经有不合格的组件包时，不让整个打开流程失败。
 *
 * syncPacks 装入每个数据包时都要过一遍清单校验，不合格就抛错，于是这个
 * 工作空间以后每次打开都会失败。这里先把不合格的包跳过（软删除这一行，
 * 清单原文还留在库里），再让 syncPacks 装入其余的包。
 *
 * 软删除是一次写入，要占一个新修订号：停在旧修订号的客户端只有看到
 * 修订号往前走才会来拉这次删除。修订号和墓碑在同一个事务里推进。
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
  const broken: { id: string; problem: string }[] = [];
  for (const row of rows) {
    const problem = manifestProblem(row.manifest);
    if (problem) {
      broken.push({ id: row.id, problem });
      continue;
    }
    try {
      staged.registerPack(JSON.parse(row.manifest!), "data");
    } catch (error) {
      broken.push({ id: row.id, problem: problemOf(error) });
    }
  }
  // 没有坏包就不动修订号：打开工作空间不该每次都涨修订号。
  if (!broken.length) return [];
  return transaction(db, () => {
    // 修订号在事务里读。事务外读到的值可能已经被别的写入推进；
    // 非整数也不能当成 0，否则会把修订号写小，客户端漏掉中间的变更。
    const raw = getMeta(db, "revision") ?? "0";
    const rev = Number(raw);
    if (!Number.isInteger(rev) || rev < 0)
      throw new Error(
        `这个工作空间的修订号「${raw}」无法识别，已停止打开。请保留 workspace.db，不要删掉它后重新导入。`,
      );
    const nextRev = rev + 1;
    const skipped = broken.map((item) =>
      skipPack(db, item.id, nextRev, item.problem),
    );
    setMeta(db, "revision", String(nextRev));
    db.prepare(
      "INSERT INTO audit (at, actor, actor_kind, action, history_id, detail) VALUES (?, 'import', 'human', 'pack', NULL, ?)",
    ).run(now(), JSON.stringify({ skipped }));
    return skipped;
  });
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

/**
 * 跳过这个包：软删除这一行，syncPacks 就不会再装入它。
 *
 * rev 是这次删除占的修订号，墓碑和这一行的修订号都记它，
 * 客户端按 rev > N 拉的时候才看得到这次删除。
 */
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
