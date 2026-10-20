// 跨进程文件锁的测试。契约见 docs/architecture/workspace-management.zh-CN.md 第 4、5 节。
// 覆盖不变量 J1–J5、J9。
// 只用 node 内置模块；node --experimental-strip-types --test tests/workspace-lock.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  readLockHolder,
  WorkspaceLock,
  WorkspaceLockError,
  workspaceLockPath,
} from "../core/workspace-lock.ts";
import type { LockFileSystem } from "../core/workspace-lock.ts";
import { nodeWorkspaceFileSystem, WorkspaceStore } from "../core/workspace.ts";
import type { WorkspaceFileSystem } from "../core/workspace.ts";
import { WorkspaceManager } from "../core/workspace-manager.ts";
import type { TestContext } from "node:test";

/**
 * 假文件系统：两个「进程」在同一个内存目录上抢同一把锁。
 * 用内存而不是真目录，是为了让「两个进程」这件事在同一个测试进程里可控地发生。
 */
class MemoryFileSystem implements LockFileSystem {
  readonly files = new Map<string, string>();
  private readonly handles = new Map<number, { path: string; pos: number }>();
  private nextFd = 1;

  existsSync(target: string): boolean {
    return this.files.has(target);
  }

  openSync(target: string, flags: string): number {
    if (flags.includes("x") && this.files.has(target)) {
      const error = new Error(
        `EEXIST: file already exists, open '${target}'`,
      ) as NodeJS.ErrnoException;
      error.code = "EEXIST";
      throw error;
    }
    if (!flags.includes("x"))
      this.files.set(target, this.files.get(target) ?? "");
    const fd = this.nextFd++;
    this.handles.set(fd, { path: target, pos: 0 });
    return fd;
  }

  writeSync(fd: number, data: string): void {
    const handle = this.handles.get(fd);
    if (!handle) throw new Error(`bad file descriptor: ${fd}`);
    const current = this.files.get(handle.path) ?? "";
    this.files.set(
      handle.path,
      current.slice(0, handle.pos) +
        data +
        current.slice(handle.pos + data.length),
    );
    handle.pos += data.length;
  }

  fsyncSync(): void {}

  closeSync(fd: number): void {
    this.handles.delete(fd);
  }

  readFileSync(target: string): string {
    const content = this.files.get(target);
    if (content === undefined) {
      const error = new Error(
        `ENOENT: no such file or directory, open '${target}'`,
      ) as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
    return content;
  }

  unlinkSync(target: string): void {
    if (!this.files.delete(target)) {
      const error = new Error(
        `ENOENT: no such file or directory, unlink '${target}'`,
      ) as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
  }

  renameSync(from: string, to: string): void {
    const content = this.files.get(from);
    if (content === undefined) {
      const error = new Error(
        `ENOENT: no such file or directory, rename '${from}'`,
      ) as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
    this.files.set(to, content);
    this.files.delete(from);
  }

  statSync(target: string) {
    const content = this.files.get(target);
    if (content === undefined) {
      const error = new Error(
        `ENOENT: no such file or directory, stat '${target}'`,
      ) as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
    return {
      size: content.length,
      isDirectory: () => false,
      mtimeMs: 0,
    };
  }
}

/** 假时钟：等待推进时间，超时判定才是确定的（不然会一直等下去）。 */
const fakeClock = () => {
  let t = 1000;
  const state = {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
      await state.onTick?.(t);
    },
    onTick: undefined as undefined | ((at: number) => void | Promise<void>),
  };
  return state;
};

const tempRoot = (t: TestContext): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sand-lock-"));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
};

/** 造一个「进程」：同一个内存文件系统，不同 pid。 */
const makeProcess = (
  mem: MemoryFileSystem,
  clock: ReturnType<typeof fakeClock>,
  options: {
    dir: string;
    workspaceId: string;
    pid: number;
    host?: string;
    timeoutMs?: number;
    staleMs?: number;
    alive?: (pid: number) => boolean;
  },
): WorkspaceLock =>
  new WorkspaceLock(workspaceLockPath(options.dir), options.workspaceId, {
    fs: mem,
    now: clock.now,
    sleep: clock.sleep,
    host: options.host ?? "machine-a",
    pid: options.pid,
    timeoutMs: options.timeoutMs ?? 200,
    pollIntervalMs: 50,
    staleMs: options.staleMs ?? 60_000,
    isProcessAlive: options.alive ?? (() => true),
  });

test("J1：同一工作空间同一时刻只有一个写者——第二个进程拿不到锁就明确失败", async () => {
  const mem = new MemoryFileSystem();
  const clock = fakeClock();
  const dir = "/virtual/j1-exclusive";
  const a = makeProcess(mem, clock, { dir, workspaceId: "novel", pid: 1001 });
  const b = makeProcess(mem, clock, { dir, workspaceId: "novel", pid: 1002 });

  await a.acquire();
  await assert.rejects(
    () => b.acquire(),
    (error: unknown) => {
      assert.ok(error instanceof WorkspaceLockError, "必须是锁错误");
      const message = (error as Error).message;
      assert.match(message, /pid 1001/, "错误要写明是谁持有");
      assert.match(message, /已持有 \d+ms/, "错误要写明持有多久");
      return true;
    },
  );
  // 第二个进程没有拿到锁：锁文件里的持有者仍然是第一个进程，没有被静默覆盖。
  assert.equal(readLockHolder(mem, workspaceLockPath(dir))?.pid, 1001);
  await a.release();
});

test("J1：等待中的第二个进程在第一个进程放锁后能拿到锁，不被静默跳过", async () => {
  const mem = new MemoryFileSystem();
  const clock = fakeClock();
  const dir = "/virtual/j1-wait";
  const a = makeProcess(mem, clock, { dir, workspaceId: "novel", pid: 1001 });
  const b = makeProcess(mem, clock, {
    dir,
    workspaceId: "novel",
    pid: 1002,
    timeoutMs: 5000,
  });

  await a.acquire();
  // 等待到 1100ms 时第一个进程放锁。
  clock.onTick = async (at) => {
    if (at >= 1100) await a.release();
  };
  await b.acquire();
  assert.ok(b.isHeld(), "第二个进程最终拿到了锁");
  assert.equal(readLockHolder(mem, workspaceLockPath(dir))?.pid, 1002);
  await b.release();
});

test("J1：两个进程并发做读-改-写——后写的那次不会把前一次的内容整块覆盖", async (t) => {
  const root = tempRoot(t);
  const store = new WorkspaceStore(root);
  store.save(store.create({ id: "default", title: "初稿" }));
  const lockPath = workspaceLockPath(store.workspaceDir("default"));

  // 典型的保存流程：读当前内容 → 合并 → 写回。整段必须在锁内。
  const write = async (pid: number, title: string) => {
    const lock = new WorkspaceLock(lockPath, "default", {
      pid,
      host: "machine-a",
      timeoutMs: 2000,
      isProcessAlive: () => true,
    });
    return lock.withLock(() => {
      const loaded = store.load("default");
      loaded.workspace.title = `${loaded.workspace.title} → ${title}`;
      store.save(loaded.workspace);
      return loaded.workspace.title;
    });
  };

  const [first, second] = await Promise.all([
    write(1001, "甲"),
    write(1002, "乙"),
  ]);
  assert.equal(first, "初稿 → 甲");
  assert.equal(
    second,
    "初稿 → 甲 → 乙",
    "第二个进程读到的是第一个进程写完的内容，没有被静默覆盖",
  );
  assert.equal(
    store.load("default").workspace.title,
    "初稿 → 甲 → 乙",
    "盘上留下的是两段改动，不是一段",
  );
});

test("J2：锁被释放后可以再次获取", async () => {
  const mem = new MemoryFileSystem();
  const clock = fakeClock();
  const dir = "/virtual/j2-release";
  const lock = makeProcess(mem, clock, {
    dir,
    workspaceId: "novel",
    pid: 1001,
  });

  await lock.acquire();
  assert.ok(mem.existsSync(workspaceLockPath(dir)), "拿锁后锁文件存在");
  await lock.release();
  assert.ok(!mem.existsSync(workspaceLockPath(dir)), "放锁后锁文件被删");

  await lock.acquire();
  assert.ok(lock.isHeld(), "同一把锁可以再拿一次");
  await lock.release();
});

test("J2：同一进程可重入——重复拿锁计数 +1，释放到零才删文件", async () => {
  const mem = new MemoryFileSystem();
  const clock = fakeClock();
  const dir = "/virtual/j2-reentrant";
  const lock = makeProcess(mem, clock, {
    dir,
    workspaceId: "novel",
    pid: 1001,
  });

  await lock.acquire();
  await lock.acquire();
  await lock.release();
  assert.ok(
    mem.existsSync(workspaceLockPath(dir)),
    "还有一层持有，锁文件不能删",
  );
  await lock.release();
  assert.ok(!mem.existsSync(workspaceLockPath(dir)), "计数归零才删文件");
});

test("J2：可重入跨实例——两个句柄拿同一把锁，释放到零才删文件", async () => {
  const mem = new MemoryFileSystem();
  const clock = fakeClock();
  const dir = "/virtual/j2-two-handles";
  // 同一个进程（同一个 pid）的两个句柄。
  const x = makeProcess(mem, clock, { dir, workspaceId: "novel", pid: 1001 });
  const y = makeProcess(mem, clock, { dir, workspaceId: "novel", pid: 1001 });

  await x.acquire();
  await y.acquire();
  await x.release();
  assert.ok(
    mem.existsSync(workspaceLockPath(dir)),
    "还有一层持有，锁文件不能删",
  );
  await y.release();
  assert.ok(
    !mem.existsSync(workspaceLockPath(dir)),
    "计数归零必须删掉锁文件，否则这把锁永远留着",
  );
});

test("J3：同主机且进程已经不在了——陈旧锁可被抢占", async () => {
  const mem = new MemoryFileSystem();
  const clock = fakeClock();
  const dir = "/virtual/j3-dead-pid";
  const lockPath = workspaceLockPath(dir);
  // 另一个进程（pid 9999）留下的锁，而它已经死了。
  mem.files.set(
    lockPath,
    JSON.stringify({
      pid: 9999,
      host: "machine-a",
      at: 1000,
      workspaceId: "novel",
    }),
  );
  const lock = makeProcess(mem, clock, {
    dir,
    workspaceId: "novel",
    pid: 1001,
    alive: (pid) => pid !== 9999,
  });

  await lock.acquire();
  assert.ok(lock.isHeld(), "陈旧锁可以被抢");
  assert.equal(readLockHolder(mem, lockPath)?.pid, 1001);
  await lock.release();
});

test("J3：进程还活着——活锁不可抢", async () => {
  const mem = new MemoryFileSystem();
  const clock = fakeClock();
  const dir = "/virtual/j3-live";
  const lockPath = workspaceLockPath(dir);
  mem.files.set(
    lockPath,
    JSON.stringify({
      pid: 9999,
      host: "machine-a",
      at: 1000,
      workspaceId: "novel",
    }),
  );
  const lock = makeProcess(mem, clock, {
    dir,
    workspaceId: "novel",
    pid: 1001,
    alive: () => true,
  });

  await assert.rejects(
    () => lock.acquire(),
    (error: unknown) => {
      assert.ok(error instanceof WorkspaceLockError);
      assert.match((error as Error).message, /pid 9999/);
      return true;
    },
  );
  assert.equal(readLockHolder(mem, lockPath)?.pid, 9999, "活锁没有被抢走");
});

test("J3：超过陈旧阈值的锁可被抢占（覆盖 kill -9 来不及释放）", async () => {
  const mem = new MemoryFileSystem();
  const clock = fakeClock();
  const dir = "/virtual/j3-expired";
  const lockPath = workspaceLockPath(dir);
  // 不同主机：查不了 pid 存活，只能靠时间判定陈旧。
  mem.files.set(
    lockPath,
    JSON.stringify({
      pid: 9999,
      host: "machine-b",
      at: 0,
      workspaceId: "novel",
    }),
  );
  const lock = makeProcess(mem, clock, {
    dir,
    workspaceId: "novel",
    pid: 1001,
    staleMs: 200,
    timeoutMs: 5000,
    alive: () => true,
  });

  await lock.acquire();
  assert.equal(readLockHolder(mem, lockPath)?.pid, 1001, "过期锁被换成了新的");
  await lock.release();
});

test("J4：两个进程同时抢同一把陈旧锁——只有一个成功，另一个明确失败", async () => {
  const mem = new MemoryFileSystem();
  const clock = fakeClock();
  const dir = "/virtual/j4-race";
  const lockPath = workspaceLockPath(dir);
  mem.files.set(
    lockPath,
    JSON.stringify({
      pid: 9999,
      host: "machine-a",
      at: 0,
      workspaceId: "novel",
    }),
  );
  const a = makeProcess(mem, clock, {
    dir,
    workspaceId: "novel",
    pid: 1001,
    alive: (pid) => pid !== 9999,
  });
  const b = makeProcess(mem, clock, {
    dir,
    workspaceId: "novel",
    pid: 1002,
    alive: (pid) => pid !== 9999,
  });

  const results = await Promise.allSettled([a.acquire(), b.acquire()]);
  const won = results.filter((r) => r.status === "fulfilled");
  const lost = results.filter((r) => r.status === "rejected");
  assert.equal(won.length, 1, "只能有一个进程拿到锁");
  assert.equal(lost.length, 1, "另一个必须明确失败，不能两边都成功");
  assert.ok(lost[0].status === "rejected");
  assert.ok(
    lost[0].reason instanceof WorkspaceLockError,
    "失败方拿到的是锁错误",
  );
  const holder = readLockHolder(mem, lockPath);
  assert.ok(holder && (holder.pid === 1001 || holder.pid === 1002));
  // 胜者放锁：别把锁留给后面的用例。
  if (holder?.pid === 1001) await a.release();
  else await b.release();
});

test("J4：抢到的锁是完整的一份——持有者信息写得进去也读得出来", async () => {
  const mem = new MemoryFileSystem();
  const clock = fakeClock();
  const dir = "/virtual/j4-content";
  const lock = makeProcess(mem, clock, {
    dir,
    workspaceId: "novel",
    pid: 1001,
  });
  await lock.acquire();
  const holder = readLockHolder(mem, workspaceLockPath(dir));
  assert.ok(holder, "锁文件要能读出持有者");
  assert.equal(holder.pid, 1001);
  assert.equal(holder.host, "machine-a");
  assert.equal(holder.workspaceId, "novel");
  assert.equal(typeof holder.at, "number");
  await lock.release();
});

test("J5：锁内写失败时主文件内容逐字节不变", async (t) => {
  const root = tempRoot(t);
  const store = new WorkspaceStore(root);
  const file = store.create({ id: "default", title: "第一版" });
  store.save(file);
  const mainPath = store.mainPath("default");
  const before = fs.readFileSync(mainPath);

  // 模拟磁盘满：写 .tmp 失败。
  const failing: WorkspaceFileSystem = {
    ...nodeWorkspaceFileSystem,
    writeFileSync(target, data, encoding) {
      if (target.endsWith("workspace.json.tmp"))
        throw new Error("ENOSPC: no space left on device");
      nodeWorkspaceFileSystem.writeFileSync(target, data, encoding);
    },
  };
  const failingStore = new WorkspaceStore(root, { fs: failing });
  const lock = new WorkspaceLock(
    workspaceLockPath(store.workspaceDir("default")),
    "default",
    { timeoutMs: 500 },
  );

  await assert.rejects(() =>
    lock.withLock(async () => {
      const loaded = failingStore.load("default");
      loaded.workspace.title = "改过的标题";
      failingStore.save(loaded.workspace);
    }),
  );
  assert.deepEqual(
    fs.readFileSync(mainPath),
    before,
    "写失败后主文件必须逐字节不变",
  );
  assert.ok(
    !fs.existsSync(lock.path),
    "异常退出也要放锁，否则下一次保存永远拿不到锁",
  );
});

test("J9：锁文件不是权威数据——load 与 list 都不读 .lock 与 .lock.stale.*", (t) => {
  const root = tempRoot(t);
  const store = new WorkspaceStore(root);
  store.save(store.create({ id: "default", title: "正文" }));

  const dir = store.workspaceDir("default");
  fs.writeFileSync(
    path.join(dir, "workspace.lock"),
    JSON.stringify({
      pid: 4242,
      host: "other-machine",
      at: Date.now(),
      workspaceId: "default",
    }),
  );
  fs.writeFileSync(path.join(dir, "workspace.lock.stale.1700000000000"), "{}");

  const loaded = store.load("default");
  assert.equal(loaded.workspace.title, "正文", "内容没被锁文件污染");
  assert.equal(loaded.recovered, false, "锁文件不算损坏，不该走备份回退");
  assert.equal(loaded.workspace.objects.length, 0);

  const listed = store.list();
  assert.equal(listed.workspaces.length, 1);
  assert.equal(listed.errors.length, 0, "锁文件不是损坏的工作空间");

  // 管理器也不把锁文件当工作空间条目。
  const manager = new WorkspaceManager({ root });
  const managed = manager.list();
  assert.equal(managed.workspaces.length, 1);
  assert.equal(managed.workspaces[0].id, "default");
  assert.equal(managed.errors.length, 0);
});
