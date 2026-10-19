import { viewResult } from "../core/results.ts";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { BoardStore } from "../core/store.ts";
import type { Board } from "../core/model.ts";
import type { ComponentInstance, Rect, View } from "../core/spaces.ts";
import { componentTypes, defaultData, safeUrl } from "../core/spaces.ts";
import { openView } from "../core/space-state.ts";
import type { RegisterTool } from "./tool-types.ts";
const id = z.string().min(1).max(500),
  board = { boardId: id };
const rect = z.object({
  x: z.number().min(-100000).max(100000),
  y: z.number().min(-100000).max(100000),
  width: z.number().min(120).max(2000),
  height: z.number().min(70).max(1600),
  pinned: z.boolean(),
});
const theme = z.object({
  base: z.enum(["paper", "mono"]),
  background: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  surface: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  ink: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  muted: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  line: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  font: z.enum(["system", "serif", "mono"]),
  density: z.enum(["comfortable", "compact"]),
  radius: z.number().min(0).max(24),
  reduceMotion: z.boolean(),
});
function checkData(type: string, data: Record<string, unknown>) {
  if (JSON.stringify(data).length > 40000)
    throw Error("Component data exceeds 40 KB.");
  if (data.url && !safeUrl(data.url))
    throw Error("Resource URL must use HTTP(S).");
  if (data.sourceUrl && !safeUrl(data.sourceUrl))
    throw Error("Source URL must use HTTP(S).");
  if (type === "chart") {
    const p = data.points;
    if (
      !Array.isArray(p) ||
      p.length > 100 ||
      p.some(
        (v: any) =>
          !v ||
          typeof v.label !== "string" ||
          v.label.length > 100 ||
          !Number.isFinite(v.value),
      )
    )
      throw Error("Chart needs up to 100 finite labeled values.");
  }
  if (type === "table") {
    if (
      !Array.isArray(data.columns) ||
      data.columns.length > 20 ||
      data.columns.some((v) => typeof v !== "string") ||
      !Array.isArray(data.rows) ||
      data.rows.length > 200 ||
      data.rows.some(
        (row) =>
          !Array.isArray(row) ||
          row.length !== (data.columns as unknown[]).length ||
          row.some(
            (v) =>
              !["string", "number", "boolean"].includes(typeof v) && v !== null,
          ),
      )
    )
      throw Error("Table dimensions or values are invalid.");
  }
  if (
    type === "task" &&
    (!Array.isArray(data.items) ||
      data.items.length > 100 ||
      data.items.some(
        (v: any) => typeof v?.text !== "string" || typeof v.done !== "boolean",
      ))
  )
    throw Error("Checklist values are invalid.");
  if (
    type === "events" &&
    (!Array.isArray(data.events) || data.events.length > 100)
  )
    throw Error("At most 100 current events.");
}
export class Spaces {
  store: BoardStore;
  constructor(store: BoardStore) {
    this.store = store;
  }
  update(
    boardId: string,
    revision: number,
    viewId: string,
    op: any,
    author = "human",
  ) {
    const b = this.store.get(boardId);
    if (b.revision !== revision)
      throw Error("Board changed. Read current board and retry.");
    const v = openView(b, viewId);
    const item = (instanceId: string) => {
      const c = b.instances.find((c) => c.id === instanceId);
      if (!c) throw Error("Unknown component instance.");
      return c;
    };
    const validSpace = (spaceId: string) => {
      if (!b.spaces.some((s) => s.id === spaceId))
        throw Error("Unknown whiteboard.");
    };
    const ancestor = (parent: string, child: string): boolean => {
      let cursor = b.spaces.find((s) => s.id === child);
      let count = 0;
      while (cursor && count++ < 20) {
        if (cursor.id === parent) return true;
        cursor = b.spaces.find((s) => s.id === cursor!.parentId);
      }
      return false;
    };
    if (op.kind === "select") {
      if (op.ids.some((id: string) => item(id).spaceId !== v.spaceId))
        throw Error("Selection must be in the current view.");
      v.selection = [...new Set<string>(op.ids)];
      b.selection = [
        ...new Set(
          v.selection
            .map((id) => item(id).objectId)
            .filter((id): id is string =>
              Boolean(id && b.objects.some((o) => o.id === id)),
            ),
        ),
      ];
      if (!op.keepGuide) delete b.guideFocus;
    }
    if (op.kind === "camera") v.camera = op.camera;
    if (op.kind === "navigate") {
      validSpace(op.spaceId);
      v.spaceId = op.spaceId;
      v.selection = [];
      v.camera = { x: 24, y: 24, zoom: 1 };
      b.selection = [];
      delete b.guideFocus;
    }
    if (op.kind === "create") {
      if (b.instances.length >= 2200) throw Error("Component limit reached.");
      const type = op.type;
      const preset = type === "board" ? op.data?.preset : undefined;
      const definitions =
        preset === "bug"
          ? [
              ["task", "目标与验收条件"],
              ["reasoning", "行为约定与未知项"],
              ["intent", "修改意图"],
              ["proposal", "具体目标版本"],
              ["validation", "测试与核对"],
              ["resource", "复现材料"],
            ]
          : preset === "research"
            ? [
                ["comparison", "两次实验的比较"],
                ["chart", "实验指标"],
                ["metric", "当前关注指标"],
                ["reasoning", "证据与未知项"],
                ["task", "下一步检查"],
              ]
            : [];
      if (b.instances.length + 1 + definitions.length > 2200)
        throw Error("Component limit reached.");
      let data = op.data ?? defaultData(type);
      checkData(type, data);
      if (op.objectId && !b.objects.some((o) => o.id === op.objectId))
        throw Error("Unknown object.");
      if (type === "board") {
        if (b.spaces.length >= 80) throw Error("Whiteboard limit reached.");
        const spaceId = randomUUID();
        b.spaces.push({ id: spaceId, title: op.title, parentId: v.spaceId });
        data = { spaceId };
      }
      if (type === "space-link") {
        validSpace(String(data.spaceId));
      }
      const config = componentTypes.find((c) => c.type === type);
      const width = config?.width || 280,
        height = config?.height || 180;
      let spawnX = -v.camera.x / v.camera.zoom + 30,
        spawnY = -v.camera.y / v.camera.zoom + 40;
      if (!op.rect) {
        for (let slot = 0; slot < 2300; slot++) {
          const x = -v.camera.x / v.camera.zoom + 30 + (slot % 3) * 380;
          const y =
            -v.camera.y / v.camera.zoom + 40 + Math.floor(slot / 3) * 270;
          if (
            !b.instances.some(
              (c) =>
                c.spaceId === v.spaceId &&
                x < c.rect.x + c.rect.width + 16 &&
                x + width + 16 > c.rect.x &&
                y < c.rect.y + c.rect.height + 16 &&
                y + height + 16 > c.rect.y,
            )
          ) {
            spawnX = x;
            spawnY = y;
            break;
          }
        }
      }
      b.instances.push({
        id: randomUUID(),
        spaceId: v.spaceId,
        type,
        objectId: op.objectId,
        title: op.title,
        data: structuredClone(data),
        rect: op.rect || {
          x: spawnX,
          y: spawnY,
          width: config?.width || 280,
          height: config?.height || 180,
          pinned: false,
        },
        updatedAt: Date.now(),
        author,
      });
      const created = b.instances[b.instances.length - 1];
      v.selection = [created.id];
      b.selection = op.objectId ? [op.objectId] : [];
      definitions.forEach(([type, title], index) => {
        const size = componentTypes.find((t) => t.type === type)!;
        b.instances.push({
          id: randomUUID(),
          spaceId: String(data.spaceId),
          type,
          title,
          data: defaultData(type),
          rect: {
            x: (index % 2) * 380,
            y: Math.floor(index / 2) * 270,
            width: size.width,
            height: size.height,
            pinned: false,
          },
          author: "preset",
          updatedAt: Date.now(),
        });
      });
    }
    if (op.kind === "update") {
      const c = item(op.instanceId);
      if (op.title !== undefined) {
        c.title = op.title;
        if (c.type === "board") {
          const s = b.spaces.find((s) => s.id === c.data.spaceId);
          if (s) s.title = op.title;
        }
      }
      if (op.data) {
        if (c.type === "board" || c.type === "object")
          throw Error("Use reference/whiteboard actions to change the target.");
        checkData(c.type, op.data);
        if (c.type === "space-link") validSpace(String(op.data.spaceId));
        c.data = structuredClone(op.data);
      }
      c.updatedAt = Date.now();
      c.author = author;
    }
    if (op.kind === "place") {
      for (const change of op.items) {
        const c = item(change.id),
          r = change.rect;
        if (c.rect.pinned && (c.rect.x !== r.x || c.rect.y !== r.y))
          throw Error("Unpin before moving.");
      }
      for (const change of op.items) {
        const c = item(change.id);
        c.rect = { ...change.rect };
        c.updatedAt = Date.now();
        if (c.id === `ref:${c.objectId}` && c.objectId)
          b.placements[c.objectId] = {
            x: c.rect.x,
            y: c.rect.y,
            pinned: c.rect.pinned,
          };
      }
    }
    if (op.kind === "duplicate") {
      const c = item(op.instanceId);
      if (b.instances.length >= 2200) throw Error("Component limit reached.");
      const copy = structuredClone(c);
      copy.id = randomUUID();
      copy.rect = {
        ...copy.rect,
        x: copy.rect.x + 40,
        y: copy.rect.y + 40,
        pinned: false,
      };
      if (copy.type === "board") copy.type = "space-link";
      copy.updatedAt = Date.now();
      copy.author = author;
      b.instances.push(copy);
    }
    if (op.kind === "move") {
      const c = item(op.instanceId);
      validSpace(op.spaceId);
      if (c.rect.pinned)
        throw Error("Unpin before moving to another whiteboard.");
      if (c.type === "board") {
        const target = String(c.data.spaceId);
        if (ancestor(target, op.spaceId))
          throw Error("Whiteboard containment cycle.");
        const s = b.spaces.find((s) => s.id === target)!;
        s.parentId = op.spaceId;
      }
      c.spaceId = op.spaceId;
      c.rect = { ...c.rect, x: 24, y: 24 };
      v.selection = v.selection.filter((id) => id !== c.id);
    }
    if (op.kind === "remove") {
      const c = item(op.instanceId);
      if (
        c.type === "board" &&
        b.instances.some((i) => i.spaceId === c.data.spaceId)
      )
        throw Error(
          "Whiteboard contains components. Move or remove them first.",
        );
      b.instances = b.instances.filter((i) => i.id !== c.id);
      b.spaceLinks = b.spaceLinks.filter(
        (l) => l.source !== c.id && l.target !== c.id,
      );
      for (const view of Object.values(b.views))
        view.selection = view.selection.filter((id) => id !== c.id);
      if (c.type === "board") {
        const target = String(c.data.spaceId);
        b.spaces = b.spaces.filter((s) => s.id !== target);
        for (const view of Object.values(b.views))
          if (view.spaceId === target) {
            view.spaceId = "overview";
            view.selection = [];
          } /* existing navigation references remain visibly unresolved */
      }
    }
    if (op.kind === "link") {
      const source = item(op.source),
        target = item(op.target);
      if (source.spaceId !== target.spaceId)
        throw Error("Link instances in the same whiteboard.");
      if (b.spaceLinks.length >= 500) throw Error("Relation limit reached.");
      b.spaceLinks.push({
        id: randomUUID(),
        source: source.id,
        target: target.id,
        kind: op.relation,
        description: op.description,
        author,
      });
    }
    if (op.kind === "unlink")
      b.spaceLinks = b.spaceLinks.filter((l) => l.id !== op.linkId);
    if (op.kind === "group") {
      const ids: string[] = [...new Set<string>(op.ids)];
      if (ids.length < 2) throw Error("Select two or more components.");
      if (ids.some((id) => item(id).spaceId !== v.spaceId))
        throw Error("Group stays within a whiteboard.");
      b.groups.push({
        id: randomUUID(),
        title: op.title,
        instanceIds: ids,
        objectIds: [
          ...new Set(
            ids
              .map((id) => item(id).objectId)
              .filter((id): id is string => Boolean(id)),
          ),
        ],
      });
    }
    if (op.kind === "theme") b.theme = op.theme;
    b.focusedViewId = viewId;
    v.updatedAt = Date.now();
    b.revision++;
    return this.store.read(boardId);
  }
}
const operation = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("select"),
    ids: z.array(id).max(2200),
    keepGuide: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("camera"),
    camera: z.object({
      x: z.number().min(-100000).max(100000),
      y: z.number().min(-100000).max(100000),
      zoom: z.number().min(0.05).max(3),
    }),
  }),
  z.object({ kind: z.literal("navigate"), spaceId: id }),
  z.object({
    kind: z.literal("create"),
    type: z.string().min(1).max(80),
    title: z.string().min(1).max(120),
    data: z.record(z.string(), z.unknown()).optional(),
    objectId: id.optional(),
    rect: rect.optional(),
  }),
  z.object({
    kind: z.literal("update"),
    instanceId: id,
    title: z.string().min(1).max(120).optional(),
    data: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    kind: z.literal("place"),
    items: z.array(z.object({ id, rect })).min(1).max(500),
  }),
  z.object({ kind: z.literal("duplicate"), instanceId: id }),
  z.object({ kind: z.literal("move"), instanceId: id, spaceId: id }),
  z.object({ kind: z.literal("remove"), instanceId: id }),
  z.object({
    kind: z.literal("link"),
    source: id,
    target: id,
    relation: z.enum([
      "related",
      "depends-on",
      "supports",
      "compares",
      "belongs-to",
    ]),
    description: z.string().max(1000),
  }),
  z.object({ kind: z.literal("unlink"), linkId: id }),
  z.object({
    kind: z.literal("group"),
    ids: z.array(id).min(2).max(500),
    title: z.string().min(1).max(80),
  }),
  z.object({ kind: z.literal("theme"), theme: theme.nullable() }),
]);
export function registerSpaceTools(tool: RegisterTool, spaces: Spaces) {
  tool(
    "sand_read_asset",
    "Read a small user-supplied asset for rendering in the App.",
    { ...board, assetId: id },
    (a) => {
      const asset = spaces.store
        .get(a.boardId)
        .assets.find((v) => v.id === a.assetId);
      if (!asset) throw Error("Unknown asset");
      return viewResult(
        { id: asset.id, mime: asset.mime, bytes: asset.bytes },
        asset,
      );
    },
    true,
  );
  tool(
    "sand_open_view",
    "Open an ephemeral independent view of the shared board.",
    { ...board, viewId: id },
    (a) => {
      const b = spaces.store.get(a.boardId);
      openView(b, a.viewId);
      return spaces.store.read(b.id);
    },
    true,
  );
  tool(
    "sand_read_component",
    "Read one component configuration by instance ID. Unknown types remain data; no component code is executed.",
    { ...board, instanceId: id },
    (a) => {
      const b = spaces.store.get(a.boardId),
        instance = b.instances.find((i) => i.id === a.instanceId);
      if (!instance) throw Error("Unknown component instance.");
      return { boardId: b.id, revision: b.revision, instance };
    },
  );
  tool(
    "sand_read_spaces",
    "Read nested whiteboards, instance identities and current views. Source objects are shared; each instance has independent layout.",
    {
      ...board,
      spaceId: id.optional(),
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(50).default(30),
    },
    (a) => {
      const b = spaces.store.get(a.boardId),
        items = b.instances.filter(
          (i) => !a.spaceId || i.spaceId === a.spaceId,
        );
      return {
        boardId: b.id,
        revision: b.revision,
        spaces: b.spaces,
        focusedViewId: b.focusedViewId,
        views: b.views,
        instances: items.slice(a.offset, a.offset + a.limit).map((i) => ({
          ...i,
          data:
            JSON.stringify(i.data).length > 4000
              ? {
                  omitted: true,
                  instruction: "Use sand_read_component for complete data.",
                }
              : i.data,
        })),
        total: items.length,
        nextOffset:
          a.offset + a.limit < items.length ? a.offset + a.limit : null,
        componentTypes,
      };
    },
  );
  tool(
    "sand_edit_space",
    "Arrange/configure components only when requested. Does not edit code, change source ownership or grant write permission; pinned components and containment cycles are checked.",
    {
      ...board,
      revision: z.number().int(),
      viewId: id,
      author: z.string().max(100).default("agent"),
      operation,
    },
    (a) =>
      spaces.update(a.boardId, a.revision, a.viewId, a.operation, a.author),
  );
  tool(
    "sand_attach_asset",
    "Attach a small image/audio/video supplied by the user to this ephemeral board; no repository read/write.",
    {
      ...board,
      name: z.string().max(120),
      mime: z.enum([
        "image/png",
        "image/jpeg",
        "image/webp",
        "image/gif",
        "audio/mpeg",
        "audio/ogg",
        "video/mp4",
        "video/webm",
      ]),
      base64: z.string().max(2_800_000),
    },
    (a) => {
      const b = spaces.store.get(a.boardId);
      const bytes = Buffer.from(a.base64, "base64").length;
      if (
        bytes > 2_000_000 ||
        b.assets.reduce((n, a) => n + a.bytes, 0) + bytes > 12_000_000
      )
        throw Error("Asset limit: 2 MB each, 12 MB per board.");
      const asset = {
        id: randomUUID(),
        name: a.name,
        mime: a.mime,
        dataUrl: `data:${a.mime};base64,${a.base64}`,
        bytes,
      };
      b.assets.push(asset);
      b.revision++;
      return { id: asset.id, name: asset.name, mime: asset.mime, bytes };
    },
    true,
  );
}
