import { z } from "zod";
import {
  CommandError,
  readObjects,
  type ToolRegistrar,
} from "../kernel/index.ts";
import {
  BOARD_PROVIDER_ID,
  boardNamespace,
  createBoardProvider,
} from "../resources/board-provider.ts";
import { createResourceRegistry } from "../resources/registry.ts";
import type { ResourceProvider, ResourceRef } from "../resources/types.ts";
import type { WorkspaceSession } from "./workspaces.ts";
import { toolValue } from "./output.ts";

export function createResourceTools(session: () => WorkspaceSession) {
  const resources = createResourceRegistry();
  let active: WorkspaceSession | undefined;
  let remove: (() => void) | undefined;
  function sync() {
    const current = session();
    if (active !== current) {
      remove?.();
      active = current;
      remove = resources.register(
        createBoardProvider({
          ...current,
          namespace: boardNamespace(current.root, current.workspaceId),
        }),
      );
    }
    return current;
  }
  function binding(objectId: string, expectedVersion?: number) {
    const current = sync();
    const row = readObjects(current.db, current.registry, [objectId], {
      textLimit: 1,
      include: [],
    }).objects[0];
    if (!row)
      throw new CommandError("NOT_FOUND", "引用对象不存在，请重新选择。", null);
    if (expectedVersion !== undefined && row.version !== expectedVersion)
      throw new CommandError(
        "VERSION_CONFLICT",
        "引用已变化，请重新读取再打开资源。",
        null,
      );
    const ref: ResourceRef = row.source?.resource ?? {
      providerId: BOARD_PROVIDER_ID,
      namespace: boardNamespace(current.root, current.workspaceId),
      resourceId: row.id,
    };
    return {
      workspaceId: current.workspaceId,
      objectId,
      objectVersion: row.version,
      ref,
      ...(row.type === "base.resource_reference" && !row.source?.resource
        ? { unbound: true }
        : {}),
    };
  }
  async function request(args: {
    objectId: string;
    expectedVersion?: number;
    workspaceId?: string;
    action: "read" | "open" | "binding";
  }) {
    const captured = binding(args.objectId, args.expectedVersion);
    if (
      args.workspaceId !== undefined &&
      args.workspaceId !== captured.workspaceId
    )
      throw new CommandError(
        "FORBIDDEN",
        "工作空间已切换，请在当前工作空间重新选择。",
        null,
      );
    if (args.action === "binding") return captured;
    if (captured.unbound)
      return {
        ...captured,
        value: {
          status: "unsupported" as const,
          ref: captured.ref,
          reason: "尚未绑定原资源，请先选择提供者和资源。本地说明已保留。",
        },
      };
    const value = await resources[args.action](captured.ref);
    const current = binding(args.objectId, captured.objectVersion);
    if (JSON.stringify(current) !== JSON.stringify(captured))
      throw new CommandError(
        "VERSION_CONFLICT",
        "读取期间引用已变化，请重新读取。",
        null,
      );
    return { ...captured, value };
  }
  return {
    resources,
    sync,
    binding,
    request,
    register(provider: ResourceProvider) {
      return resources.register(provider);
    },
    registerTools(registrar: ToolRegistrar) {
      registrar.tool(
        "app_resource",
        "Read or open the resource bound to a saved local object. Resource identity comes from the saved source, never from an arbitrary client locator.",
        {
          objectId: z.string().min(1),
          expectedVersion: z.number().int().min(1),
          workspaceId: z.string().min(1).optional(),
          action: z.enum(["read", "open", "binding"]),
        },
        async (args) => {
          const value = await request(args);
          return toolValue(value, value);
        },
        { appOnly: true, readOnly: true },
      );
    },
    dispose() {
      remove?.();
      resources.dispose();
    },
  };
}
