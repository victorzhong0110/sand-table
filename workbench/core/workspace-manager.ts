// 多工作空间管理器：根目录层面的编排（列、建、开、改名、删、切）。
// 契约见 docs/architecture/workspace-management.zh-CN.md 第 3 节（不变量 J6–J8）。
//
// 分工：管理器只管目录层，不碰板面状态。
// 运行期的白板状态（谁在编辑、怎么落盘、怎么换成另一个工作空间）
// 由宿主通过 host 端口接进来——本模块不直接依赖 core/store.ts，
// 这样存储线与内核线不会互相锁死。
//
// 约束：只用 node 内置模块；不使用 enum / namespace / 参数属性 / 装饰器。

import { randomUUID } from "node:crypto";
import { rmSync, statSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import {
  migrate,
  nodeWorkspaceFileSystem,
  WorkspaceConflictError,
  WorkspaceError,
  WorkspaceNotFoundError,
  WorkspaceStore,
} from "./workspace.ts";
import type { WorkspaceFile, WorkspaceFileSystem } from "./workspace.ts";
import {
  nodeIsProcessAlive,
  readLockHolder,
  WorkspaceLock,
  WorkspaceLockError,
  workspaceLockPath,
} from "./workspace-lock.ts";
import type { LockFileStat, WorkspaceLockOptions } from "./workspace-lock.ts";
import type { WorkspaceDescriptor, WorkspaceSnapshot } from "./objects.ts";

/**
 * 管理器用的文件接口。
 * 在 core/workspace.ts 的 WorkspaceFileSystem 基础上补三样：
 * stat 要带 mtimeMs（判断陈旧锁）、要能按 fd 写（写锁文件）、要能递归删目录。
 */
export type WorkspaceManagerFileSystem = Omit<
  WorkspaceFileSystem,
  "statSync"
> & {
  statSync(path: string): LockFileStat;
  writeSync(fd: number, data: string): void;
  rmSync(path: string, options: { recursive: boolean; force: boolean }): void;
};

/** 默认文件实现。 */
export const nodeWorkspaceManagerFileSystem: WorkspaceManagerFileSystem = {
  ...nodeWorkspaceFileSystem,
  statSync: (target) => statSync(target),
  writeSync: (fd, data) => {
    writeSync(fd, data);
  },
  rmSync: (target, options) => {
    rmSync(target, options);
  },
};

/**
 * 宿主端口：管理器要切换活动工作空间时，需要的四件事。
 *
 * 由负责人接线（core/store.ts 的 BoardStore 已经具备这些能力）：
 * - currentWorkspaceId：现在编辑的是哪个工作空间；
 * - flush：把当前工作空间的未保存内容落盘（失败必须抛错，不能只记录）；
 * - restore：用目标工作空间的内容替换运行期状态；
 * - attach：把持久化目标换绑到新的工作空间 id。
 */
export type WorkspaceHost = {
  currentWorkspaceId(): string | undefined;
  /**
   * 把当前工作空间的未保存内容落盘（失败必须抛错，不能只记录）。
   *
   * 允许返回 Promise：跨进程锁的等待是异步的，
   * 切换必须等落盘真的完成再加载目标，否则会丢当前正在编辑的内容。
   */
  flush(): void | Promise<void>;
  restore(snapshot: WorkspaceSnapshot): void;
  attach(workspaceId: string): void;
};

/** list() 的结果：可用条目 + 被跳过的损坏工作空间。 */
export type WorkspaceListResult = {
  workspaces: WorkspaceDescriptor[];
  errors: { id: string; reason: string }[];
};

/** open() 的结果。recovered 为 true 表示内容来自备份，必须显式告警。 */
export type WorkspaceOpenResult = {
  workspace: WorkspaceFile;
  recovered: boolean;
  reason?: string;
};

export type WorkspaceManagerOptions = {
  /** 工作空间根目录。<root>/<id>/workspace.json */
  root: string;
  /** 宿主端口。没有它就只能在目录层操作，switch() 会拒绝。 */
  host?: WorkspaceHost;
  fs?: WorkspaceManagerFileSystem;
  now?: () => number;
  /** 锁相关设置。与 core/workspace-lock.ts 的默认值一致。 */
  lock?: Omit<WorkspaceLockOptions, "fs" | "now">;
};

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * 多工作空间管理器。
 *
 * 目录布局：<root>/<id>/workspace.json，锁在 <root>/<id>/workspace.lock。
 * 管理器不认识「锁文件」是内容的一部分——它只是并发写的门票。
 */
export class WorkspaceManager {
  /** 根目录。 */
  readonly root: string;
  /** 存储层：原子写、迁移、备份回退都走它。 */
  readonly store: WorkspaceStore;
  private readonly host?: WorkspaceHost;
  private readonly fs: WorkspaceManagerFileSystem;
  private readonly now: () => number;
  private readonly lockOptions: Omit<WorkspaceLockOptions, "fs" | "now">;
  /** 本机主机名。判断「持有者是不是本机的进程」要用。 */
  private readonly hostName: string;
  /** 已经 create 过但还没落盘的 id：防止同一进程里建出两个同名的。 */
  private readonly reserved = new Set<string>();

  constructor(options: WorkspaceManagerOptions) {
    if (typeof options?.root !== "string" || !options.root.trim())
      throw new WorkspaceError("workspace root must be a non-empty path");
    this.root = resolve(options.root);
    this.fs = options.fs ?? nodeWorkspaceManagerFileSystem;
    this.store = new WorkspaceStore(this.root, {
      now: options.now,
      fs: this.fs,
    });
    this.host = options.host;
    this.now = options.now ?? Date.now;
    this.lockOptions = options.lock ?? {};
    this.hostName = this.lockOptions.host ?? hostname();
  }

  /**
   * 列出根目录下的所有工作空间。
   * 单个损坏的工作空间只影响它自己：跳过并记进 errors，其余照常列出。
   */
  list(): WorkspaceListResult {
    const workspaces: WorkspaceDescriptor[] = [];
    const errors: { id: string; reason: string }[] = [];
    if (!this.fs.existsSync(this.root)) return { workspaces, errors };
    let entries: string[];
    try {
      entries = this.fs.readdirSync(this.root);
    } catch (error) {
      errors.push({
        id: this.root,
        reason: `工作空间根目录读不出来：${describe(error)}`,
      });
      return { workspaces, errors };
    }
    for (const entry of entries) {
      // 点开头的目录是隐藏目录；锁文件、备份之类的散件也不是工作空间。
      if (entry.startsWith(".")) continue;
      const dir = join(this.root, entry);
      try {
        if (!this.fs.statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      const main = join(dir, "workspace.json");
      if (!this.fs.existsSync(main)) continue;
      try {
        const file = this.readWorkspaceFile(main);
        if (file.id !== entry)
          throw new Error(
            `workspace.json 的 id（${file.id}）与目录名（${entry}）不一致`,
          );
        workspaces.push({
          id: entry,
          title: file.title,
          createdAt: file.createdAt,
          updatedAt: file.updatedAt,
          revision: file.revision,
          boardCount: file.boards.length,
          objectCount: file.objects.length,
          dir,
        });
      } catch (error) {
        errors.push({
          id: entry,
          reason: `workspace.json 读不出来：${describe(error)}`,
        });
      }
    }
    workspaces.sort(
      (a, b) =>
        b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    return { workspaces, errors };
  }

  /**
   * 新建空白工作空间（不落盘）。
   * 落盘要显式调用 save()：不显式保存的「以为存了其实没存」是最难查的一类问题。
   */
  create(input?: { id?: string; title?: string }): WorkspaceFile {
    const id = input?.id ?? randomUUID();
    if (this.store.exists(id) || this.reserved.has(id))
      throw new WorkspaceConflictError(
        `工作空间「${id}」已经存在，不能再建一个同名的。`,
      );
    const workspace = this.store.create({
      id,
      ...(input?.title === undefined ? {} : { title: input.title }),
    });
    this.reserved.add(id);
    return workspace;
  }

  /** 落盘。整个写操作在锁内：读-改-写不能被另一个进程插进来。 */
  async save(workspace: WorkspaceFile): Promise<WorkspaceFile> {
    // 锁文件住在工作空间目录里，目录必须先在：
    // 新建的工作空间还没有目录，先建出来再拿锁。
    this.fs.mkdirSync(this.store.workspaceDir(workspace.id), {
      recursive: true,
    });
    const lock = this.lock(workspace.id);
    return lock.withLock(() => this.store.save(workspace));
  }

  /**
   * 读取工作空间内容。
   * 读路径不取锁：写用 rename 替换，读者要么看到旧文件要么看到新文件。
   */
  open(id: string): WorkspaceOpenResult {
    const loaded = this.store.load(id);
    return {
      workspace: loaded.workspace,
      recovered: loaded.recovered,
      ...(loaded.reason ? { reason: loaded.reason } : {}),
    };
  }

  /** 改标题。读-改-写在锁内完成。 */
  async rename(id: string, title: string): Promise<WorkspaceFile> {
    const next = title.trim();
    if (!next) throw new WorkspaceError("工作空间标题不能为空。");
    // 先确认存在再拿锁：不存在的工作空间连目录都没有，锁文件没地方放。
    if (!this.store.exists(id))
      throw new WorkspaceNotFoundError(
        `工作空间「${id}」不存在于 ${this.root}。`,
      );
    const lock = this.lock(id);
    return lock.withLock(() => {
      const loaded = this.store.load(id);
      const updated: WorkspaceFile = {
        ...loaded.workspace,
        title: next,
        updatedAt: this.now(),
      };
      return this.store.save(updated);
    });
  }

  /**
   * 删除工作空间目录（workspace.json、备份、锁文件、附件）。
   * 被别的进程持锁时拒绝：删掉别人正在写的工作空间，丢的是对方的内容。
   */
  async delete(id: string): Promise<{ id: string }> {
    const dir = this.store.workspaceDir(id);
    if (!this.fs.existsSync(dir))
      throw new WorkspaceNotFoundError(
        `工作空间「${id}」不存在于 ${this.root}。`,
      );
    this.assertNotLocked(id);
    const lock = this.lock(id);
    await lock.acquire();
    try {
      this.fs.rmSync(dir, { recursive: true, force: true });
    } finally {
      await lock.release();
    }
    this.reserved.delete(id);
    return { id };
  }

  /**
   * 切换活动工作空间。
   *
   * 顺序不能反：先落盘当前工作空间，再加载目标。反了就丢正在编辑的内容。
   * 落盘失败 → 中止切换，活动工作空间保持原样（不留下半切状态）。
   */
  async switch(id: string): Promise<WorkspaceOpenResult> {
    if (!this.host)
      throw new WorkspaceError(
        "没有配置宿主端口，无法切换工作空间：管理器不知道运行期的状态该交给谁。",
      );
    const current = this.host.currentWorkspaceId();
    if (current && current !== id) await this.host.flush();
    const target = this.open(id);
    this.host.restore(target.workspace);
    this.host.attach(id);
    return target;
  }

  /** 当前活动工作空间 id（由宿主回答）。 */
  activeId(): string | undefined {
    return this.host?.currentWorkspaceId();
  }

  /** 某把锁。用管理器的文件接口，锁与内容才落在同一个文件系统视图里。 */
  private lock(id: string): WorkspaceLock {
    return new WorkspaceLock(
      workspaceLockPath(this.store.workspaceDir(id)),
      id,
      {
        ...this.lockOptions,
        host: this.hostName,
        fs: this.fs,
        now: this.now,
      },
    );
  }

  /**
   * 删除前的占用检查。
   * 只有「持有者确定已经不在了」的锁才不挡路：
   * 删除整个工作空间是破坏性操作，不能靠「锁看起来旧」就放行。
   */
  private assertNotLocked(id: string): void {
    const path = workspaceLockPath(this.store.workspaceDir(id));
    if (!this.fs.existsSync(path)) return;
    const holder = readLockHolder(this.fs, path);
    const alive = this.lockOptions.isProcessAlive ?? nodeIsProcessAlive;
    if (holder && holder.host === this.hostName && !alive(holder.pid)) return;
    const who = holder
      ? `pid ${holder.pid}（主机 ${holder.host}）`
      : "持有者不明";
    const age = holder ? Math.max(0, this.now() - holder.at) : 0;
    throw new WorkspaceLockError(
      `工作空间「${id}」正被其他进程占用：${who}，已持有 ${age}ms。删除被拒绝。`,
    );
  }

  /** 读工作空间文件并迁移到当前版本。坏数据在这里抛出去。 */
  private readWorkspaceFile(file: string): WorkspaceFile {
    const text = this.fs.readFileSync(file, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`不是合法 JSON：${describe(error)}`);
    }
    return migrate(parsed);
  }
}
