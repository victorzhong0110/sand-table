// 多工作空间管理器的 MCP 工具。
//
// 工作空间是长期作品的边界；一台机器上可以并存多个。
// 本文件只做「编排」：调用 core/workspace-manager.ts，并把失败原因原样带给调用方。
// 契约见 docs/architecture/workspace-management.zh-CN.md。

import { z } from "zod";
import { WorkspaceManager } from "../core/workspace-manager.ts";
import { WorkspaceLockError } from "../core/workspace-lock.ts";
import type { BoardStore } from "../core/store.ts";
import { WorkspaceStore } from "../core/workspace.ts";
import { workspacePort } from "../core/persistence.ts";

const id = z.string().min(1).max(200);

/**
 * 建管理器，并把它接到内核的宿主端口上。
 *
 * 切换工作空间的顺序是「先落盘当前 → 再加载目标」：
 * 反过来会丢当前正在编辑的内容。落盘失败必须中止切换。
 */
export function createWorkspaceManager(
  store: BoardStore,
  root: string,
  workspaceId: string,
): WorkspaceManager {
  return new WorkspaceManager({
    root,
    host: {
      currentWorkspaceId: () => store.workspaceId,
      flush: async () => {
        /* flushSave 会抛错（保存失败必须能被调用方看见），这里不吞：
           切换失败就是切换失败。必须 await：不等落盘完成就加载目标，
           会丢掉当前正在编辑的内容。 */
        await store.flushSave();
      },
      restore: (snapshot) => {
        store.restore(snapshot);
      },
      renamed: (title) => {
        store.workspaceTitle = title;
      },
      attach: (nextId, baseline) => {
        const port = workspacePort(new WorkspaceStore(root), baseline);
        store.attachPersistence(port, nextId);
        store.touch();
      },
    },
  });
}

export type WorkspaceTools = {
  /** 在 MCP server 上注册这些工具。 */
  register: (tool: RegisterTool) => void;
};

export type RegisterTool = (
  name: string,
  description: string,
  shape: Record<string, z.ZodTypeAny>,
  fn: (args: Record<string, unknown>) => unknown,
) => void;

/**
 * 把工作空间管理能力暴露成 MCP 工具。
 *
 * 语义保持一致：读操作直接返回；写操作（新建/切换/重命名/删除）返回明确结果，
 * 失败时**抛错并带上原因**（例如「谁在占用这个工作空间、持有多久」）。
 */
export function registerWorkspaceTools(
  manager: WorkspaceManager,
  tool: RegisterTool,
) {
  tool(
    "sand_list_workspaces",
    "列出本机工作空间根目录下的全部工作空间。单个损坏的工作空间会被跳过并在 errors 里点名，不影响其他条目。",
    {},
    () => {
      const result = manager.list();
      return {
        workspaces: result.workspaces,
        activeId: manager.activeId(),
        errors: result.errors,
      };
    },
  );

  tool(
    "sand_create_workspace",
    "新建一个空白工作空间。新建后需要显式保存才会落盘。",
    {
      id: id.optional(),
      title: z.string().max(200).optional(),
    },
    async (args) => {
      const workspace = manager.create({
        id: args.id as string | undefined,
        title: args.title as string | undefined,
      });
      await manager.save(workspace);
      return { id: workspace.id, title: workspace.title };
    },
  );

  tool(
    "sand_switch_workspace",
    "切换活动工作空间。切换前会先落盘当前工作空间的未保存内容；落盘失败则中止切换，不会丢内容。",
    { id },
    async (args) => {
      const result = await manager.switch(args.id as string);
      return {
        id: result.workspace.id,
        title: result.workspace.title,
        recovered: result.recovered,
        reason: result.reason,
      };
    },
  );

  tool(
    "sand_rename_workspace",
    "改工作空间的标题。",
    { id, title: z.string().min(1).max(200) },
    async (args) => {
      const workspace = await manager.rename(
        args.id as string,
        args.title as string,
      );
      return { id: workspace.id, title: workspace.title };
    },
  );

  tool(
    "sand_delete_workspace",
    "删除工作空间及其附件。被别的进程占用时会拒绝，并说明是谁在占用。",
    { id },
    async (args) => {
      try {
        return await manager.delete(args.id as string);
      } catch (e) {
        if (e instanceof WorkspaceLockError) throw e;
        throw e;
      }
    },
  );
}
