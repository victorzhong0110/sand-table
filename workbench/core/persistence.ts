// 持久化接线：把存储层（core/workspace.ts）接到内核的持久化端口上。
// 内核只依赖 WorkspacePersistence 接口，不关心文件布局、原子写与迁移细节。
// 契约见 docs/architecture/workspace-kernel.zh-CN.md 第 5 节。

import { WorkspaceStore, type WorkspaceFile } from "./workspace.ts";
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
export function workspacePort(store: WorkspaceStore): WorkspacePort {
  const port: WorkspacePort = {
    recovered: false,
    save(snapshot: WorkspaceSnapshot) {
      store.save(snapshot as WorkspaceFile);
    },
    load(id: string) {
      try {
        const result = store.load(id);
        port.recovered = result.recovered;
        port.reason = result.reason;
        port.loadError = undefined;
        return result.workspace as WorkspaceSnapshot;
      } catch (e) {
        port.loadError = e instanceof Error ? e.message : String(e);
        throw e;
      }
    },
  };
  return port;
}
