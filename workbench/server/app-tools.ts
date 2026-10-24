// v3 给界面用的工具：模型看不见，只有人和白板能调。
//
// 这里的写入都是「人做的事」：actor 固定是 human。
// 完整数据放 _meta.data，画布直接用；content 里的文本只给人看个大概。

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  applyCommands,
  boardContents,
  changesSince,
  CommandError,
  getMeta,
  historyList,
  jump,
  listActivities,
  parsePublicCommands,
  readView,
  redo,
  setView,
  undo,
  type CommandResult,
  type ToolRegistrar,
} from "../kernel/index.ts";
import { toolValue } from "./output.ts";
import {
  createWorkspace,
  deleteWorkspace,
  exportWorkspace,
  importWorkspace,
  listWorkspaces,
  renameWorkspace,
  switchWorkspace,
  type WorkspaceSession,
} from "./workspaces.ts";

export type AppToolsHost = {
  /** 当前打开的工作空间。 */
  session: () => WorkspaceSession;
  /** 切换工作空间后换掉当前会话。 */
  replaceSession: (next: WorkspaceSession) => void;
  /** 写入之后同步包工具的启停。 */
  afterWrite: (result: CommandResult) => void;
  /** 切换工作空间之后同步包工具的启停。 */
  afterSwitch: () => void;
  /** 历史导航之后同步包工具的启停。 */
  afterHistory: () => void;
};

/** 一次上传的字节上限。 */
const MAX_ASSET_BYTES = 20 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;

export function registerAppTools(
  registrar: ToolRegistrar,
  host: AppToolsHost,
): void {
  registrar.tool(
    "app_board",
    "Read the full contents of one board for the canvas to render: the board, its presentations, objects, relations, settings and packs.",
    {
      boardId: z.string().min(1),
      workspaceId: z.string().min(1).optional(),
    },
    (args, ctx) => {
      const session = host.session();
      assertSameWorkspace(session.workspaceId, args.workspaceId);
      const contents = boardContents(ctx.db, ctx.registry, args.boardId);
      return toolValue(
        {
          workspaceId: session.workspaceId,
          revision: contents.revision,
          board: { id: contents.board.id, title: contents.board.title },
          presentations: contents.presentations.length,
          objects: contents.objects.length,
          relations: contents.relations.length,
        },
        { workspaceId: session.workspaceId, ...contents },
      );
    },
    { appOnly: true },
  );

  registrar.tool(
    "app_changes",
    "Read everything that changed after a revision number. The canvas calls this once a second.",
    {
      since: z.number().int().min(0),
      workspaceId: z.string().min(1).optional(),
    },
    (args, ctx) => {
      const session = host.session();
      assertSameWorkspace(session.workspaceId, args.workspaceId);
      const changes = changesSince(ctx.db, ctx.registry, args.since);
      if ("reset" in changes)
        return toolValue(
          {
            workspaceId: session.workspaceId,
            reset: true,
            revision: changes.revision,
          },
          { workspaceId: session.workspaceId, ...changes },
        );
      return toolValue(
        {
          workspaceId: session.workspaceId,
          revision: changes.revision,
          objects: changes.objects.length,
          presentations: changes.presentations.length,
          relations: changes.relations.length,
          settings: changes.settings.length,
          packs: changes.packs.length,
        },
        { workspaceId: session.workspaceId, ...changes },
      );
    },
    { appOnly: true },
  );

  registrar.tool(
    "app_edit",
    "The person's edits: create, change, place, link or delete objects in one atomic batch. The whole batch is one undo step.",
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
    { appOnly: true },
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
    "app_history",
    "The person's undo, redo and jump along the board history.",
    {
      action: z.enum(["list", "undo", "redo", "jump"]),
      entryId: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    (args, ctx) => {
      if (args.action === "list") return historyList(ctx.db, args.limit ?? 20);
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
    { appOnly: true },
  );

  registrar.tool(
    "app_view",
    "Read and change the view: the open board, the selection and the camera. Never enters the history.",
    {
      action: z.enum(["get", "select", "camera", "navigate"]),
      viewId: z.string().min(1),
      boardId: z.string().min(1).optional(),
      camera: z.unknown().optional(),
      selection: z.array(z.string().min(1)).max(1200).optional(),
      navStack: z.array(z.unknown()).optional(),
    },
    (args, ctx) => {
      const session = host.session();
      if (args.action === "get") {
        const view = readView(ctx.db, args.viewId);
        return {
          workspaceId: session.workspaceId,
          viewId: view.viewId,
          board: view.board,
          selection: view.selection,
          camera: view.camera,
          navStack: view.navStack,
          revision: view.revision,
        };
      }
      if (args.action === "select") {
        if (!args.selection)
          throw new CommandError(
            "INVALID_DATA",
            "选择要给出选中的展示编号列表。请重新选择后再试。",
            null,
          );
        setView(
          ctx.db,
          {
            viewId: args.viewId,
            ...(args.boardId ? { boardId: args.boardId } : {}),
            selection: args.selection,
          },
          Date.now(),
        );
        return {
          ok: true,
          viewId: args.viewId,
          workspaceId: session.workspaceId,
        };
      }
      if (args.action === "camera") {
        if (args.camera === undefined)
          throw new CommandError(
            "INVALID_DATA",
            "调整镜头要给出镜头参数。请重新调整后再试。",
            null,
          );
        setView(
          ctx.db,
          {
            viewId: args.viewId,
            ...(args.boardId ? { boardId: args.boardId } : {}),
            camera: args.camera,
          },
          Date.now(),
        );
        return {
          ok: true,
          viewId: args.viewId,
          workspaceId: session.workspaceId,
        };
      }
      if (!args.boardId && !args.navStack)
        throw new CommandError(
          "INVALID_DATA",
          "进入白板要给出白板编号，返回要给出进入路径。请重新操作后再试。",
          null,
        );
      setView(
        ctx.db,
        {
          viewId: args.viewId,
          ...(args.boardId ? { boardId: args.boardId } : {}),
          ...(args.navStack ? { navStack: args.navStack } : {}),
        },
        Date.now(),
      );
      return {
        ok: true,
        viewId: args.viewId,
        workspaceId: session.workspaceId,
      };
    },
    { appOnly: true },
  );

  registrar.tool(
    "app_activity",
    "List what the agents are working on right now. It only reads: it never moves anyone's read cursor.",
    {
      action: z.literal("list"),
      limit: z.number().int().min(1).max(100).optional(),
    },
    (args, ctx) => {
      const session = host.session();
      const listed = listActivities(
        ctx.db,
        args.limit === undefined ? undefined : { limit: args.limit },
      );
      return {
        workspaceId: session.workspaceId,
        revision: listed.revision,
        activities: listed.activities,
        truncated: listed.truncated,
      };
    },
    { appOnly: true },
  );

  registrar.tool(
    "app_asset",
    "Upload an attachment or read one back by sha256. Attachments are stored by content, so the same file is stored only once.",
    {
      action: z.enum(["upload", "read"]),
      name: z.string().min(1).max(200).optional(),
      mime: z.string().min(1).max(200).optional(),
      base64: z.string().min(1).optional(),
      sha256: z.string().min(1).optional(),
    },
    (args) => {
      const session = host.session();
      const dir = join(session.root, session.workspaceId, "blobs");
      if (args.action === "upload") {
        if (!args.base64)
          throw new CommandError(
            "INVALID_DATA",
            "上传要给出文件内容（base64）。请重新选择文件后再试。",
            null,
          );
        const bytes = Buffer.from(args.base64, "base64");
        if (!bytes.length)
          throw new CommandError(
            "INVALID_DATA",
            "文件内容是空的。请重新选择文件后再试。",
            null,
          );
        if (bytes.length > MAX_ASSET_BYTES)
          throw new CommandError(
            "LIMIT",
            `单个附件最大 ${Math.floor(MAX_ASSET_BYTES / 1024 / 1024)} MB。请压缩后再上传。`,
            null,
          );
        const sha = createHash("sha256").update(bytes).digest("hex");
        mkdirSync(dir, { recursive: true });
        const target = join(dir, sha);
        if (!existsSync(target)) writeFileSync(target, bytes);
        return {
          sha256: sha,
          mime: args.mime ?? "application/octet-stream",
          bytes: bytes.length,
          ...(args.name ? { name: args.name } : {}),
        };
      }
      if (!args.sha256)
        throw new CommandError(
          "INVALID_DATA",
          "读附件要给出 sha256。请从对象的 blob 字段里取。",
          null,
        );
      if (!SHA256.test(args.sha256))
        throw new CommandError(
          "INVALID_DATA",
          "sha256 必须是 64 位小写十六进制。请从对象的 blob 字段里取。",
          null,
        );
      const target = join(dir, args.sha256);
      if (!existsSync(target))
        throw new CommandError(
          "NOT_FOUND",
          "找不到这个附件。请重新上传，或确认 sha256 没写错。",
          null,
        );
      const bytes = readFileSync(target);
      return {
        sha256: args.sha256,
        bytes: bytes.length,
        base64: bytes.toString("base64"),
      };
    },
    { appOnly: true },
  );

  registrar.tool(
    "app_workspace",
    "Manage workspaces: list, create, switch, rename, delete, export or import them. The workspace in use cannot be deleted. Import never overwrites an existing workspace.",
    {
      action: z.enum([
        "list",
        "create",
        "switch",
        "rename",
        "delete",
        "export",
        "import",
      ]),
      id: z.string().min(1).max(64).optional(),
      title: z.string().min(1).max(200).optional(),
      json: z.string().optional(),
    },
    (args) => {
      const session = host.session();
      if (args.action === "list")
        return {
          workspaceId: session.workspaceId,
          activeId: session.workspaceId,
          ...listWorkspaces(session.root, session.workspaceId),
        };
      if (args.action === "create") {
        const created = createWorkspace(session.root, session.registry, {
          ...(args.id ? { id: args.id } : {}),
          ...(args.title ? { title: args.title } : {}),
        });
        return created;
      }
      if (args.action === "export") {
        const exported = exportWorkspace(session);
        return toolValue(
          {
            filename: exported.filename,
            bytes: Buffer.byteLength(exported.json),
          },
          exported,
        );
      }
      if (args.action === "import") {
        if (!args.json)
          throw new CommandError(
            "INVALID_DATA",
            "导入要给出工作空间文件的 JSON 文本。请先选择导出的文件。",
            null,
          );
        return importWorkspace(session, args.json);
      }
      if (!args.id)
        throw new CommandError(
          "INVALID_DATA",
          "这个动作要给出工作空间编号。请先列出工作空间，再挑一个。",
          null,
        );
      if (args.action === "switch") {
        const next = switchWorkspace(session, args.id);
        host.replaceSession(next);
        host.afterSwitch();
        return { id: next.workspaceId, title: workspaceTitle(next) };
      }
      if (args.action === "rename") {
        if (!args.title)
          throw new CommandError(
            "INVALID_DATA",
            "改名要给出新标题。请写一个标题再试。",
            null,
          );
        return renameWorkspace(session, args.id, args.title);
      }
      return deleteWorkspace(session, args.id);
    },
    { appOnly: true },
  );

  registrar.tool(
    "app_pack",
    "Export a component pack. Importing goes through the pack.import command of app_edit.",
    { action: z.literal("export"), id: z.string().min(1) },
    (args, ctx) => {
      const pack = ctx.registry.getPack(args.id);
      if (!pack)
        throw new CommandError(
          "NOT_FOUND",
          `没有组件包「${args.id}」。请用 sand_status 看看有哪些包。`,
          null,
        );
      const manifest = {
        format: "sand-table-pack",
        formatVersion: 2,
        ...pack.spec,
      };
      return toolValue(
        {
          id: manifest.id,
          title: manifest.title,
          version: manifest.version,
          format: manifest.format,
        },
        manifest,
      );
    },
    { appOnly: true },
  );
}

function workspaceTitle(session: WorkspaceSession) {
  return getMeta(session.db, "title") ?? session.workspaceId;
}

/**
 * 界面带着它以为自己在的工作空间来读数据。
 *
 * 对不上就报错，不给数据：切换工作空间前那一次读到的旧白板，
 * 混进新工作空间里，比读不到更糟。
 */
function assertSameWorkspace(current: string, expected?: string): void {
  if (expected === undefined || expected === current) return;
  throw new CommandError(
    "INVALID_DATA",
    `这次请求说的是工作空间「${expected}」，现在打开的是「${current}」。请重新加载当前工作空间，不要把旧工作空间的数据合进来。`,
    null,
  );
}
