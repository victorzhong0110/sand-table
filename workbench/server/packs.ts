import { z } from "zod";
import type { BoardStore } from "../core/store.ts";
import {
  MAX_MANIFEST_BYTES,
  MAX_PACKS_PER_BOARD,
  packManifestOf,
  parsePackManifest,
  toComponentPack,
} from "../core/packs.ts";
import { fetchPackManifest } from "../core/pack-fetch.ts";
import type { RegisterTool } from "./tool-types.ts";

const id = z.string().min(1).max(500);
const board = { boardId: id };

/* The manifest arrives either as text or as an address the server fetches. */
const source = z.union(
  [
    z.strictObject({
      json: z.string().min(1, { error: "json 不能为空。" }).max(MAX_MANIFEST_BYTES),
    }),
    z.strictObject({
      url: z.string().min(1, { error: "url 不能为空。" }).max(2000),
    }),
  ],
  { error: "source 只能是 { json } 或 { url }，二选一。" },
);

export function registerPackTools(tool: RegisterTool, store: BoardStore) {
  tool(
    "sand_import_component_pack",
    "Import a component pack into the board. A pack is DATA, not code: it is a JSON manifest of presets for component types that already exist. It cannot add a component type, change source code, write files or grant permission, and its prefilled data goes through the same check as hand-written edits. Importing the same id again upgrades that pack.",
    {
      ...board,
      revision: z.number().int(),
      viewId: id,
      author: z.string().min(1).max(100).default("human"),
      source,
    },
    async (a) => {
      const b = store.get(a.boardId);
      if (b.revision !== a.revision)
        throw Error("Board changed. Read current board and retry.");
      const importedBy = a.author || "human";
      let text: string;
      let origin: string;
      if ("json" in a.source) {
        text = a.source.json;
        origin = "json";
      } else {
        text = (await fetchPackManifest(a.source.url)).text;
        origin = "url:" + a.source.url;
      }
      const { manifest, warnings } = parsePackManifest(text);
      const packs = b.componentPacks ?? [];
      const at = packs.findIndex((p) => p.id === manifest.id);
      if (at < 0 && packs.length >= MAX_PACKS_PER_BOARD)
        throw Error(
          `这张白板最多 ${MAX_PACKS_PER_BOARD} 个组件包；先移除一个再导入。`,
        );
      const pack = toComponentPack(manifest, {
        source: origin,
        importedAt: Date.now(),
        importedBy,
      });
      b.componentPacks =
        at < 0
          ? [...packs, pack]
          : packs.map((p, i) => (i === at ? pack : p));
      if (b.views[a.viewId]) b.focusedViewId = a.viewId;
      b.revision++;
      /* Importing a pack is a board content change, so it goes on the board
         history and can be undone like any other change. */
      store.recordEdit(a.boardId, {
        label: `导入组件包「${pack.name}」`,
        author: importedBy,
      });
      return {
        pack: {
          id: pack.id,
          name: pack.name,
          version: pack.version,
          componentCount: pack.components.length,
          source: pack.source,
          importedAt: pack.importedAt,
          author: pack.author,
        },
        replaced: at >= 0,
        warnings,
      };
    },
  );
  tool(
    "sand_remove_component_pack",
    "Remove an imported component pack from the board. Components already placed on the canvas stay where they are; only the toolbox presets go away.",
    {
      ...board,
      revision: z.number().int(),
      packId: id,
      author: z.string().min(1).max(100).default("human"),
    },
    (a) => {
      const b = store.get(a.boardId);
      if (b.revision !== a.revision)
        throw Error("Board changed. Read current board and retry.");
      const packs = b.componentPacks ?? [];
      const pack = packs.find((p) => p.id === a.packId);
      if (!pack) throw Error("这张白板上没有这个组件包。");
      b.componentPacks = packs.filter((p) => p.id !== a.packId);
      b.revision++;
      store.recordEdit(a.boardId, {
        label: `移除组件包「${pack.name}」`,
        author: a.author || "human",
      });
      return { removed: true, packId: a.packId };
    },
  );
  tool(
    "sand_export_component_pack",
    "Export an imported component pack as its manifest. The result can be imported again as it is, which is how a pack is shared.",
    { ...board, packId: id },
    (a) => {
      const b = store.get(a.boardId);
      const pack = (b.componentPacks ?? []).find((p) => p.id === a.packId);
      if (!pack) throw Error("这张白板上没有这个组件包。");
      return { packId: pack.id, manifest: packManifestOf(pack) };
    },
  );
  tool(
    "sand_list_component_packs",
    "List the component packs imported into the board with their presets. A pack is data: presets for component types that already exist.",
    { ...board },
    (a) => {
      const b = store.get(a.boardId);
      return {
        packs: (b.componentPacks ?? []).map((p) => ({
          id: p.id,
          name: p.name,
          version: p.version,
          description: p.description,
          author: p.author,
          source: p.source,
          importedAt: p.importedAt,
          componentCount: p.components.length,
          components: p.components.map((c) => ({
            key: c.key,
            type: c.type,
            title: c.title,
          })),
        })),
      };
    },
  );
}
