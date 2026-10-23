import { DatabaseSync } from "node:sqlite";
import { closeSync, existsSync, openSync, readSync, rmSync } from "node:fs";
import { newId } from "./ids.ts";
import { MIGRATIONS, SCHEMA_VERSION } from "./schema.ts";

export type Db = DatabaseSync;

const SQLITE_MAGIC = Buffer.from("SQLite format 3\0", "utf8");
const depth = new WeakMap<Db, number>();

export class WorkspaceOpenError extends Error {
  code: "MISSING" | "NOT_SQLITE" | "TOO_NEW" | "MIGRATION_FAILED";

  constructor(
    code: WorkspaceOpenError["code"],
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "WorkspaceOpenError";
    this.code = code;
  }
}

export function openWorkspaceDb(
  file: string,
  options: {
    create: boolean;
    workspaceId?: string;
    title?: string;
    now?: () => number;
  },
): Db {
  if (!existsSync(file)) {
    if (!options.create)
      throw new WorkspaceOpenError(
        "MISSING",
        "这个路径上还没有工作空间数据库，也没有新建它。",
      );
    if (!options.workspaceId)
      throw new Error("新建工作空间时必须提供 workspaceId。");
    const workspaceId = options.workspaceId;
    const db = new DatabaseSync(file);
    try {
      applyPragmas(db);
      const now = (options.now ?? Date.now)();
      const homeId = newId();
      transaction(db, () => {
        for (const sql of MIGRATIONS) db.exec(sql);
        const insert = db.prepare(
          "INSERT INTO meta (key, value) VALUES (?, ?)",
        );
        for (const [key, value] of [
          ["schema_version", String(SCHEMA_VERSION)],
          ["workspace_id", workspaceId],
          ["title", options.title ?? "未命名工作空间"],
          ["created_at", String(now)],
          ["home_board_id", homeId],
          ["revision", "0"],
          ["history_cursor", ""],
          ["tombstone_floor", "0"],
        ])
          insert.run(key, value);
        db.prepare(
          `INSERT INTO objects (
             id, type, title, data, created_at, created_by, updated_at, updated_by, rev
           ) VALUES (?, 'base.board', '首页', '{}', ?, 'system', ?, 'system', 0)`,
        ).run(homeId, now, now);
      });
      return db;
    } catch (error) {
      try {
        db.close();
      } catch {
        /* 连接可能已经关掉 */
      }
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          rmSync(file + suffix);
        } catch {
          /* 半成品文件可能不存在 */
        }
      }
      if (error instanceof WorkspaceOpenError) throw error;
      throw new WorkspaceOpenError(
        "MIGRATION_FAILED",
        "新建工作空间的数据库没有建起来，已删掉半成品文件。请换一个路径再试。",
        { cause: error },
      );
    }
  }
  if (!isSqliteFile(file))
    throw new WorkspaceOpenError(
      "NOT_SQLITE",
      "这个文件不是 SQLite 数据库，已保持原样。请换一个工作空间文件，或新建一个工作空间。",
    );
  const db = new DatabaseSync(file);
  try {
    applyPragmas(db);
    const version = readVersion(db);
    if (version > SCHEMA_VERSION) {
      throw new WorkspaceOpenError(
        "TOO_NEW",
        `这个工作空间的数据库版本是 ${version}，当前程序只支持到版本 ${SCHEMA_VERSION}。请用更新版本的 Sand Table 打开，不要继续用当前版本写入。`,
      );
    }
    if (version < SCHEMA_VERSION) {
      try {
        transaction(db, () => {
          for (let i = version; i < SCHEMA_VERSION; i++) {
            const sql = MIGRATIONS[i];
            if (!sql)
              throw new Error(`缺少从版本 ${i} 升级到 ${i + 1} 的迁移。`);
            db.exec(sql);
          }
          setMeta(db, "schema_version", String(SCHEMA_VERSION));
        });
      } catch (error) {
        throw new WorkspaceOpenError(
          "MIGRATION_FAILED",
          `工作空间数据库从版本 ${version} 升级到 ${SCHEMA_VERSION} 失败，已回滚。请保留原文件，不要把它当成空工作空间。`,
          { cause: error },
        );
      }
    }
    return db;
  } catch (error) {
    try {
      db.close();
    } catch {
      /* 连接可能已经关掉 */
    }
    throw error;
  }
}

export function transaction<T>(db: Db, fn: () => T): T {
  if ((depth.get(db) ?? 0) > 0) throw new Error("不能在事务里再开启事务。");
  depth.set(db, 1);
  let started = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    started = true;
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (started) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* 仍抛出事务里原来的错误 */
      }
    }
    throw error;
  } finally {
    depth.set(db, 0);
  }
}

export function getMeta(db: Db, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    { value: string } | undefined;
  return row?.value;
}

export function setMeta(db: Db, key: string, value: string): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

function applyPragmas(db: Db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA synchronous = NORMAL;
  `);
}

function readVersion(db: Db): number {
  let raw: string | undefined;
  try {
    raw = getMeta(db, "schema_version");
  } catch (error) {
    throw new WorkspaceOpenError(
      "MIGRATION_FAILED",
      "工作空间数据库里没有可读的版本号，无法安全升级。请保留原文件。",
      { cause: error },
    );
  }
  if (raw === undefined) return 0;
  if (!/^\d+$/.test(raw))
    throw new WorkspaceOpenError(
      "MIGRATION_FAILED",
      `工作空间数据库的版本号「${raw}」无法识别，已停止打开。请保留原文件。`,
    );
  return Number(raw);
}

function isSqliteFile(file: string) {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(16);
    const read = readSync(fd, buf, 0, 16, 0);
    return read === 16 && buf.equals(SQLITE_MAGIC);
  } finally {
    closeSync(fd);
  }
}
