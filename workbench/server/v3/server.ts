// v3 的 MCP 服务端。
//
// 启动顺序：建注册表 → 注册内置包 → 打开工作空间 → 注册工具。
// 包工具随包启停：每个内置包注册时记住它注册出的工具，包停了就把工具停掉，
// SDK 会自动通知客户端工具列表变了。

import { readFileSync } from "node:fs";
import {
  McpServer,
  type CallToolResult,
  type ReadResourceResult,
  type RegisteredTool,
} from "@modelcontextprotocol/server";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import {
  createRegistry,
  isPackEnabled,
  openWorkspace,
  packStates,
  type Actor,
  type CommandResult,
  type PackSpec,
  type ToolRegistrar,
} from "../../kernel/index.ts";
import { builtinPacks } from "../../packs/index.ts";
import { registerAppTools } from "./app-tools.ts";
import { registerCoreTools } from "./core-tools.ts";
import { registerFolderTools } from "./folder-tools.ts";
import { toolError, toolResult } from "./output.ts";
import type { WorkspaceSession } from "./workspaces.ts";

/** 白板界面的地址。宿主支持 MCP Apps 时，调用 sand_status 会打开它。 */
const UI_URI = "ui://sand-table/overview.html";

const HUMAN: Actor = { id: "human", kind: "human" };

export type Forwarder = {
  tool: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<CallToolResult>;
  resource: () => Promise<ReadResourceResult>;
};

export type ServerOptions = {
  /** 工作空间存储根目录。 */
  workspaceRoot: string;
  /** 工作空间 ID。 */
  workspaceId: string;
  /** 转发器：有了它，本进程只负责列工具，调用交给别处。 */
  forward?: Forwarder;
  /** 内置包清单。缺省是仓库里的内置包；换掉它是为了能测包工具的启停。 */
  packs?: PackSpec[];
  /**
   * 启动时绑定的文件夹。
   *
   * 只有绑了才注册 folder_read，而且只能读这一个目录。
   */
  folder?: string;
};

export function createServerV3(options: ServerOptions) {
  const server = new McpServer({ name: "sand-table", version: "0.3.0" });
  const packs = options.packs ?? builtinPacks;
  const registry = createRegistry();
  for (const spec of packs) registry.registerPack(spec, "builtin");

  let session: WorkspaceSession | null = null;
  if (!options.forward) {
    const opened = openWorkspace(
      options.workspaceRoot,
      options.workspaceId,
      registry,
    );
    session = {
      registry,
      root: options.workspaceRoot,
      workspaceId: options.workspaceId,
      db: opened.db,
    };
  }

  const handles = new Map<string, RegisteredTool>();
  const packTools = new Map<string, string[]>();

  const registrar: ToolRegistrar = {
    tool(name, description, shape, handler, toolOptions) {
      /* 只有 sand_status 带界面资源；界面专用工具只声明可见性。
         模型可见的工具不带 ui 字段，宿主就不会把它们当界面工具渲染。 */
      const ui = {
        ...(toolOptions?.ui ? { resourceUri: UI_URI } : {}),
        ...(toolOptions?.appOnly ? { visibility: ["app" as const] } : {}),
      };
      const handle = registerAppTool(
        server,
        name,
        {
          description,
          annotations: {
            readOnlyHint: toolOptions?.readOnly === true,
            destructiveHint: toolOptions?.readOnly !== true,
            openWorldHint: false,
          },
          inputSchema: z.object(shape as z.ZodRawShape),
          _meta: Object.keys(ui).length > 0 ? { ui } : {},
        },
        async (args) => {
          try {
            if (options.forward)
              return await options.forward.tool(
                name,
                args as Record<string, unknown>,
              );
            const current = session;
            if (!current) throw new Error("这个服务还没有打开工作空间。");
            const result = await handler(args, {
              actor: toolOptions?.appOnly ? HUMAN : agentActor(),
              db: current.db,
              registry: current.registry,
            });
            return toolResult(result);
          } catch (error) {
            return toolError(error);
          } finally {
            // 包工具可能在这次调用里改了组件包启停，返回前先让工具列表跟上。
            try {
              refreshPackTools();
            } catch {
              /* 下一秒的计时器会再对一次 */
            }
          }
        },
      );
      handles.set(name, handle);
    },
  };

  /** 模型可见工具的 actor：取 MCP 握手里的客户端名，取不到就用 agent。 */
  function agentActor(): Actor {
    const name = server.server.getClientVersion()?.name;
    return { id: name && name.trim() ? name : "agent", kind: "agent" };
  }

  /** 宿主能力：只报客户端真的声明过的。 */
  function hostInfo() {
    const capabilities = server.server.getClientCapabilities();
    return { taskSubmit: capabilities?.tasks !== undefined };
  }

  /** 包停了就停掉它的工具。转发模式不知道包状态，一律列出来，由真正的服务端裁决。 */
  function syncPackTools(packId: string) {
    const names = packTools.get(packId);
    if (!names) return;
    const enabled = session ? isPackEnabled(session.db, packId) : true;
    for (const name of names) {
      const handle = handles.get(name);
      if (!handle) continue;
      if (enabled) handle.enable();
      else handle.disable();
    }
  }

  function afterWrite(result: CommandResult) {
    for (const change of result.changed)
      if (change.table === "packs") syncPackTools(change.id);
  }

  /* 别的进程改了包的启停，这一边也要跟着改。
     靠库里的 packs 修订号发现变化，每秒看一次；
     本进程的写入回调只是让它更快，不承担这个责任。 */
  const appliedPacks = new Map<string, string>();

  function packMarks(): Map<string, string> {
    const marks = new Map<string, string>();
    if (!session) return marks;
    for (const state of packStates(session.db))
      marks.set(
        state.id,
        `${state.enabled ? "1" : "0"}@${state.version}#${state.rev}`,
      );
    return marks;
  }

  function refreshPackTools(): void {
    if (!session) return;
    const marks = packMarks();
    const dirty: string[] = [];
    for (const [packId, mark] of marks)
      if (appliedPacks.get(packId) !== mark) dirty.push(packId);
    for (const packId of appliedPacks.keys())
      if (!marks.has(packId)) dirty.push(packId);
    appliedPacks.clear();
    for (const [packId, mark] of marks) appliedPacks.set(packId, mark);
    for (const packId of dirty) syncPackTools(packId);
  }

  /* 历史导航不知道哪条记录动了哪个包，整体同步一遍。
     转发模式没有包状态，一律列出来，由真正的服务端裁决。 */
  function syncAllPackTools() {
    for (const packId of packTools.keys()) syncPackTools(packId);
  }

  registerCoreTools(registrar, {
    host: hostInfo,
    afterWrite,
    afterHistory: syncAllPackTools,
  });
  registerAppTools(registrar, {
    session: () => {
      const current = session;
      if (!current) throw new Error("这个服务还没有打开工作空间。");
      return current;
    },
    replaceSession: (next) => {
      session = next;
    },
    afterWrite,
    afterSwitch: syncAllPackTools,
    afterHistory: syncAllPackTools,
  });

  /* 包工具：每个内置包都注册一次，启用与否交给包状态决定。 */
  for (const spec of packs) {
    if (!spec.registerTools) continue;
    const before = new Set(handles.keys());
    spec.registerTools(registrar);
    packTools.set(
      spec.id,
      [...handles.keys()].filter((name) => !before.has(name)),
    );
    syncPackTools(spec.id);
  }

  /* 文件夹不是包工具：停用领域包不会把它关掉，没绑定就不会出现。 */
  const folder = options.folder?.trim();
  if (folder) registerFolderTools(registrar, folder);

  /* 记下现在的包状态：这一秒之后的变动才算变化。 */
  for (const [packId, mark] of packMarks()) appliedPacks.set(packId, mark);

  /* 每秒看一次别的进程有没有改包。
     计时器不拦着进程退出，服务收尾时也会清掉它。 */
  const packWatcher = setInterval(() => {
    try {
      refreshPackTools();
    } catch {
      /* 这一轮读库失败就等下一秒，不让计时器停下来 */
    }
  }, 1000);
  packWatcher.unref();

  registerAppResource(server, "Sand Table overview", UI_URI, {}, async () =>
    options.forward
      ? options.forward.resource()
      : {
          contents: [
            {
              uri: UI_URI,
              mimeType: RESOURCE_MIME_TYPE,
              text: readFileSync(
                new URL("../../dist/board.html", import.meta.url),
                "utf8",
              ),
              _meta: {
                ui: { csp: { connectDomains: [], resourceDomains: [] } },
              },
            },
          ],
        },
  );

  return {
    server,
    registry,
    /** 当前打开的工作空间。 */
    workspace: () => session,
    /**
     * 看包的计时器。
     *
     * 留着是为了能问「它还在吗」：服务收尾时它必须被清掉。
     */
    packWatcher: () => packWatcher,
    dispose: () => {
      clearInterval(packWatcher);
      session?.db.close();
    },
  };
}
