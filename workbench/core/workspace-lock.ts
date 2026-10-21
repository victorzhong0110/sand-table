// 跨进程文件锁：一个工作空间一把锁，锁住整个「读-改-写」事务。
// 契约见 docs/architecture/workspace-management.zh-CN.md 第 4 节（不变量 J1–J5、J9）。
//
// 为什么单独一个模块：锁的语义（独占创建、可重入、陈旧抢占、只删自己那份）
// 与内核状态无关，也不依赖 store，纯文件操作就能测——测试注入假的文件接口
// 与假的进程存活检查，两个「进程」就能在同一个假文件系统上抢同一把锁，
// 不需要真的起第二个进程，更不需要真的杀进程。
//
// 约束：只用 node 内置模块；不使用 enum / namespace / 参数属性 / 装饰器
// （node --experimental-strip-types 不支持）。

import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";

/** 锁文件内容：谁持有这把锁、什么时候拿到的。 */
export type WorkspaceLockHolder = {
  pid: number;
  host: string;
  at: number;
  workspaceId: string;
};

/** stat 的最小信息：判断陈旧锁时需要文件的修改时间。 */
export type LockFileStat = {
  size: number;
  isDirectory(): boolean;
  mtimeMs: number;
};

/**
 * 锁用的小文件接口。
 * 比 core/workspace.ts 的 WorkspaceFileSystem 小一圈：锁只需要
 * 存在 / 独占创建 / 写 / 读 / 删 / 改名 / stat。
 * 之所以自己声明一个而不复用大的那个：测试要能塞进一个假实现，
 * 假实现的每个方法都是一行，假文件系统才不会比真逻辑还长。
 */
export type LockFileSystem = {
  existsSync(path: string): boolean;
  openSync(path: string, flags: string): number;
  writeSync(fd: number, data: string): void;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
  readFileSync(path: string, encoding: "utf8"): string;
  unlinkSync(path: string): void;
  renameSync(from: string, to: string): void;
  statSync(path: string): LockFileStat;
};

/** 锁的默认超时：等待锁释放的上限。 */
export const DEFAULT_LOCK_TIMEOUT_MS = 10_000;

/** 锁的默认陈旧阈值：超过这个时间的锁允许抢占。 */
export const DEFAULT_LOCK_STALE_MS = 60_000;

/** 默认轮询间隔：等待期间的检查频率。 */
export const DEFAULT_LOCK_POLL_MS = 50;

/** 锁文件名。放在工作空间目录里，一把工作空间一把锁。 */
export const WORKSPACE_LOCK_FILE = "workspace.lock";

/** <workspaceDir>/workspace.lock */
export const workspaceLockPath = (workspaceDir: string): string =>
  join(workspaceDir, WORKSPACE_LOCK_FILE);

/** 锁相关错误：超时、抢不来、宿主不可用。 */
export class WorkspaceLockError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WorkspaceLockError";
  }
}

/** 默认文件实现。 */
export const nodeLockFileSystem: LockFileSystem = {
  existsSync: (target) => existsSync(target),
  openSync: (target, flags) => openSync(target, flags),
  writeSync: (fd, data) => {
    writeSync(fd, data);
  },
  fsyncSync: (fd) => {
    fsyncSync(fd);
  },
  closeSync: (fd) => {
    closeSync(fd);
  },
  readFileSync: (target, encoding) => readFileSync(target, encoding),
  unlinkSync: (target) => {
    unlinkSync(target);
  },
  renameSync: (from, to) => {
    renameSync(from, to);
  },
  statSync: (target) => statSync(target),
};

/**
 * 进程是否还活着。
 * ESRCH = 没有这个进程；EPERM = 有，但我们没权限发信号——它还活着。
 * 把 EPERM 当成「死了」会把一个正在写的进程当成陈旧锁，抢走它的锁。
 */
export const nodeIsProcessAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

export type WorkspaceLockOptions = {
  fs?: LockFileSystem;
  now?: () => number;
  /** 主机名。同主机才谈得上「进程还在不在」。 */
  host?: string;
  /** 进程号。可注入：测试用假 pid 模拟另一个进程。 */
  pid?: number;
  /** 等待锁释放的上限（毫秒）。 */
  timeoutMs?: number;
  /** 超过这个时间就算陈旧（毫秒）。 */
  staleMs?: number;
  /** 等待期间的轮询间隔（毫秒）。 */
  pollIntervalMs?: number;
  /** 进程存活检查。测试注入假实现，不要真去杀进程。 */
  isProcessAlive?: (pid: number) => boolean;
  /** 等待用的休眠。可注入，测试里换成立即返回的假实现。 */
  sleep?: (ms: number) => Promise<void>;
};

type HeldLock = {
  host: string;
  pid: number;
  /** 重入计数：归零才真正删锁文件。 */
  count: number;
  holder: WorkspaceLockHolder;
};

/**
 * 本进程持有的锁。按锁文件路径索引。
 * 可重入靠它实现：同一进程再拿一次同一把锁，计数 +1，不去碰文件。
 */
const held = new Map<string, HeldLock>();

/**
 * 等待用的休眠。
 * 故意不 unref：等锁的时候进程不能「没事干就退出」——
 * 一次没落完的保存就是一份丢掉的改动。
 */
const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isExistsError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  (error as { code?: string }).code === "EEXIST";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** 两个持有者信息是否指同一把锁。 */
const sameHolder = (a: WorkspaceLockHolder, b: WorkspaceLockHolder): boolean =>
  a.pid === b.pid && a.host === b.host && a.at === b.at;

/**
 * 读锁文件里的持有者信息。
 * 读不出来（文件不存在、内容不是 JSON、字段不对）时返回 null：
 * 「读不出来」不等于「没人持有」，调用方要区别对待。
 */
export const readLockHolder = (
  fs: LockFileSystem,
  path: string,
): WorkspaceLockHolder | null => {
  if (!fs.existsSync(path)) return null;
  let text: string;
  try {
    text = fs.readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return null;
    const pid = parsed.pid;
    const at = parsed.at;
    if (typeof pid !== "number" || !Number.isFinite(pid)) return null;
    if (typeof at !== "number" || !Number.isFinite(at)) return null;
    return {
      pid,
      at,
      host: typeof parsed.host === "string" ? parsed.host : "",
      workspaceId:
        typeof parsed.workspaceId === "string" ? parsed.workspaceId : "",
    };
  } catch {
    return null;
  }
};

/**
 * 一把跨进程文件锁。
 *
 * 用法：把整个「读-改-写」事务包在 withLock 里。
 * 读路径（load / list）不取锁——写用 rename 替换，读者要么看到旧文件要么看到新文件。
 *
 * 注意：锁文件住在工作空间目录里，**这个目录必须已经存在**——
 * 独占创建不会建目录。给新工作空间接锁时，先把目录建出来。
 */
export class WorkspaceLock {
  /** 锁文件路径。 */
  readonly path: string;
  /** 所属工作空间。写进锁文件，出问题时能一眼看出是谁的锁。 */
  readonly workspaceId: string;
  private readonly fs: LockFileSystem;
  private readonly now: () => number;
  private readonly host: string;
  private readonly pid: number;
  private readonly timeoutMs: number;
  private readonly staleMs: number;
  private readonly pollIntervalMs: number;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly sleep: (ms: number) => Promise<void>;
  /** 本实例写进锁文件的持有者信息。释放时靠它确认「文件里那把锁是不是我的」。 */
  private myHolder?: WorkspaceLockHolder;
  /** 本实例的持有层数（可重入）。 */
  private depth = 0;

  constructor(
    path: string,
    workspaceId: string,
    options?: WorkspaceLockOptions,
  ) {
    // 路径要归一：可重入是按路径索引的，
    // 同一个锁文件写成相对路径和绝对路径会被当成两把锁，同进程自己锁死自己。
    this.path = resolve(path);
    this.workspaceId = workspaceId;
    this.fs = options?.fs ?? nodeLockFileSystem;
    this.now = options?.now ?? Date.now;
    this.host = options?.host ?? hostname();
    this.pid = options?.pid ?? process.pid;
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.staleMs = options?.staleMs ?? DEFAULT_LOCK_STALE_MS;
    this.pollIntervalMs = options?.pollIntervalMs ?? DEFAULT_LOCK_POLL_MS;
    this.isProcessAlive = options?.isProcessAlive ?? nodeIsProcessAlive;
    this.sleep = options?.sleep ?? defaultSleep;
  }

  /** 本进程是否持有这把锁。 */
  isHeld(): boolean {
    return this.depth > 0;
  }

  /** 锁文件里的持有者信息。读不出来时返回 null。 */
  readHolder(): WorkspaceLockHolder | null {
    return readLockHolder(this.fs, this.path);
  }

  /**
   * 拿锁。拿不到就等，等到超时抛错。
   * 同一进程重复拿同一把锁是可重入的：计数 +1，不报错。
   */
  async acquire(): Promise<void> {
    const entry = held.get(this.path);
    if (entry && entry.host === this.host && entry.pid === this.pid) {
      entry.count++;
      this.depth++;
      return;
    }
    const deadline = this.now() + this.timeoutMs;
    for (;;) {
      if (this.tryCreate()) {
        this.depth++;
        return;
      }
      const holder = this.readHolder();
      if (this.isStaleFile(holder)) {
        // 判定为陈旧：先把陈旧锁挪走再创建新锁。
        // 直接覆盖会出问题：两个进程同时判定陈旧、同时创建成功，就等于没有锁。
        if (this.preemptStale(holder)) continue;
        await this.sleep(this.pollIntervalMs);
        continue;
      }
      if (this.now() >= deadline)
        throw new WorkspaceLockError(this.timeoutMessage(holder));
      await this.sleep(this.pollIntervalMs);
    }
  }

  /**
   * 放锁。
   * 只删自己持有的那一份：文件里的持有者必须和我当初写进去的一致，
   * 不一致说明锁已经被别人抢走，这时删了就等于把别人的锁解了。
   */
  async release(): Promise<boolean> {
    if (this.depth === 0) return false;
    this.depth--;
    const entry = held.get(this.path);
    // 以注册表里的持有者为准：可重入的第二个实例没有自己写进去的持有者信息，
    // 只认自己的那份会把锁文件留在盘上（锁泄漏 = 下次永远拿不到锁）。
    let holder = this.myHolder;
    if (entry && entry.host === this.host && entry.pid === this.pid) {
      entry.count--;
      // 还有嵌套持有：文件先留着，最后一层再删。
      if (entry.count > 0) return true;
      held.delete(this.path);
      holder = entry.holder;
    }
    if (!holder) return true;
    const onDisk = this.readHolder();
    if (!onDisk) return true;
    if (!sameHolder(onDisk, holder)) return false;
    this.safeUnlink(this.path);
    return true;
  }

  /** 拿锁 → 干活 → 放锁。异常也会放锁。 */
  async withLock<T>(fn: () => T | Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      await this.release();
    }
  }

  /**
   * 独占创建锁文件。
   * 返回 false 表示「已经有锁了」，不是错误。
   */
  private tryCreate(): boolean {
    let fd: number | undefined;
    try {
      fd = this.fs.openSync(this.path, "wx");
    } catch (error) {
      if (isExistsError(error)) return false;
      throw new WorkspaceLockError(
        `无法创建锁文件「${this.path}」：${describe(error)}`,
        { cause: error },
      );
    }
    const holder: WorkspaceLockHolder = {
      pid: this.pid,
      host: this.host,
      at: this.now(),
      workspaceId: this.workspaceId,
    };
    try {
      this.fs.writeSync(fd, JSON.stringify(holder) + "\n");
      this.fs.fsyncSync(fd);
    } catch (error) {
      // 持有者信息没写进去就把锁删掉：留一个读不出持有者的锁文件，
      // 谁都判不出它是不是陈旧，只能干等到超时。
      this.safeUnlink(this.path);
      throw new WorkspaceLockError(
        `写入锁文件「${this.path}」失败：${describe(error)}`,
        { cause: error },
      );
    } finally {
      if (fd !== undefined)
        try {
          this.fs.closeSync(fd);
        } catch {
          // 关闭失败不影响锁的有效性。
        }
    }
    this.myHolder = holder;
    held.set(this.path, {
      host: this.host,
      pid: this.pid,
      count: 1,
      holder,
    });
    return true;
  }

  /**
   * 锁是不是陈旧的。
   * ① 同主机且进程已经不在了；② 超过陈旧阈值（覆盖 kill -9 来不及释放）。
   */
  private isStaleFile(holder: WorkspaceLockHolder | null): boolean {
    if (holder) {
      if (holder.host === this.host) return !this.isProcessAlive(holder.pid);
      // Age alone is not proof a remote owner has died; never steal a live lease.
      return false;
    }
    // 持有者读不出来（进程死在写锁文件的中途）：只能靠文件时间判断。
    const mtime = this.mtimeMs();
    return mtime !== null && this.now() - mtime > this.staleMs;
  }

  /**
   * 抢占陈旧锁：先把锁文件挪走，再让出位置给新的锁。
   * 返回 true 表示陈旧锁已经被清掉，可以直接重试创建。
   */
  private preemptStale(holder: WorkspaceLockHolder | null): boolean {
    const stalePath = this.stalePath();
    try {
      this.fs.renameSync(this.path, stalePath);
    } catch {
      // 别人先挪走了：重试即可。
      return false;
    }
    const moved = readLockHolder(this.fs, stalePath);
    if (holder && moved ? sameHolder(moved, holder) : !holder && !moved) {
      this.safeUnlink(stalePath);
      return true;
    }
    // 挪走的是别人的新锁（刚释放又被人拿了）：放回去，不能抢活锁。
    this.restore(stalePath);
    return false;
  }

  /** 陈旧锁的挪走目标：workspace.lock.stale.<时间戳>。 */
  private stalePath(): string {
    let at = this.now();
    let path = `${this.path}.stale.${at}`;
    // 同一毫秒里目标名被占用就顺延 1ms：两个进程抢同一个目标名会把锁互相对调。
    for (let n = 0; n < 1000 && this.fs.existsSync(path); n++) {
      at += 1;
      path = `${this.path}.stale.${at}`;
    }
    return path;
  }

  /** 把误挪走的锁放回原位（原位已经有锁就不动它）。 */
  private restore(stalePath: string): void {
    if (this.fs.existsSync(this.path)) return;
    try {
      this.fs.renameSync(stalePath, this.path);
    } catch {
      // 放不回去就让它当孤儿文件：它不是权威数据。
    }
  }

  private mtimeMs(): number | null {
    try {
      return this.fs.statSync(this.path).mtimeMs;
    } catch {
      return null;
    }
  }

  private safeUnlink(target: string): void {
    try {
      this.fs.unlinkSync(target);
    } catch {
      // 清理失败不掩盖原始错误。
    }
  }

  /** 超时信息必须写明「谁持有、持有多久」：只说「超时了」用户没法处理。 */
  private timeoutMessage(holder: WorkspaceLockHolder | null): string {
    const waited = this.timeoutMs;
    if (!holder)
      return `等待工作空间「${this.workspaceId}」的文件锁超时（${waited}ms）：锁文件在，但读不出持有者信息，可能正被写入。`;
    const held = Math.max(0, this.now() - holder.at);
    return `等待工作空间「${this.workspaceId}」的文件锁超时（${waited}ms）：持有者是 pid ${holder.pid}（主机 ${holder.host}），已持有 ${held}ms。`;
  }
}

/** 建一把工作空间锁：<workspaceDir>/workspace.lock。 */
export const createWorkspaceLock = (
  workspaceDir: string,
  workspaceId: string,
  options?: WorkspaceLockOptions,
): WorkspaceLock =>
  new WorkspaceLock(workspaceLockPath(workspaceDir), workspaceId, options);
