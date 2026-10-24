// v3 给模型看的 8 个核心工具。
//
// 每个工具只做三件事：解析参数 → 调内核 → 整理输出。
// 业务规则在核心里，这里不重复实现。

import { z } from "zod";
import {
  applyCommands,
  CommandError,
  context,
  historyList,
  jump,
  listTypes,
  parsePublicCommands,
  query,
  readObjects,
  redo,
  setActivity,
  status,
  undo,
  type CommandResult,
  type ToolRegistrar,
} from "../kernel/index.ts";
import { modelText, overBudget } from "./output.ts";

export type CoreToolsHost = {
  /** 宿主能力：告诉模型这个宿主能做什么。 */
  host: () => { taskSubmit: boolean };
  /** 写入之后同步包工具的启停。 */
  afterWrite: (result: CommandResult) => void;
  /** 历史导航之后同步包工具的启停。 */
  afterHistory: () => void;
};

const QUERY_DEFAULT_LIMIT = 20;
const HISTORY_DEFAULT_LIMIT = 20;

export function registerCoreTools(
  registrar: ToolRegistrar,
  host: CoreToolsHost,
): void {
  registrar.tool(
    "sand_status",
    "Show the current Sand Table workspace: boards, enabled packs and revision. Call this first. Opens the board UI in hosts that support MCP Apps.",
    {},
    (args, ctx) => {
      const state = status(ctx.db, ctx.registry);
      const result = {
        workspace: state.workspace,
        homeBoardId: state.homeBoardId,
        boards: state.boards,
        packs: state.packs,
        host: host.host(),
        tips: state.tips,
        /* 框内坐标说不准时，这里带着要人工确认的提示。 */
        frameCoords: state.frameCoords,
      };
      return fitBoards(result);
    },
    { readOnly: true, ui: true },
  );

  registrar.tool(
    "sand_types",
    "List object types, relation kinds and templates. Pass types to get the full JSON Schema and relation slots of specific types before creating or editing them.",
    {
      types: z.array(z.string().min(1)).max(20).optional(),
      pack: z.string().min(1).optional(),
    },
    (args, ctx) =>
      listTypes(ctx.db, ctx.registry, {
        ...(args.types ? { types: args.types } : {}),
        ...(args.pack ? { pack: args.pack } : {}),
      }),
    { readOnly: true },
  );

  registrar.tool(
    "sand_query",
    "Find objects by board, type, text or relation. Returns short rows with ids; use sand_read for full content.",
    {
      boardId: z.string().min(1).optional(),
      types: z.array(z.string().min(1)).max(20).optional(),
      text: z.string().optional(),
      relatedTo: z
        .object({
          id: z.string().min(1),
          kind: z.string().min(1).optional(),
          direction: z.enum(["out", "in", "both"]).optional(),
        })
        .optional(),
      order: z.enum(["updated", "title"]).optional(),
      limit: z.number().int().min(1).max(50).optional(),
      cursor: z.string().min(1).optional(),
    },
    (args, ctx) =>
      fitQuery(ctx.db, ctx.registry, {
        ...(args.boardId ? { boardId: args.boardId } : {}),
        ...(args.types ? { types: args.types } : {}),
        ...(args.text ? { text: args.text } : {}),
        ...(args.relatedTo ? { relatedTo: args.relatedTo } : {}),
        ...(args.order ? { order: args.order } : {}),
        ...(args.limit ? { limit: args.limit } : {}),
        ...(args.cursor ? { cursor: args.cursor } : {}),
      }),
    { readOnly: true },
  );

  registrar.tool(
    "sand_read",
    "Read full objects by id, including where they are placed and how they relate to other objects. Long text fields are cut; use textOffset to read more.",
    {
      ids: z.array(z.string().min(1)).min(1).max(20),
      include: z.array(z.enum(["presentations", "relations"])).optional(),
      textLimit: z.number().int().min(1).max(20_000).optional(),
      textOffset: z
        .object({
          id: z.string().min(1),
          field: z.string().min(1),
          offset: z.number().int().min(0),
        })
        .optional(),
    },
    (args, ctx) =>
      readObjects(ctx.db, ctx.registry, args.ids, {
        ...(args.include ? { include: args.include } : {}),
        ...(args.textLimit ? { textLimit: args.textLimit } : {}),
        ...(args.textOffset ? { textOffset: args.textOffset } : {}),
      }),
    { readOnly: true },
  );

  registrar.tool(
    "sand_edit",
    'Create, change, place, relate or delete objects in one atomic batch. Every batch is one undo step. Check sand_types for the data schema first. Use "@name" to refer to an object created earlier in the same batch via ref: "name".',
    {
      intentId: z.string().min(1).max(200).optional(),
      label: z.string().min(1).max(200).optional(),
      commands: z.array(z.record(z.string(), z.unknown())).min(1).max(200),
    },
    (args, ctx) => {
      const result = applyCommands(ctx.db, ctx.registry, {
        actor: ctx.actor,
        ...(args.intentId ? { intentId: args.intentId } : {}),
        ...(args.label ? { label: args.label } : {}),
        commands: parsePublicCommands(args.commands),
      });
      host.afterWrite(result);
      return result;
    },
  );

  /**
   * 历史导航：内核走完再同步包工具的启停。
   *
   * 导航会把 packs 表一起还原，工具的启停要跟着数据库走；
   * 导航失败时抛错，句柄保持原样。
   */
  const navigate = (
    run: () => { revision: number; cursorId: string | null },
  ) => {
    const result = run();
    host.afterHistory();
    return result;
  };

  registrar.tool(
    "sand_history",
    "List, undo, redo or jump in the board history. Undo and redo move one step along the current path; jump goes to any recorded step, including old branches.",
    {
      action: z.enum(["list", "undo", "redo", "jump"]),
      entryId: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    (args, ctx) => {
      if (args.action === "list")
        return historyList(ctx.db, args.limit ?? HISTORY_DEFAULT_LIMIT);
      if (args.action === "undo")
        return navigate(() => undo(ctx.db, ctx.actor));
      if (args.action === "redo")
        return navigate(() => redo(ctx.db, ctx.actor));
      if (!args.entryId)
        throw new CommandError(
          "INVALID_DATA",
          "跳转要给出历史记录的编号。请先列出历史，再跳到其中一条。",
          null,
        );
      return navigate(() => jump(ctx.db, ctx.actor, args.entryId));
    },
  );

  registrar.tool(
    "sand_context",
    "See what the person is looking at now: the open board, the selection, and what they changed since you last called this.",
    { viewId: z.string().min(1).optional() },
    (args, ctx) => context(ctx.db, ctx.actor, args.viewId),
    { readOnly: true },
  );

  registrar.tool(
    "sand_activity",
    "Tell the person what you are working on and which objects you are looking at. This is shown on the board; it never moves the person's view.",
    {
      state: z.enum(["running", "waiting", "done", "unknown"]),
      task: z.string().max(300),
      action: z.string().max(200),
      objectIds: z.array(z.string().min(1)).max(30).optional(),
      boardId: z.string().min(1).optional(),
    },
    (args, ctx) => {
      setActivity(
        ctx.db,
        ctx.actor,
        {
          state: args.state,
          task: args.task,
          action: args.action,
          ...(args.objectIds ? { objectIds: args.objectIds } : {}),
          ...(args.boardId ? { boardId: args.boardId } : {}),
        },
        Date.now(),
      );
      return { ok: true };
    },
  );
}

/**
 * 白板多的时候，模型只看得到前几块。
 *
 * 首页白板留在第一位，砍的是后面的。
 */
function fitBoards<T extends { boards: unknown[] }>(result: T): T {
  let boards = result.boards;
  while (boards.length > 1 && overBudget(modelText({ ...result, boards })))
    boards = boards.slice(0, Math.ceil(boards.length / 2));
  return { ...result, boards };
}

/**
 * 查询结果也有预算。
 *
 * 放不下就少取几行：翻页游标由内核算，重新查一次就好，页码不会乱。
 */
function fitQuery(
  db: Parameters<typeof query>[0],
  registry: Parameters<typeof query>[1],
  filter: Parameters<typeof query>[2],
) {
  let limit = filter.limit ?? QUERY_DEFAULT_LIMIT;
  let result = query(db, registry, { ...filter, limit });
  while (limit > 1 && overBudget(modelText(result))) {
    limit = Math.max(1, Math.floor(limit / 2));
    result = query(db, registry, { ...filter, limit });
  }
  return result;
}
