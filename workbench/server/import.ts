import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { z } from "zod";
import type { BoardStore } from "../core/store.ts";
import { bind, scan, type Binding } from "./repository.ts";
import { Spaces } from "./spaces.ts";
import { openView } from "../core/space-state.ts";
import type { RegisterTool } from "./tool-types.ts";
export function registerRepositoryImport(
  tool: RegisterTool,
  store: BoardStore,
  bindings: Binding[],
) {
  const id = z.string().min(1).max(500);
  tool(
    "sand_rename_board",
    "Rename the shared board.",
    {
      boardId: id,
      revision: z.number().int(),
      title: z.string().trim().min(1).max(120),
    },
    (a) => {
      const b = store.get(a.boardId);
      if (b.revision !== a.revision) throw Error("Board changed. Retry.");
      b.title = a.title;
      b.revision++;
      return store.read(b.id);
    },
    true,
  );
  tool(
    "sand_import_repository",
    "Human explicitly connects a local Git root and adds its file/folder scene inside a nested board. Never automatic on startup. Does not clone, install, execute or write target files.",
    {
      boardId: id,
      revision: z.number().int(),
      viewId: id,
      path: z.string().min(1).max(2000).optional(),
      workspaceId: id.optional(),
    },
    (a) => {
      const b = store.get(a.boardId);
      if (b.revision !== a.revision)
        throw Error("Board changed. Reload before importing.");
      if (Boolean(a.path) === Boolean(a.workspaceId))
        throw Error(
          "Choose an existing workspace or provide one absolute Git root.",
        );
      let binding: Binding;
      let next = [...bindings];
      if (a.workspaceId) {
        const found = bindings.find((w) => w.id === a.workspaceId);
        if (!found) throw Error("Unknown workspace.");
        binding = found;
      } else {
        const base =
          basename(a.path!)
            .replace(/[^a-zA-Z0-9_-]/g, "-")
            .slice(0, 32) || "project";
        const label = bindings.some((w) => w.label === base)
          ? base + "-" + randomUUID().slice(0, 4)
          : base;
        const imported = bind([label + "=" + a.path!])[0];
        binding = bindings.find((w) => w.id === imported.id) || imported;
        if (!bindings.some((w) => w.id === binding.id)) next.push(binding);
        if (next.length > 4)
          throw Error("At most four connected workspaces per session.");
      }
      const projection = scan(next);
      const files = projection.objects.filter(
        (o) => o.workspaceId === binding.id && o.kind === "file",
      );
      const folders = [
        ...new Set(
          files
            .map((o) =>
              o.source!.path.includes("/") ? o.source!.path.split("/")[0] : "",
            )
            .filter(Boolean),
        ),
      ];
      if (
        b.spaces.length + 1 + folders.length > 80 ||
        b.instances.length + 1 + folders.length + files.length > 2200
      )
        throw Error("Not enough component/space capacity to import.");
      // All filesystem checks and capacity checks complete before mutating the shared model.
      bindings.splice(0, bindings.length, ...next);
      b.autoProjectSources = false;
      store.refresh(b.id, projection);
      const spaces = new Spaces(store),
        view = openView(b, a.viewId);
      const op = (operation: unknown) =>
        spaces.update(b.id, b.revision, a.viewId, operation, "human-import");
      op({
        kind: "create",
        type: "board",
        title: (basename(binding.root) || binding.label).slice(0, 120),
        data: {},
      });
      const container = b.instances.find((i) => i.id === view.selection[0])!,
        target = String(container.data.spaceId);
      op({ kind: "navigate", spaceId: target });
      const locations = new Map<string, string>([["", target]]);
      for (const folder of folders) {
        op({ kind: "create", type: "board", title: folder, data: {} });
        const entry = b.instances.find((i) => i.id === view.selection[0])!;
        locations.set(folder, String(entry.data.spaceId));
      }
      for (const [folder, spaceId] of locations) {
        op({ kind: "navigate", spaceId });
        for (const file of files.filter(
          (o) =>
            (o.source!.path.includes("/")
              ? o.source!.path.split("/")[0]
              : "") === folder,
        )) {
          op({
            kind: "create",
            type: "object",
            title: folder
              ? file.source!.path.slice(folder.length + 1)
              : file.title,
            objectId: file.id,
            data: {},
          });
        }
      }
      op({ kind: "navigate", spaceId: target });
      return store.read(b.id);
    },
    true,
  );
}
