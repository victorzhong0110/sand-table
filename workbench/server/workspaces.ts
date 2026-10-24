// v3 的工作空间：根目录下的每个子目录是一个工作空间。
//
// 切换工作空间 = 打开目标数据库、关掉当前数据库；内核没有「切换」这个概念，
// 这里只负责开关连接和改 meta.title。

import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  CommandError,
  exportWorkspaceBundle,
  getMeta,
  importWorkspaceBundle,
  newId,
  openWorkspace,
  openWorkspaceDb,
  setMeta,
  type BundleFile,
  type BundleImportReport,
  type Db,
  type Registry,
} from "../kernel/index.ts";

/** 工作空间编号要能当目录名用。 */
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/**
 * 工作空间编号过同一道关。
 *
 * 先看编号拼出来的路径还在不在根目录下面，再看编号本身合不合规：
 * 越界是最危险的一种，先挡掉。两道关都过才放行。
 */
function assertWorkspaceId(root: string, id: string): void {
  const base = resolve(root);
  const inside = relative(base, resolve(base, id));
  if (
    !inside ||
    inside === ".." ||
    inside.startsWith(`..${sep}`) ||
    isAbsolute(inside)
  )
    throw new CommandError(
      "FORBIDDEN",
      `工作空间编号「${id}」指向的位置不在工作空间根目录里面，不能这样操作。请先列出工作空间，用列表里的编号再试。`,
      null,
    );
  if (!ID.test(id))
    throw new CommandError(
      "INVALID_DATA",
      "工作空间编号只能以字母或数字开头，后面用字母、数字、连字符或下划线，最长 64 位。请先列出工作空间，用列表里的编号再试。",
      null,
    );
}

/** 当前打开的工作空间。切换工作空间就是换掉这一份。 */
export type WorkspaceSession = {
  registry: Registry;
  root: string;
  workspaceId: string;
  db: Db;
};

export type WorkspaceSummary = {
  id: string;
  title: string;
  current: boolean;
};

/**
 * 列出根目录下的工作空间。
 *
 * 损坏的工作空间跳过并点名，不影响其他条目。
 */
export function listWorkspaces(
  root: string,
  currentId: string,
): {
  workspaces: WorkspaceSummary[];
  errors: { id: string; message: string }[];
} {
  const workspaces: WorkspaceSummary[] = [];
  const errors: { id: string; message: string }[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return { workspaces, errors };
  }
  for (const id of names.sort()) {
    const file = join(root, id, "workspace.db");
    if (!existsSync(file)) continue;
    let db: Db | null = null;
    try {
      db = openWorkspaceDb(file, { create: false });
      workspaces.push({
        id: getMeta(db, "workspace_id") ?? id,
        title: getMeta(db, "title") ?? id,
        current: id === currentId,
      });
    } catch (error) {
      errors.push({
        id,
        message:
          error instanceof Error
            ? error.message
            : "这个工作空间打不开，已跳过。",
      });
    } finally {
      db?.close();
    }
  }
  return { workspaces, errors };
}

/** 新建一个空白工作空间；不切换过去。 */
export function createWorkspace(
  root: string,
  registry: Registry,
  options: { id?: string; title?: string },
): { id: string; title: string } {
  const id = options.id ?? newId();
  assertWorkspaceId(root, id);
  if (existsSync(join(root, id)))
    throw new CommandError(
      "INVALID_DATA",
      `工作空间「${id}」已经存在。请换一个编号，或者直接打开它。`,
      null,
    );
  mkdirSync(join(root, id), { recursive: true });
  const opened = openWorkspace(
    root,
    id,
    registry,
    options.title ? { title: options.title } : undefined,
  );
  const title = getMeta(opened.db, "title") ?? id;
  opened.db.close();
  return { id, title };
}

/**
 * 切换到另一个工作空间。
 *
 * 先打开目标再关当前的：目标打不开时，当前工作空间还在用，不会把人丢在半路。
 */
export function switchWorkspace(
  session: WorkspaceSession,
  id: string,
): WorkspaceSession {
  assertWorkspaceId(session.root, id);
  const file = join(session.root, id, "workspace.db");
  if (!existsSync(file))
    throw new CommandError(
      "NOT_FOUND",
      `找不到工作空间「${id}」。请先列出工作空间，再切换到一个存在的。`,
      null,
    );
  const opened = openWorkspace(session.root, id, session.registry);
  session.db.close();
  return {
    registry: session.registry,
    root: session.root,
    workspaceId: id,
    db: opened.db,
  };
}

/** 改工作空间标题。 */
export function renameWorkspace(
  session: WorkspaceSession,
  id: string,
  title: string,
): { id: string; title: string } {
  assertWorkspaceId(session.root, id);
  if (!title.trim())
    throw new CommandError(
      "INVALID_DATA",
      "工作空间标题不能为空。请写一个标题再试。",
      null,
    );
  const own = id === session.workspaceId;
  const db = own ? session.db : openOther(session, id);
  try {
    setMeta(db, "title", title);
  } finally {
    if (!own) db.close();
  }
  return { id, title };
}

/** 删除工作空间。当前正在用的不能删。 */
export function deleteWorkspace(
  session: WorkspaceSession,
  id: string,
): { id: string; deleted: true } {
  assertWorkspaceId(session.root, id);
  if (id === session.workspaceId)
    throw new CommandError(
      "FORBIDDEN",
      "不能删除当前正在使用的工作空间。请先切换到别的工作空间，再删除它。",
      null,
    );
  const dir = join(session.root, id);
  if (!existsSync(dir))
    throw new CommandError(
      "NOT_FOUND",
      `找不到工作空间「${id}」。请先列出工作空间，再删除一个存在的。`,
      null,
    );
  rmSync(dir, { recursive: true, force: true });
  return { id, deleted: true };
}

/** 导出当前打开的工作空间。返回文件名和 JSON 文本。 */
export function exportWorkspace(session: WorkspaceSession): BundleFile {
  return exportWorkspaceBundle(session.db);
}

/**
 * 从 JSON 文本导入一个新的工作空间。
 *
 * 不切换过去，也不覆盖已有目录。
 */
export function importWorkspace(
  session: WorkspaceSession,
  json: string,
): BundleImportReport {
  return importWorkspaceBundle(session.root, session.registry, json);
}

function openOther(session: WorkspaceSession, id: string): Db {
  const file = join(session.root, id, "workspace.db");
  if (!existsSync(file))
    throw new CommandError(
      "NOT_FOUND",
      `找不到工作空间「${id}」。请先列出工作空间，再操作一个存在的。`,
      null,
    );
  return openWorkspaceDb(file, { create: false });
}
