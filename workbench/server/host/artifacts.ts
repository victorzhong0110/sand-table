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
  type PresentationRow,
} from "../../kernel/index.ts";
import { builtinPacks } from "../../packs/index.ts";
import { migrateTable } from "../../packs/base/index.ts";
import {
  BOARD_PROVIDER_ID,
  boardNamespace,
} from "../../resources/board-provider.ts";
import { assertWorkspaceId } from "../workspaces.ts";
import type { Binding, Delivery, SpatialContext } from "./contracts.ts";

type Scope = Pick<Binding, "boardId" | "workspaceId" | "workspaceNamespace">;

function position(
  row: PresentationRow,
): SpatialContext["presentations"][number] {
  const { id, objectId, version, parentId, x, y, width, height, z } = row;
  return { id, objectId, version, parentId, x, y, width, height, z };
}

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
    verify(
      scope: Scope,
      request: Pick<Binding, "targets" | "selection" | "contextVersion">,
    ): SpatialContext | undefined {
      return withWorkspace(scope, ({ db }, registry) => {
        const board = boardContents(db, registry, scope.boardId);
        if (!registry.getType(board.board.type)?.capabilities?.container)
          throw Error("提交目标已不是可用的白板。请重新选择白板。");
        const versions = new Map(
          board.objects.map((row) => [row.id, row.version]),
        );
        if (
          request.targets.some(
            (target) => versions.get(target.objectId) !== target.version,
          )
        )
          throw Error("提交时有对象已变化或移出白板，请重新核对选区。");
        const selection = request.selection;
        if (!selection) return undefined;
        if (board.revision !== request.contextVersion)
          throw Error("白板内容或布局刚刚更新，请核对当前选区后重新提交。");
        const byId = new Map(board.presentations.map((row) => [row.id, row]));
        const selected = new Set(selection.presentationIds);
        if (selection.scope === "board" && selected.size !== byId.size)
          throw Error("白板上的展示已变化，请重新确认讨论范围。");
        const presentations = selection.presentationIds.map((id) => {
          const row = byId.get(id);
          if (!row) throw Error("有展示已移动或删除，请重新选择。");
          return position(row);
        });
        const objects = new Set(presentations.map(({ objectId }) => objectId));
        if (
          request.targets.length !== objects.size ||
          new Set(request.targets.map(({ objectId }) => objectId)).size !==
            objects.size ||
          request.targets.some(({ objectId }) => !objects.has(objectId))
        )
          throw Error("选区展示与目标对象不一致，请重新选择。");
        const ancestors = new Map<string, ReturnType<typeof position>>();
        for (const item of presentations) {
          let parent = item.parentId;
          const path = new Set([item.id]);
          while (parent) {
            const row = byId.get(parent);
            if (!row || path.has(parent))
              throw Error("选区分组结构已变化，请重新打开白板后再试。");
            path.add(parent);
            if (!selected.has(parent)) ancestors.set(parent, position(row));
            if (ancestors.size > 200)
              throw Error("选区涉及的分组超过 200 个，请缩小选区。");
            parent = row.parentId;
          }
        }
        const relations = board.relations.filter(
          ({ sourceId, targetId }) =>
            objects.has(sourceId) && objects.has(targetId),
        );
        return {
          boardId: scope.boardId,
          boardVersion: board.board.version,
          viewId: selection.viewId,
          revision: board.revision,
          presentations,
          ancestors: [...ancestors.values()],
          relations: relations
            .slice(0, 200)
            .map(({ id, kind, sourceId, targetId, version, status }) => ({
              id,
              kind,
              sourceId,
              targetId,
              version,
              status,
            })),
          omittedRelations: Math.max(0, relations.length - 200),
          resources: board.objects.flatMap(({ id: objectId, source }) =>
            objects.has(objectId) && source?.resource
              ? [
                  {
                    objectId,
                    ref: source.resource,
                    status: "not_read" as const,
                  },
                ]
              : [],
          ),
        };
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
                  ? migrateTable({ columns: value.columns, rows: value.rows })
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
