import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
  applyDelivery,
  boardContents,
  createRegistry,
  deliveryReceipt,
  openWorkspace,
  type Command,
  type CommandResult,
} from "../../kernel/index.ts";
import { builtinPacks } from "../../packs/index.ts";
import {
  BOARD_PROVIDER_ID,
  boardNamespace,
} from "../../resources/board-provider.ts";
import { assertWorkspaceId } from "../workspaces.ts";
import type { Binding, Delivery } from "./contracts.ts";

type Scope = Pick<Binding, "boardId" | "workspaceId" | "workspaceNamespace">;

export function createArtifactWriter(root: string) {
  function withWorkspace<T>(
    scope: Scope,
    run: (
      opened: ReturnType<typeof openWorkspace>,
      registry: ReturnType<typeof createRegistry>,
    ) => T,
  ): T {
    assertWorkspaceId(root, scope.workspaceId);
    const directory = join(realpathSync(root), scope.workspaceId);
    const file = join(directory, "workspace.db");
    if (!existsSync(file) || realpathSync(file) !== file)
      throw Error("找不到原工作空间，请恢复原白板服务后再核对交付。");
    if (scope.workspaceNamespace !== boardNamespace(root, scope.workspaceId))
      throw Error("白板服务的工作空间与 DSH 配置不一致，请核对存储目录。");
    const registry = createRegistry();
    for (const pack of builtinPacks) registry.registerPack(pack, "builtin");
    const opened = openWorkspace(root, scope.workspaceId, registry);
    try {
      return run(opened, registry);
    } finally {
      opened.db.close();
    }
  }

  return {
    matchesScope(scope: Scope) {
      return (
        scope.workspaceNamespace === boardNamespace(root, scope.workspaceId)
      );
    },
    verify(scope: Scope, targets: Binding["targets"]) {
      withWorkspace(scope, ({ db }, registry) => {
        const board = boardContents(db, registry, scope.boardId);
        if (!registry.getType(board.board.type)?.capabilities?.container)
          throw Error("提交目标已不是可用的白板。请重新选择白板。");
        const versions = new Map(
          board.objects.map((row) => [row.id, row.version]),
        );
        if (
          targets.some(
            (target) => versions.get(target.objectId) !== target.version,
          )
        )
          throw Error("提交时有对象已变化或移出白板，请重新核对选区。");
      });
    },
    receipt(scope: Scope, operationId: string) {
      return withWorkspace(scope, ({ db }) => deliveryReceipt(db, operationId));
    },
    write(binding: Binding, delivery: Delivery): CommandResult {
      const value = delivery.artifact;
      const about = value.kind === "note" ? value.candidateFor : undefined;
      if (
        about &&
        !binding.targets.some(
          (target) =>
            target.objectId === about.objectId &&
            target.version === about.version,
        )
      )
        throw Error("候选修改须引用提交时选定的对象及版本。");
      return withWorkspace(binding, ({ db }, registry) => {
        const source = {
          origin: "ai-generated" as const,
          basis: `DSH ${binding.session.id} / ${binding.requestId} / ${delivery.seq}`,
          ...(value.kind === "resource" ? { resource: value.resource } : {}),
        };
        const commands: Command[] = [
          {
            op: "object.create",
            ref: "artifact",
            title: about ? `待确认 · ${value.title}` : value.title,
            type:
              value.kind === "note"
                ? "base.note"
                : value.kind === "table"
                  ? "base.table"
                  : "base.resource_reference",
            data:
              value.kind === "note"
                ? {
                    body: about
                      ? `基于原对象版本 ${about.version} 的修改建议。请对照当前版本后采纳。\n\n${value.body}`
                      : value.body,
                  }
                : value.kind === "table"
                  ? { columns: value.columns, rows: value.rows }
                  : { note: value.note ?? "" },
            source,
          },
          {
            op: "presentation.create",
            objectId: "@artifact",
            boardId: binding.boardId,
          },
        ];
        if (about)
          commands.push({
            op: "relation.create",
            kind: "base.related",
            sourceId: "@artifact",
            targetId: about.objectId,
          });
        return applyDelivery(db, registry, delivery.operationId, {
          actor: { id: "dsh", kind: "agent" },
          label: "接收 AI 产物",
          commands,
        });
      });
    },
    namespace(
      ref: { providerId?: string; namespace?: string } | undefined,
    ): string {
      if (ref?.providerId !== BOARD_PROVIDER_ID || !ref.namespace)
        throw Error("宿主无法核对原白板的存储位置。");
      return ref.namespace;
    },
  };
}
