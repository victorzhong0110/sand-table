import { boardSummary, viewResult } from "../core/results.ts";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { BoardStore } from "../core/store.ts";
import type { BoardStateKey } from "../core/objects.ts";
import type { Board } from "../core/model.ts";
import type { ComponentInstance, Rect, View } from "../core/spaces.ts";
import {
  componentTypes,
  defaultData,
  safeUrl,
  isNativeContent,
  isReferenceContent,
  checkComponentData,
} from "../core/spaces.ts";
import { canNest } from "../core/content.ts";
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
/** 标题长度检查。原生对象的标题同样受约束。 */
function checkTitle(title: string) {
  if (!title || !title.trim() || title.length > 120)
    throw Error("Title must be 1–120 characters.");
}

/** 意图分组键：同一 intentId 的连续变更合为一个撤销单位。 */
const intentId = z.string().min(1).max(200).optional();
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
    icon: z.string().max(80).optional(),
    rect: rect.optional(),
    /** 意图分组键：同一 intentId 的连续编辑合为一个撤销单位。 */
    intentId: z.string().min(1).max(200).optional(),
  }),
  z.object({
    kind: z.literal("update"),
    instanceId: id,
    appearance: z
      .object({
        detail: z.enum(["full", "label", "icon"]).optional(),
      })
      .optional(),
    title: z.string().min(1).max(120).optional(),
    data: z.record(z.string(), z.unknown()).optional(),
    /** 期望的对象版本；不匹配时拒绝写入，不静默覆盖。 */
    expectedVersion: z.number().int().positive().optional(),
    intentId: z.string().min(1).max(200).optional(),
    /**
     * 客户端编辑时看到的基线数据。带上它，服务端才能只应用真正改动的字段，
     * 并对「同一字段被别人改过」报冲突（集成契约 D5）。
     */
    baseData: z.record(z.string(), z.unknown()).optional(),
    /** 同上：客户端看到的旧标题。标题冲突要能指出来。 */
    baseTitle: z.string().max(120).optional(),
  }),
  z.object({
    kind: z.literal("place"),
    items: z.array(z.object({ id, rect })).min(1).max(500),
    intentId,
  }),
  z.object({ kind: z.literal("duplicate"), instanceId: id, intentId }),
  z.object({ kind: z.literal("move"), instanceId: id, spaceId: id, intentId }),
  z.object({ kind: z.literal("remove"), instanceId: id, intentId }),
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
    intentId,
  }),
  z.object({ kind: z.literal("unlink"), linkId: id, intentId }),
  z.object({
    kind: z.literal("group"),
    ids: z.array(id).min(2).max(500),
    title: z.string().min(1).max(80),
    intentId,
  }),
  z.object({ kind: z.literal("theme"), theme: theme.nullable(), intentId }),
  z.object({
    kind: z.literal("present"),
    objectId: id,
    type: z.string().min(1).max(80).optional(),
    /** 放到哪块白板；不填表示当前白板。 */
    spaceId: id.optional(),
    intentId: z.string().min(1).max(200).optional(),
  }),
  z.object({
    kind: z.literal("copyObject"),
    instanceId: id,
    intentId: z.string().min(1).max(200).optional(),
  }),
  z.object({
    kind: z.literal("deleteObject"),
    objectId: id,
    onReferenced: z.enum(["refuse", "detach"]).optional(),
    intentId: z.string().min(1).max(200).optional(),
  }),
  z.object({
    kind: z.literal("relate"),
    source: id,
    target: id,
    relation: z.string().min(1).max(60),
    status: z.enum(["confirmed", "inferred"]).optional(),
    basis: z.string().max(1000).optional(),
    intentId: z.string().min(1).max(200).optional(),
  }),
  z.object({
    kind: z.literal("unlinkRelation"),
    relationId: id,
    intentId: z.string().min(1).max(200).optional(),
  }),

  z.object({ kind: z.literal("undo") }),
  z.object({ kind: z.literal("redo") }),
]);

/** 一次白板操作。op 的形状由 zod 校验，这里用同一份推导，避免 op 退化成 any。 */
export type Operation = z.infer<typeof operation>;

export class Spaces {
  store: BoardStore;
  constructor(store: BoardStore) {
    this.store = store;
  }
  update(
    boardId: string,
    revision: number,
    viewId: string,
    op: Operation,
    author = "human",
  ) {
    const b = this.store.get(boardId);
    if (b.revision !== revision)
      throw Error("Board changed. Read current board and retry.");
    if (op.kind === "undo" || op.kind === "redo")
      return op.kind === "undo"
        ? this.store.undo(boardId, author).board
        : this.store.redo(boardId, author).board;
    const v = openView(b, viewId);
    const item = (instanceId: string) => {
      const c = b.instances.find((c) => c.id === instanceId);
      if (!c) throw Error("Unknown component instance.");
      return c;
    };
    /* The label is read after the write, so "修改「X」" names the title the
       component has *now*. A removal takes the title with it, so that one is
       captured before. */
    const historyLabel = (removedTitle?: string): string | undefined => {
      switch (op.kind) {
        case "create":
          return `新建「${op.title}」`;
        case "update":
          return `修改「${item(op.instanceId).title}」`;
        case "place":
          return `移动 ${op.items.length} 个组件`;
        case "duplicate":
          return `复制「${item(op.instanceId).title}」`;
        case "move":
          return `移动「${item(op.instanceId).title}」`;
        case "remove":
          return `删除「${removedTitle}」`;
        case "link":
          return "建立关系";
        case "unlink":
          return "删除关系";
        case "group":
          return `分组「${op.title}」`;
        case "theme":
          return "切换外观";
        default:
          return undefined;
      }
    };
    const removedTitle =
      op.kind === "remove" ? item(op.instanceId).title : undefined;
    /* 一次操作里的多处变更合为一个撤销单位：同一次拖动改了三个卡片，
       撤销时应当一起回去，而不是分三步。 */
    const intentKey =
      "intentId" in op && typeof op.intentId === "string"
        ? op.intentId
        : randomUUID();
    /* 作者就是 Agent 时，历史记录要标成 agent：面板上人做的和 Agent 做的要分得开。 */
    const authorKind: "human" | "agent" =
      author === "agent" ? "agent" : "human";
    /** 记录展示实例的变化：只记录真正变了的（值为 null 表示该侧不存在）。 */
    const recordInstances = (
      ids: string[],
      before: Map<string, ComponentInstance | null>,
      kind: string,
      label: string,
    ) => {
      const changes = ids
        .map((id) => {
          const was = before.get(id) ?? null;
          const now = b.instances.find((i) => i.id === id) ?? null;
          if (was && now && JSON.stringify(was) === JSON.stringify(now))
            return null;
          return { id, before: was, after: now };
        })
        .filter(
          (
            c,
          ): c is {
            id: string;
            before: ComponentInstance | null;
            after: ComponentInstance | null;
          } => c !== null,
        );
      if (changes.length)
        this.store.recordPresentations(
          b,
          changes,
          author,
          intentKey,
          kind,
          label,
        );
    };
    /** 记录板级内容的变化（嵌套白板、关系、分组、布局锚点、主题、组件包）。 */
    const recordBoard = (
      key: BoardStateKey,
      before: unknown,
      kind: string,
      label: string,
    ) => {
      const after = (b as unknown as Record<string, unknown>)[key];
      if (JSON.stringify(before) === JSON.stringify(after)) return;
      this.store.recordBoardState(
        b,
        key,
        before,
        after,
        author,
        intentKey,
        kind,
        label,
      );
    };
    /** 外观只改显示档位：类型图标在创建时定下，之后不能改（#5 的决定）。 */
    const applyAppearance = (c: ComponentInstance) => {
      if (!("appearance" in op) || !op.appearance) return;
      const next = { ...c.appearance };
      if (op.appearance.detail) next.detail = op.appearance.detail;
      c.appearance = next;
    };
    const snapshotOf = (id: string) => {
      const c = b.instances.find((i) => i.id === id);
      return c ? structuredClone(c) : null;
    };
    const validSpace = (spaceId: string) => {
      if (!b.spaces.some((s) => s.id === spaceId))
        throw Error("Unknown whiteboard.");
    };
    // 白板嵌套无环（I4）：判定收敛到 core/content.ts 的 canNest，别在接线层再写一份。
    // ancestor(target, destination)：target 是 destination 的祖先时，移动会形成环。
    const ancestor = (target: string, destination: string): boolean =>
      !canNest(b.spaces, destination, target);
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
      // 建白板会多出一块嵌套白板：板级内容也要记进撤销栈。
      const spacesBefore = structuredClone(b.spaces);
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
      checkComponentData(type, data);
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
      // 原生内容：内容进入对象，实例只负责呈现与布局。
      // 同一个对象可以再放到别的白板上，改内容会同时更新所有展示。
      let binding: { kind: "object"; objectId: string } | undefined;
      if (isNativeContent(type)) {
        const object = this.store.createContent(
          b,
          { type, title: op.title, data },
          author,
          intentKey,
          authorKind,
        );
        binding = { kind: "object", objectId: object.id };
        data = {};
      } else if (isReferenceContent(type)) {
        const object = this.store.createContent(
          b,
          {
            type,
            title: op.title,
            data,
            kind: "reference",
            source: {
              origin: "human",
              author,
              external: {
                kind: "url",
                uri: String(data.url || ""),
              },
            },
          },
          author,
          intentKey,
          authorKind,
        );
        binding = { kind: "object", objectId: object.id };
        data = {};
      }
      b.instances.push({
        id: randomUUID(),
        spaceId: v.spaceId,
        type,
        objectId: binding?.objectId || op.objectId,
        ...(binding ? { binding } : {}),
        ...(op.icon && !componentTypes.some((c) => c.type === type)
          ? { appearance: { icon: op.icon } }
          : {}),
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
      const createdIds = [created.id];
      v.selection = [created.id];
      b.selection = binding
        ? [binding.objectId]
        : op.objectId
          ? [op.objectId]
          : [];
      definitions.forEach(([type, title], index) => {
        const size = componentTypes.find((t) => t.type === type)!;
        // 预设里的原生内容同样是一等对象：内容进对象，实例只管位置。
        const content =
          isNativeContent(type) || isReferenceContent(type)
            ? this.store.createContent(
                b,
                { type, title, data: defaultData(type) },
                "preset",
                intentKey,
                authorKind,
              )
            : undefined;
        b.instances.push({
          id: randomUUID(),
          spaceId: String(data.spaceId),
          type,
          title,
          data: content ? {} : defaultData(type),
          ...(content
            ? { binding: { kind: "object", objectId: content.id } }
            : {}),
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
        createdIds.push(b.instances[b.instances.length - 1].id);
      });
      recordInstances(
        createdIds,
        new Map(createdIds.map((id) => [id, null])),
        "create-presentation",
        `新建「${op.title}」`,
      );
      recordBoard(
        "spaces",
        spacesBefore,
        "create-board",
        `新建「${op.title}」`,
      );
    }
    if (op.kind === "update") {
      const c = item(op.instanceId);
      // 绑定了内容对象的组件：编辑改的是对象，不是这一张卡。
      // 同一个对象在别处的展示会同步更新（内容共享、布局独立）。
      const bound =
        c.binding?.kind === "object" ? c.binding.objectId : undefined;
      if (bound) {
        const object = b.contentObjects.find((o) => o.id === bound);
        if (!object) throw Error("这份内容已被删除；请重新选择或重新创建。");
        if (op.title !== undefined && op.title !== object.title)
          checkTitle(op.title);
        if (op.data) {
          if (c.type === "board" || c.type === "object")
            throw Error(
              "Use reference/whiteboard actions to change the target.",
            );
        }
        // 版本对得上：直接整份写入，没有并发，不用做字段级合并。
        // 版本对不上：只有带了基线（baseData/baseTitle）才能安全地只写真正改动的字段——
        // 否则别人改过的内容会被这次写入悄悄抹掉。
        const versionMatches =
          op.expectedVersion === undefined ||
          op.expectedVersion === object.version;
        let nextData = op.data;
        if (op.data && op.baseData) {
          const current = object.data || {};
          const changed: Record<string, unknown> = {};
          const keys = new Set([
            ...Object.keys(op.baseData),
            ...Object.keys(op.data),
          ]);
          for (const key of keys) {
            const was = op.baseData[key];
            const now = op.data![key];
            if (JSON.stringify(was) === JSON.stringify(now)) continue;
            // 这个字段我改了，但当前值已经不是我的基线：有人同时改了同一个字段。
            if (JSON.stringify(current[key]) !== JSON.stringify(was))
              throw Error(`字段「${key}」已被其他修改改动，请重新载入后再试。`);
            changed[key] = now;
          }
          nextData = { ...current, ...changed };
        } else if (!versionMatches) {
          throw Error(
            "过期版本写入被拒绝：内容已被其他修改改动，请重新载入后再试。",
          );
        }
        if (op.title !== undefined && op.baseTitle !== undefined) {
          if (op.baseTitle !== object.title)
            throw Error("标题已被其他修改改动，请重新载入后再试。");
        } else if (op.title !== undefined && !versionMatches) {
          throw Error(
            "过期版本写入被拒绝：标题已被其他修改改动，请重新载入后再试。",
          );
        }
        if (nextData) checkComponentData(c.type, nextData);
        // 标题与内容属于对象；外观属于这一次展示。
        // 两者要分开落地：外观被内容分支吞掉的话，绑定了对象的卡片就没法改显示方式。
        if (op.title !== undefined || nextData) {
          this.store.updateContent(
            b,
            bound,
            {
              ...(op.title !== undefined ? { title: op.title } : {}),
              ...(nextData ? { data: nextData } : {}),
            },
            op.expectedVersion ?? object.version,
            author,
            intentKey,
            authorKind,
          );
        }
        applyAppearance(c);
        c.updatedAt = Date.now();
        c.author = author;
      } else {
        if (op.title !== undefined) {
          c.title = op.title;
          if (c.type === "board") {
            const s = b.spaces.find((s) => s.id === c.data.spaceId);
            if (s) s.title = op.title;
          }
        }
        if (op.data) {
          if (c.type === "board" || c.type === "object")
            throw Error(
              "Use reference/whiteboard actions to change the target.",
            );
          checkComponentData(c.type, op.data);
          if (c.type === "space-link") validSpace(String(op.data.spaceId));
          c.data = structuredClone(op.data);
        }
        applyAppearance(c);
        c.updatedAt = Date.now();
        c.author = author;
      }
    }
    if (op.kind === "place") {
      const placeBefore = new Map<string, ComponentInstance | null>();
      for (const change of op.items)
        placeBefore.set(change.id, snapshotOf(change.id));
      const placementsBefore = structuredClone(b.placements);
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
      // op 是参数：类型收窄不会带进回调里，先取成 const 再用。
      const placeItems = op.items;
      const placeIds = placeItems.map((change) => change.id);
      recordInstances(
        placeIds,
        placeBefore,
        "move",
        `移动 ${op.items.length} 个组件`,
      );
      recordBoard("placements", placementsBefore, "move", "移动布局锚点");
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
      recordInstances(
        [copy.id],
        new Map([[copy.id, null]]),
        "duplicate",
        `复制「${c.title}」`,
      );
    }
    if (op.kind === "move") {
      const c = item(op.instanceId);
      const moveBefore = snapshotOf(c.id);
      const spacesBefore = structuredClone(b.spaces);
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
      recordInstances(
        [c.id],
        new Map([[c.id, moveBefore]]),
        "move",
        `移动「${c.title}」`,
      );
      recordBoard("spaces", spacesBefore, "move", "调整白板层级");
    }
    if (op.kind === "remove") {
      const c = item(op.instanceId);
      const removeBefore = snapshotOf(c.id);
      const spacesBefore = structuredClone(b.spaces);
      const linksBefore = structuredClone(b.spaceLinks);
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
      recordInstances(
        [c.id],
        new Map([[c.id, removeBefore]]),
        "delete-presentation",
        `删除「${removedTitle ?? c.title}」`,
      );
      recordBoard("spaces", spacesBefore, "delete-presentation", "删除白板");
      recordBoard("spaceLinks", linksBefore, "delete-presentation", "删除关系");
    }
    if (op.kind === "link") {
      const linksBefore = structuredClone(b.spaceLinks);
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
      recordBoard("spaceLinks", linksBefore, "create-relation", "建立关系");
    }
    if (op.kind === "unlink") {
      const linksBefore = structuredClone(b.spaceLinks);
      b.spaceLinks = b.spaceLinks.filter((l) => l.id !== op.linkId);
      recordBoard("spaceLinks", linksBefore, "delete-relation", "删除关系");
    }
    if (op.kind === "group") {
      const groupsBefore = structuredClone(b.groups);
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
      recordBoard("groups", groupsBefore, "group", `分组「${op.title}」`);
    }
    if (op.kind === "theme") {
      const themeBefore = structuredClone(b.theme);
      b.theme = op.theme;
      recordBoard("theme", themeBefore, "theme", "切换外观");
    }
    if (op.kind === "present") {
      // 再放一份展示：同一个对象在指定（或当前）白板新增一个展示实例。
      // 内容共享、布局独立；这与「复制出独立对象」是两件事。
      const object = b.contentObjects.find((o) => o.id === op.objectId);
      if (!object) throw Error("Unknown content object.");
      if (b.instances.length >= 2200) throw Error("Component limit reached.");
      const target = op.spaceId ? String(op.spaceId) : v.spaceId;
      validSpace(target);
      const type = op.type || object.type;
      const config = componentTypes.find((c) => c.type === type);
      const index = b.instances.filter((c) => c.spaceId === target).length;
      const instance = {
        id: randomUUID(),
        spaceId: target,
        type,
        objectId: object.id,
        binding: { kind: "object" as const, objectId: object.id },
        title: object.title,
        data: {},
        rect: {
          x: (index % 3) * 300,
          y: Math.floor(index / 3) * 180,
          width: config?.width || 280,
          height: config?.height || 180,
          pinned: false,
        },
        updatedAt: Date.now(),
        author,
      };
      b.instances.push(instance);
      v.selection = [instance.id];
      recordInstances(
        [instance.id],
        new Map([[instance.id, null]]),
        "create-presentation",
        `再放一份「${object.title}」`,
      );
    }
    if (op.kind === "copyObject") {
      // 复制出独立对象：内容深拷贝、新 ID，与「再放一份展示」不同。
      const c = item(op.instanceId);
      const bound =
        c.binding?.kind === "object" ? c.binding.objectId : undefined;
      if (!bound) throw Error("This component has no independent content.");
      if (b.instances.length >= 2200) throw Error("Component limit reached.");
      const clone = this.store.cloneContent(
        b,
        bound,
        author,
        intentKey,
        authorKind,
      );
      const config = componentTypes.find((t) => t.type === c.type);
      const index = b.instances.filter((x) => x.spaceId === v.spaceId).length;
      const instance = {
        id: randomUUID(),
        spaceId: v.spaceId,
        type: c.type,
        objectId: clone.id,
        binding: { kind: "object" as const, objectId: clone.id },
        title: clone.title,
        data: {},
        rect: {
          x: (index % 3) * 300,
          y: Math.floor(index / 3) * 180,
          width: config?.width || 280,
          height: config?.height || 180,
          pinned: false,
        },
        updatedAt: Date.now(),
        author,
      };
      b.instances.push(instance);
      v.selection = [instance.id];
      recordInstances(
        [instance.id],
        new Map([[instance.id, null]]),
        "create-presentation",
        `复制出独立对象「${clone.title}」`,
      );
    }
    if (op.kind === "deleteObject") {
      // 删除对象与移除展示是两回事。仍被引用时默认拒绝。
      this.store.deleteContent(
        b,
        op.objectId,
        op.onReferenced || "refuse",
        author,
        intentKey,
        authorKind,
      );
    }
    if (op.kind === "relate") {
      // 语义关系：对象之间的语义，与布局无关，也不因位置相近自动建立。
      const known = (oid: string) =>
        b.contentObjects.some((o) => o.id === oid) ||
        b.objects.some((o) => o.id === oid);
      if (!known(op.source) || !known(op.target))
        throw Error("Unknown object in relation.");
      if (op.source === op.target)
        throw Error("An object cannot relate to itself.");
      this.store.relateContent(
        b,
        {
          source: op.source,
          target: op.target,
          kind: op.relation,
          ...(op.status ? { status: op.status } : {}),
          ...(op.basis ? { basis: op.basis } : {}),
        },
        author,
        intentKey,
      );
    }
    if (op.kind === "unlinkRelation")
      this.store.unlinkContent(b, op.relationId, author, intentKey, authorKind);

    b.focusedViewId = viewId;
    v.updatedAt = Date.now();
    b.revision++;
    return this.store.read(boardId);
  }
  /** Board-level undo. It pushes a new reversible record instead of
   * popping a stack, so an undo can itself be undone. */
  undo(boardId: string, revision: number | undefined, author = "human") {
    const b = this.store.get(boardId);
    if (revision !== undefined && b.revision !== revision)
      throw Error("Board changed. Read current board and retry.");
    return this.store.undo(boardId, author).board;
  }
  redo(boardId: string, revision: number | undefined, author = "human") {
    const b = this.store.get(boardId);
    if (revision !== undefined && b.revision !== revision)
      throw Error("Board changed. Read current board and retry.");
    return this.store.redo(boardId, author).board;
  }
  history(boardId: string) {
    return this.store.history(boardId);
  }
  undoTo(
    boardId: string,
    revision: number | undefined,
    recordId: string,
    author = "human",
  ) {
    const b = this.store.get(boardId);
    if (revision !== undefined && b.revision !== revision)
      throw Error("Board changed. Read current board and retry.");
    return this.store.jumpTo(boardId, recordId, author).board;
  }
}
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
    "sand_report_space_activity",
    "Report actual last-known Agent work in a whiteboard space without requiring a code workspace. This is an Agent self-report, not live process observation.",
    {
      ...board,
      agentId: id,
      spaceId: id,
      instanceIds: z.array(id).max(30),
      task: z.string().min(1).max(1000),
      action: z.string().min(1).max(300),
      state: z.enum(["running", "waiting", "done", "unknown"]),
    },
    (a) => {
      const b = spaces.store.get(a.boardId);
      if (
        !b.spaces.some((s) => s.id === a.spaceId) ||
        a.instanceIds.some(
          (id) =>
            !b.instances.some((i) => i.id === id && i.spaceId === a.spaceId),
        )
      )
        throw Error("Activity must match actual space and instance IDs.");
      b.spaceActivities = (b.spaceActivities || []).filter(
        (r) => r.agentId !== a.agentId,
      );
      if (b.spaceActivities.length >= 24)
        throw Error("Agent report limit reached.");
      b.spaceActivities.push({
        agentId: a.agentId,
        spaceId: a.spaceId,
        instanceIds: a.instanceIds,
        task: a.task,
        action: a.action,
        state: a.state,
        reportedAt: Date.now(),
      });
      b.revision++;
      return spaces.store.read(b.id);
    },
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
    "Arrange/configure components only when requested. Does not edit code, change source ownership or grant write permission; pinned components and containment cycles are checked. The result names the instances it created or changed, so you can read them back with sand_find_objects (instances) or sand_read_spaces without guessing.",
    {
      ...board,
      revision: z.number().int(),
      viewId: id,
      author: z.string().max(100).default("agent"),
      operation,
    },
    (a) => {
      const operation = a.operation;
      const before = new Set(
        spaces.store.get(a.boardId).instances.map((i) => i.id),
      );
      const result = spaces.update(
        a.boardId,
        a.revision,
        a.viewId,
        operation,
        a.author,
      );
      const created = result.instances.filter((i) => !before.has(i.id));
      const changed =
        operation.kind === "update"
          ? result.instances.find((i) => i.id === operation.instanceId)
          : undefined;
      return viewResult(
        {
          ...boardSummary(result),
          createdInstances: created.map((i) => ({
            id: i.id,
            title: i.title,
            type: i.type,
            spaceId: i.spaceId,
          })),
          ...(changed
            ? {
                changedInstance: {
                  id: changed.id,
                  title: changed.title,
                  type: changed.type,
                  spaceId: changed.spaceId,
                },
              }
            : {}),
        },
        result,
      );
    },
  );
  tool(
    "sand_history",
    "The board's reversible history: what can be undone, what can be redone, and one readable record per step. Edits are grouped by intent (one continuous typing or one drag is one step); external effects (published changes, executed tasks) are never on it. Scope is board content only — intents, proposals and files are never reverted.",
    { ...board },
    (a) => spaces.history(a.boardId),
  );
  tool(
    "sand_undo",
    "Undo the last user intent on this board. Edits are grouped by intent, so one continuous typing or one drag goes back in one step. Omit revision to act on the server's current board.",
    {
      ...board,
      revision: z.number().int().optional(),
      author: z.string().max(100).default("agent"),
    },
    (a) => spaces.undo(a.boardId, a.revision, a.author),
  );
  tool(
    "sand_redo",
    "Redo the last undone user intent on this board.",
    {
      ...board,
      revision: z.number().int().optional(),
      author: z.string().max(100).default("agent"),
    },
    (a) => spaces.redo(a.boardId, a.revision, a.author),
  );
  tool(
    "sand_undo_to",
    "Jump the board to a recorded history step: the board returns to the content that step produced. Pass a recordId from sand_history.",
    {
      ...board,
      revision: z.number().int().optional(),
      recordId: id,
      author: z.string().max(100).default("agent"),
    },
    (a) => spaces.undoTo(a.boardId, a.revision, a.recordId, a.author),
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
