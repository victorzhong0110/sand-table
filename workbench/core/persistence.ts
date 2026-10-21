// 持久化接线：把存储层（core/workspace.ts）接到内核的持久化端口上。
// 内核只依赖 WorkspacePersistence 接口，不关心文件布局、原子写与迁移细节。
// 契约见 docs/architecture/workspace-kernel.zh-CN.md 第 5 节。

import {
  WorkspaceStore,
  WorkspaceConflictError,
  WorkspaceNotFoundError,
  type WorkspaceFile,
} from "./workspace.ts";
import { createWorkspaceLock } from "./workspace-lock.ts";
import type { WorkspaceSnapshot } from "./objects.ts";
import type { WorkspacePersistence } from "./store.ts";

export type WorkspacePort = WorkspacePersistence & {
  /** 上次读取是否走了备份回退。 */
  recovered: boolean;
  /** 回退原因。 */
  reason?: string;
  /** 上次读取失败的原因。读取失败必须可观察，不能当作「没有工作空间」。 */
  loadError?: string;
};

/**
 * 用 WorkspaceStore 实现内核的持久化端口。
 * 读取失败会抛出，由调用方记录并展示——不静默当成空工作空间。
 */
export function workspacePort(
  store: WorkspaceStore,
  baseline?: WorkspaceSnapshot,
): WorkspacePort {
  // A lock protects the file operation; an optimistic baseline protects the content.
  // Each loaded workspace keeps the exact persisted state this writer has seen.
  const baselines = new Map<string, string | null>();
  if (baseline) baselines.set(baseline.id, JSON.stringify(baseline));
  let queue: Promise<unknown> = Promise.resolve();
  const current = (id: string): string | null => {
    try {
      return JSON.stringify(store.load(id).workspace);
    } catch (error) {
      if (error instanceof WorkspaceNotFoundError) return null;
      throw error;
    }
  };
  const port: WorkspacePort = {
    recovered: false,
    /**
     * 落盘。**整段读-改-写都在跨进程锁里**：
     * 两个进程同时写同一个工作空间时，后写者不能把先写者的内容整块覆盖。
     * 拿不到锁就抛错——不静默跳过，那等于假装存上了。
     */
    save(snapshot: WorkspaceSnapshot) {
      const captured = structuredClone(snapshot);
      const save = queue.then(async () => {
        const id = captured.id;
        store.ensureDir(id);
        const lock = createWorkspaceLock(store.workspaceDir(id), id);
        await lock.withLock(() => {
          const disk = current(id);
          const baseline = baselines.get(id) ?? null;
          if (disk !== baseline)
            throw new WorkspaceConflictError(
              `工作空间「${id}」已被另一个进程修改。未覆盖磁盘内容；当前编辑仍保留在内存中，请先导出当前内容，再重新打开工作空间。`,
            );
          baselines.set(
            id,
            JSON.stringify(store.save(captured as WorkspaceFile)),
          );
        });
      });
      queue = save.catch(() => {});
      return save;
    },
    load(id: string) {
      try {
        const result = store.load(id);
        baselines.set(id, JSON.stringify(result.workspace));
        port.recovered = result.recovered;
        port.reason = result.reason;
        port.loadError = undefined;
        return result.workspace as WorkspaceSnapshot;
      } catch (e) {
        if (e instanceof WorkspaceNotFoundError) baselines.set(id, null);
        port.loadError = e instanceof Error ? e.message : String(e);
        throw e;
      }
    },
  };
  return port;
}
