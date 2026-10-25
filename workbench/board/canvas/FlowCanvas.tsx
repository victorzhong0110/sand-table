import "@xyflow/react/dist/style.css";
import {
  ConnectionMode,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type NodeChange,
  type Viewport as FlowViewport,
} from "@xyflow/react";
import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { blocksCanvasShortcut } from "../keyboard.ts";
import type { Board } from "../data-client/model.ts";
import { v3TypeOf } from "../data-client/adapter.ts";
import {
  componentTypes,
  displayRect,
  type Camera,
} from "../data-client/spaces.ts";
import { centerCamera, easeCamera, edgeVelocity } from "../camera-motion.ts";
import { dragIntent, editIntent, endEditSession } from "../edit-session.ts";
import { RelationEdge, type RelationEdgeType } from "./edges.tsx";
import {
  DEFAULT_VIEWPORT,
  enterBoard,
  listedRelationKind,
  relationChoices,
  toFlowEdges,
  toFlowNodes,
  viewWriteStillCurrent,
  type MapPresentation,
  type MapRelation,
  type RelationKindChoice,
  type RelationSlotChoice,
  type Viewport,
  isUnsetViewport,
} from "./mapping.ts";
import {
  CanvasApiProvider,
  CardNode,
  editField,
  type CardNodeType,
  type InlineEdit,
} from "./nodes.tsx";

type Props = {
  board: Board;
  viewId: string;
  mode: string;
  query: string;
  kind: string;
  scope: string;
  arrows: boolean;
  busy: boolean;
  focusRevision?: number;
  edgePan?: boolean;
  edgeSpeed?: number;
  motionPaused?: boolean;
  insets?: { left: number; right: number; top: number; bottom: number };
  operate: (op: any) => Promise<any>;
  call: (name: string, args?: Record<string, unknown>) => Promise<any>;
  onOpenLink: (url: string) => void;
  clearFilters: () => void;
};

const nodeTypes = { card: CardNode };
const edgeTypes = { relation: RelationEdge };

let removalSeq = 0;

function sameIds(left: readonly string[], right: readonly string[]) {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((id, index) => id === sortedRight[index]);
}

function releasePoint(
  event: MouseEvent | TouchEvent,
): { x: number; y: number } | null {
  if ("changedTouches" in event) {
    const touch = event.changedTouches[0];
    if (!touch) return null;
    return { x: touch.clientX, y: touch.clientY };
  }
  return { x: event.clientX, y: event.clientY };
}

/** 连线预览画在卡片上面。从最上层往下找，落到哪张卡片上。 */
function nodeIdAtPoint(x: number, y: number): string | null {
  for (const element of document.elementsFromPoint(x, y)) {
    const id = element.closest(".react-flow__node")?.getAttribute("data-id");
    if (id) return id;
  }
  return null;
}

function parseCamera(value: unknown): Viewport | null {
  if (!value || typeof value !== "object") return null;
  const camera = value as Partial<Viewport>;
  if (
    typeof camera.x !== "number" ||
    typeof camera.y !== "number" ||
    typeof camera.zoom !== "number"
  )
    return null;
  return { x: camera.x, y: camera.y, zoom: camera.zoom };
}

function presentationOf(instance: Board["instances"][number]): MapPresentation {
  return {
    id: instance.id,
    boardId: instance.spaceId,
    objectId: instance.objectId ?? "",
    ...(instance.parentId ? { parentId: instance.parentId } : {}),
    x: instance.rect.x,
    y: instance.rect.y,
    width: instance.rect.width,
    height: instance.rect.height,
    z: instance.z ?? 0,
    locked: instance.rect.pinned,
    ...(instance.appearance ? { appearance: instance.appearance } : {}),
  };
}

export function FlowCanvas(props: Props) {
  return (
    <ReactFlowProvider>
      <FlowSurface {...props} />
    </ReactFlowProvider>
  );
}

function FlowSurface({
  board: b,
  viewId,
  mode: _mode,
  query,
  kind,
  scope,
  arrows,
  busy: _busy,
  focusRevision = 0,
  edgePan = false,
  edgeSpeed = 600,
  motionPaused = false,
  insets = { left: 0, right: 0, top: 0, bottom: 0 },
  operate,
  call,
  onOpenLink,
  clearFilters,
}: Props) {
  const view = b.views[viewId];
  const flow = useReactFlow();
  const canvas = useRef<HTMLElement>(null);
  const [viewport, setViewport] = useState<Viewport>({ ...DEFAULT_VIEWPORT });
  const [nodes, setNodes] = useState<CardNodeType[]>([]);
  const [edges, setEdges] = useState<RelationEdgeType[]>([]);
  const [editing, setEditing] = useState<InlineEdit>();
  const [notice, setNotice] = useState("");
  const [link, setLink] = useState<{
    source: string;
    target: string;
    kinds: RelationKindChoice[];
  }>();
  const [deleteEnabled, setDeleteEnabled] = useState(true);
  const editBox = useRef<HTMLTextAreaElement | null>(null);
  const composing = useRef(false);
  const pendingCaret = useRef<{ start: number; end: number } | null>(null);
  const ignoreBlur = useRef(false);
  const dragging = useRef(new Set<string>());
  const resizing = useRef(new Set<string>());
  const pendingMoves = useRef(new Map<string, CardNodeType>());
  const selectionOverride = useRef<string[] | null>(null);
  const selectionEcho = useRef(0);
  const userClearedSelection = useRef(false);
  const selectionServer = useRef<string[]>(view?.selection ?? []);
  selectionServer.current = view?.selection ?? [];
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const operateRef = useRef(operate);
  operateRef.current = operate;
  const touched = useRef(false);
  const ignoreMove = useRef(false);
  const booted = useRef(false);
  const boardEpoch = useRef(0);
  const selectTimer = useRef(0);
  const cameraTimer = useRef(0);
  const noticeTimer = useRef(0);
  const animation = useRef(0);
  const animationGen = useRef(0);
  const appliedSelection = useRef<string | null>(null);
  const edge = useRef({
    frame: 0,
    point: undefined as { x: number; y: number } | undefined,
    last: 0,
    dirty: false,
    saved: 0,
  });
  const options = useRef({ edgePan, edgeSpeed, motionPaused });
  options.current = { edgePan, edgeSpeed, motionPaused };

  const showNotice = (text: string) => {
    setNotice(text);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(""), 3200);
  };

  const dropBoardWrites = () => {
    boardEpoch.current += 1;
    clearTimeout(selectTimer.current);
    clearTimeout(cameraTimer.current);
    selectTimer.current = 0;
    cameraTimer.current = 0;
  };

  const scheduleCamera = (next: Viewport) => {
    const epoch = boardEpoch.current;
    clearTimeout(cameraTimer.current);
    cameraTimer.current = window.setTimeout(() => {
      if (!viewWriteStillCurrent(epoch, boardEpoch.current)) return;
      void operateRef.current({ kind: "camera", camera: next });
    }, 500);
  };

  const setView = (next: Viewport, save = false) => {
    ignoreMove.current = true;
    touched.current = true;
    setViewport(next);
    requestAnimationFrame(() => {
      ignoreMove.current = false;
    });
    if (save) scheduleCamera(next);
  };

  const stopAnimation = (commit = false) => {
    animationGen.current += 1;
    if (commit && animation.current) scheduleCamera(viewportRef.current);
    cancelAnimationFrame(animation.current);
    animation.current = 0;
    ignoreMove.current = false;
  };

  const stopEdge = (commit = true) => {
    cancelAnimationFrame(edge.current.frame);
    if (commit && edge.current.dirty) scheduleCamera(viewportRef.current);
    edge.current = {
      frame: 0,
      point: undefined,
      last: 0,
      dirty: false,
      saved: 0,
    };
  };

  const animateTo = (next: Camera) => {
    stopEdge(false);
    stopAnimation();
    const gen = ++animationGen.current;
    /* 整段动画都忽略 React Flow 回传的视口，否则它会把动画掐断。 */
    ignoreMove.current = true;
    const from = viewportRef.current;
    if (
      b.theme?.reduceMotion ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      setView(next, true);
      return;
    }
    const distance = Math.hypot(next.x - from.x, next.y - from.y);
    const duration = Math.min(700, Math.max(260, distance * 0.35));
    const start = performance.now();
    const tick = (now: number) => {
      if (animationGen.current !== gen) return;
      const t = Math.min(1, (now - start) / duration);
      const eased = easeCamera(t);
      ignoreMove.current = true;
      const frame = {
        x: from.x + (next.x - from.x) * eased,
        y: from.y + (next.y - from.y) * eased,
        zoom: from.zoom + (next.zoom - from.zoom) * eased,
      };
      setViewport(frame);
      if (animationGen.current !== gen) return;
      if (t < 1) animation.current = requestAnimationFrame(tick);
      else {
        animation.current = 0;
        ignoreMove.current = false;
        scheduleCamera(next);
      }
    };
    animation.current = requestAnimationFrame(tick);
  };

  const restoreNodes = () => {
    setNodes((current) =>
      current.map((node) => {
        const instance = b.instances.find((item) => item.id === node.id);
        if (!instance) return node;
        const size =
          instance.appearance?.detail === "icon"
            ? { width: 48, height: 48 }
            : instance.appearance?.detail === "label"
              ? {
                  width: Math.min(instance.rect.width, 240),
                  height: 48,
                }
              : {
                  width: instance.rect.width,
                  height: instance.rect.height,
                };
        return {
          ...node,
          position: { x: instance.rect.x, y: instance.rect.y },
          width: size.width,
          height: size.height,
          style: { width: size.width, height: size.height },
        };
      }),
    );
  };

  const commitMove = async (moved: CardNodeType[]) => {
    const items = moved.flatMap((node) => {
      const instance = b.instances.find((item) => item.id === node.id);
      if (!instance || instance.rect.pinned) return [];
      const dx = node.position.x - instance.rect.x;
      const dy = node.position.y - instance.rect.y;
      /* 按下和松开几乎没动，是点击，不是拖动。 */
      if (Math.hypot(dx, dy) < 3) return [];
      return [
        {
          id: node.id,
          rect: { x: node.position.x, y: node.position.y },
        },
      ];
    });
    if (!items.length) return;
    const result = await operate({
      kind: "place",
      items,
      intentId: dragIntent(items.map((item) => item.id).join(",")),
    });
    if (result === undefined) {
      showNotice("移动没有写入。已回到原来的位置。请看页面上方的说明。");
      restoreNodes();
    }
  };

  const commitResize = (
    id: string,
    rect: { x: number; y: number; width: number; height: number },
  ) => {
    void (async () => {
      const result = await operate({
        kind: "place",
        items: [{ id, rect }],
        intentId: `resize:${id}:${Date.now()}`,
      });
      if (result === undefined) {
        showNotice("尺寸没有写入。已回到原来的大小。请看页面上方的说明。");
        restoreNodes();
      }
    })();
  };

  const beginEdit = (
    instance: Board["instances"][number],
    caret: { start: number; end: number },
  ) => {
    ignoreBlur.current = false;
    pendingCaret.current = caret;
    const field = editField(instance.type);
    const resolved = {
      title: instance.title,
      data: instance.data,
    };
    const content = b.contentObjects.find(
      (object) => object.id === instance.objectId,
    );
    const title = content?.title ?? resolved.title;
    const data = content?.data ?? resolved.data;
    setEditing({
      id: instance.id,
      field,
      value: field === "text" ? String(data.text ?? "") : title,
      baseTitle: title,
      baseData: data,
      ...(content ? { version: content.version } : {}),
    });
    if (!view?.selection.includes(instance.id))
      void operate({ kind: "select", ids: [instance.id] });
  };

  const commitEdit = () => {
    if (ignoreBlur.current) return;
    const edit = editing;
    if (!edit) return;
    ignoreBlur.current = true;
    const instance = b.instances.find((item) => item.id === edit.id);
    setEditing(undefined);
    if (!instance) return;
    const unchanged =
      edit.field === "title"
        ? edit.value === edit.baseTitle
        : edit.value === String(edit.baseData.text ?? "");
    if (unchanged) {
      endEditSession(instance.id);
      return;
    }
    const op =
      edit.field === "title"
        ? {
            kind: "update",
            instanceId: instance.id,
            title: edit.value.slice(0, 120),
            baseTitle: edit.baseTitle,
            ...(edit.version !== undefined
              ? { expectedVersion: edit.version }
              : {}),
            intentId: editIntent(instance.id),
          }
        : {
            kind: "update",
            instanceId: instance.id,
            data: { ...edit.baseData, text: edit.value },
            baseData: edit.baseData,
            ...(edit.version !== undefined
              ? { expectedVersion: edit.version }
              : {}),
            intentId: editIntent(instance.id),
          };
    void operate(op).then((result) => {
      if (result === undefined)
        showNotice(
          "没有保存成功：服务端拒绝了这次写入，原因见页面上方的提示。",
        );
      else endEditSession(instance.id);
    });
  };

  const cancelEdit = () => {
    ignoreBlur.current = true;
    if (editing) endEditSession(editing.id);
    setEditing(undefined);
  };

  const navigate = (spaceId: unknown) => {
    dropBoardWrites();
    touched.current = false;
    selectionOverride.current = null;
    stopAnimation(false);
    stopEdge(false);
    clearFilters();
    return operate({ kind: "navigate", spaceId });
  };

  const onBoard = view
    ? b.instances.filter((item) => item.spaceId === view.spaceId)
    : [];
  const matches = (instance: Board["instances"][number]) => {
    const object = b.objects.find((item) => item.id === instance.objectId);
    return (
      (!object || kind === "all" || object.kind === kind) &&
      (scope === "all" || !object || object.workspaceId === scope) &&
      `${instance.title} ${object?.source?.path || ""} ${instance.type === "text" ? String(instance.data.text) : ""}`
        .toLowerCase()
        .includes(query.toLowerCase())
    );
  };
  const filtered = onBoard.filter(matches);
  const visibleIds = new Set(filtered.map((item) => item.id));
  const byInstance = new Map(onBoard.map((item) => [item.id, item]));
  for (const instance of filtered) {
    let parent = instance.parentId ?? undefined;
    while (parent && !visibleIds.has(parent)) {
      const ancestor = byInstance.get(parent);
      if (!ancestor) break;
      visibleIds.add(parent);
      parent = ancestor.parentId ?? undefined;
    }
  }
  const visible = onBoard.filter((item) => visibleIds.has(item.id));
  const selectionKey = view?.selection.join("|") ?? "";

  useEffect(() => {
    if (!view) return;
    /* 定位会先改视角。节点上的旧选区会抢先回报，不能盖住这次定位。 */
    if (appliedSelection.current !== selectionKey) {
      appliedSelection.current = selectionKey;
      selectionOverride.current = null;
      clearTimeout(selectTimer.current);
      selectTimer.current = 0;
    }
    const selectedIds = selectionOverride.current ?? view.selection;
    if (
      selectionOverride.current &&
      sameIds(selectionOverride.current, view.selection)
    )
      selectionOverride.current = null;
    /* 把服务端选区写回节点时，React Flow 会再报一次选区。
       那次回报不能写回去，否则定位一张卡片会把详情面板关掉。 */
    const echo = ++selectionEcho.current;
    queueMicrotask(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (selectionEcho.current === echo) selectionEcho.current = 0;
        });
      });
    });
    const presentations = visible.map(presentationOf);
    const mapped = toFlowNodes(presentations, view.spaceId);
    const keep = new Set([...dragging.current, ...resizing.current]);
    setNodes((current) => {
      const live = new Map(current.map((node) => [node.id, node]));
      return mapped.map((node) => {
        const previous = live.get(node.id);
        const selected = (selectionOverride.current ?? selectedIds).includes(
          node.id,
        );
        if (previous && keep.has(node.id))
          return {
            ...previous,
            data: { objectId: node.data.objectId },
            draggable: node.draggable,
            className: "nopan",
            selected: previous.selected,
          };
        return {
          id: node.id,
          type: "card",
          position: node.position,
          width: node.width,
          height: node.height,
          style: { width: node.width, height: node.height },
          ...(node.parentId ? { parentId: node.parentId } : {}),
          zIndex: node.zIndex,
          draggable: node.draggable,
          /* 锁住的卡片不能拖，但按下它也不该变成在拖画布，否则选区会被清掉。 */
          className: "nopan",
          selectable: true,
          selected,
          data: { objectId: node.data.objectId },
        };
      });
    });
    const relations: MapRelation[] = arrows
      ? b.objectRelations.map((relation) => ({
          id: relation.id,
          kind: relation.kind,
          sourceId: relation.source,
          targetId: relation.target,
        }))
      : [];
    setEdges(
      toFlowEdges(
        relations,
        presentations,
        view.spaceId,
        selectionOverride.current ?? view.selection,
      ).map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: "relation",
        label: edge.label,
        data: { kind: edge.kind, label: edge.label },
        markerEnd: { type: MarkerType.ArrowClosed },
      })),
    );
  }, [b, query, kind, scope, arrows, view?.spaceId, selectionKey]);

  useEffect(() => {
    const root = canvas.current?.querySelector(".react-flow__viewport");
    root?.classList.add("world");
  });

  useEffect(() => {
    if (!view) return;
    let cancelled = false;
    const switching = booted.current;
    if (switching) {
      dropBoardWrites();
      touched.current = false;
      selectionOverride.current = null;
      stopAnimation(false);
      stopEdge(false);
    }
    const count = onBoard.length;
    const space = b.spaces.find((item) => item.id === view.spaceId);
    const isHome = !space?.parentId;
    const apply = (camera: Viewport | null) => {
      if (cancelled) return;
      if (!switching && touched.current) return;
      const entered = enterBoard({
        touched: touched.current,
        camera,
        isHome,
        presentationCount: count,
      });
      touched.current = entered.touched;
      setViewport(entered.viewport);
      if (!entered.fit) {
        if (switching) scheduleCamera(entered.viewport);
        return;
      }
      requestAnimationFrame(() => {
        void flow.fitView({ padding: 0.2, duration: 0 }).then((fitted) => {
          if (!fitted || cancelled) return;
          if (!switching && touched.current) return;
          const next = flow.getViewport();
          setViewport(next);
          scheduleCamera(next);
        });
      });
    };
    if (!booted.current) {
      booted.current = true;
      void call("app_view", { action: "get", viewId })
        .then((data) => apply(parseCamera(data?.camera)))
        .catch(() => apply(null));
    } else apply(isUnsetViewport(view.camera) ? null : view.camera);
    return () => {
      cancelled = true;
    };
  }, [view?.spaceId]);

  useEffect(() => {
    const sync = () => {
      const target = document.activeElement as HTMLElement | null;
      const typing = Boolean(
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable),
      );
      setDeleteEnabled(!document.querySelector('[role="dialog"]') && !typing);
    };
    document.addEventListener("focusin", sync);
    document.addEventListener("focusout", sync);
    return () => {
      document.removeEventListener("focusin", sync);
      document.removeEventListener("focusout", sync);
    };
  }, []);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      stopAnimation(true);
      stopEdge();
      if (blocksCanvasShortcut(event)) return;
      const target = event.target as HTMLElement | null;
      const typing = Boolean(
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable),
      );
      if (typing) return;
      const selected = selectionOverride.current ?? selectionServer.current;
      if (!selected.length) return;
      event.preventDefault();
      selectionOverride.current = [];
      setNodes((current) =>
        current.map((node) => ({ ...node, selected: false })),
      );
      void operateRef.current({ kind: "select", ids: [] });
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  useEffect(() => {
    stopAnimation();
    stopEdge(false);
  }, [view?.spaceId, motionPaused, edgePan, edgeSpeed]);

  const trackEdge = (event: PointerEvent<HTMLElement>) => {
    if (
      event.pointerType !== "mouse" ||
      event.buttons ||
      !options.current.edgePan ||
      options.current.motionPaused ||
      animation.current ||
      dragging.current.size ||
      (event.target as HTMLElement).closest("button,input,textarea,select,a")
    ) {
      stopEdge();
      return;
    }
    const box = canvas.current?.getBoundingClientRect();
    if (!box) return;
    edge.current.point = {
      x: event.clientX - box.left,
      y: event.clientY - box.top,
    };
    if (edge.current.frame) return;
    const tick = (now: number) => {
      const state = edge.current;
      const point = state.point;
      const element = canvas.current;
      if (
        !point ||
        !element ||
        !options.current.edgePan ||
        options.current.motionPaused ||
        dragging.current.size ||
        animation.current
      ) {
        stopEdge();
        return;
      }
      const velocity = edgeVelocity(
        point.x,
        point.y,
        element.clientWidth,
        element.clientHeight,
        options.current.edgeSpeed,
      );
      if (!velocity.x && !velocity.y) {
        stopEdge();
        return;
      }
      const dt = state.last ? Math.min(32, now - state.last) / 1000 : 0;
      state.last = now;
      const next = {
        ...viewportRef.current,
        x: viewportRef.current.x + velocity.x * dt,
        y: viewportRef.current.y + velocity.y * dt,
      };
      ignoreMove.current = true;
      setViewport(next);
      queueMicrotask(() => {
        ignoreMove.current = false;
      });
      state.dirty = true;
      if (now - state.saved > 500) {
        state.saved = now;
        scheduleCamera(next);
      }
      state.frame = requestAnimationFrame(tick);
    };
    edge.current.frame = requestAnimationFrame(tick);
  };

  const focusedGuide = b.guides.find(
    (guide) => guide.id === b.guideFocus?.guideId,
  );
  const routeIds = new Set(
    focusedGuide?.steps.flatMap((step) => step.objectIds) || [],
  );
  const guideKey = b.guideFocus
    ? `${b.guideFocus.guideId}:${b.guideFocus.step}`
    : "";

  const fit = (instances: Board["instances"][number][]) => {
    if (!instances.length) return;
    void flow
      .fitView({
        padding: 0.2,
        duration: 0,
        nodes: instances.map((item) => ({ id: item.id })),
      })
      .then((fitted) => {
        if (!fitted) return;
        const next = flow.getViewport();
        setView(next, true);
      });
  };

  useEffect(() => {
    if (!view || !guideKey) return;
    clearFilters();
    const targets = b.instances.filter(
      (item) =>
        item.spaceId === view.spaceId &&
        item.objectId &&
        routeIds.has(item.objectId),
    );
    if (targets[0]) {
      const rect = displayRect(targets[0]);
      animateTo(
        centerCamera(viewportRef.current, { ...rect, pinned: false }, area()),
      );
    }
  }, [guideKey, view?.spaceId]);

  useEffect(() => {
    if (!view || !query.trim() || !filtered.length) return;
    const timer = window.setTimeout(() => fit(filtered.slice(0, 30)), 160);
    return () => clearTimeout(timer);
  }, [query, kind, scope, view?.spaceId]);

  const area = () => {
    const element = canvas.current;
    const width = element?.clientWidth || 900;
    const height = element?.clientHeight || 660;
    return {
      left: Math.min(insets.left, width * 0.32),
      right: width - Math.min(insets.right, width * 0.32),
      top: insets.top,
      bottom: height - insets.bottom,
    };
  };

  useEffect(() => {
    if (
      !view?.selection.length ||
      !canvas.current ||
      dragging.current.size ||
      motionPaused
    )
      return;
    const instance = b.instances.find(
      (item) =>
        item.id === view.selection.at(-1) && item.spaceId === view.spaceId,
    );
    if (!instance) return;
    const rect = displayRect(instance);
    const current = viewportRef.current;
    const bounds = area();
    const x = rect.x * current.zoom + current.x;
    const y = rect.y * current.zoom + current.y;
    const width = canvas.current.clientWidth;
    const height = canvas.current.clientHeight;
    if (
      animation.current ||
      x < bounds.left ||
      x + rect.width * current.zoom > bounds.right ||
      y < bounds.top ||
      y + rect.height * current.zoom > height - insets.bottom
    )
      animateTo(centerCamera(current, { ...rect, pinned: false }, bounds, 0));
    void width;
  }, [
    view?.selection.join("|"),
    view?.spaceId,
    focusRevision,
    insets.left,
    insets.right,
    insets.top,
    insets.bottom,
  ]);

  const api = useMemo(
    () => ({
      board: b,
      editing,
      editBox,
      composing,
      pendingCaret,
      routeIds,
      focusedGuide,
      call,
      onOpenLink,
      navigate,
      operate,
      beginEdit,
      changeEdit: (value: string) =>
        setEditing((current) => (current ? { ...current, value } : current)),
      commitEdit,
      cancelEdit,
      markResizing: (id: string, active: boolean) => {
        if (active) resizing.current.add(id);
        else resizing.current.delete(id);
      },
      commitResize,
    }),
    [b, editing, focusedGuide, call, onOpenLink, operate, routeIds],
  );

  const chooseRelation = (kindChoice: RelationKindChoice) => {
    if (!link) return;
    const pending = link;
    setLink(undefined);
    void operate({
      kind: "link",
      source: pending.source,
      target: pending.target,
      relation: kindChoice.kind,
      description: "在白板上建立的关系",
    }).then((result) => {
      if (result === undefined)
        showNotice("关系没有建成。请看页面上方的说明。");
    });
  };

  const openLinkDialog = async (connection: Connection) => {
    if (!connection.source || !connection.target) return;
    if (connection.source === connection.target) return;
    const source = b.instances.find((item) => item.id === connection.source);
    const target = b.instances.find((item) => item.id === connection.target);
    if (!source || !target) return;
    try {
      const catalog = await call("sand_types");
      const sourceType = v3TypeOf(source.type, source.data);
      const targetType = v3TypeOf(target.type, target.data);
      const detailed = await call("sand_types", {
        types: [...new Set([sourceType, targetType])],
      });
      const slotsOf = (type: string): RelationSlotChoice[] => {
        const spec = (detailed?.types ?? []).find(
          (item: { type?: string }) => item.type === type,
        );
        return (spec?.relationSlots ?? []).map(
          (slot: {
            kind?: string;
            direction?: string;
            targetTypes?: string[];
          }) => ({
            kind: String(slot.kind ?? ""),
            direction: slot.direction === "in" ? "in" : "out",
            ...(slot.targetTypes ? { targetTypes: slot.targetTypes } : {}),
          }),
        );
      };
      const kinds = relationChoices(
        (catalog?.relationKinds ?? []).map(
          (item: {
            kind?: string;
            title?: string;
            sourceTypes?: string[];
            targetTypes?: string[];
          }) => listedRelationKind(item),
        ),
        sourceType,
        targetType,
        slotsOf(sourceType),
        slotsOf(targetType),
      );
      if (!kinds.length) {
        showNotice("这两种组件之间没有可以建立的关系。");
        return;
      }
      setLink({
        source: connection.source,
        target: connection.target,
        kinds,
      });
    } catch (error) {
      showNotice(
        error instanceof Error ? error.message : "没有读到关系类型。请重试。",
      );
    }
  };

  if (!view)
    return (
      <section className="canvas">
        <p>正在打开视图…</p>
      </section>
    );

  const parents = [];
  let space = b.spaces.find((item) => item.id === view.spaceId);
  while (space && parents.length < b.spaces.length) {
    parents.unshift(space);
    space = b.spaces.find((item) => item.id === space?.parentId);
  }

  return (
    <CanvasApiProvider value={api}>
      <div className="space-shell">
        <nav className="breadcrumbs" aria-label="白板路径">
          {parents.map((item) => (
            <button key={item.id} onClick={() => void navigate(item.id)}>
              {item.title}
            </button>
          ))}
          <span>
            {filtered.length} 个组件 · 本视图选中 {view.selection.length}
          </span>
        </nav>
        <section
          ref={canvas}
          className="canvas flow-canvas"
          aria-label="项目白板"
          onDragOver={(event) => {
            if (
              [...event.dataTransfer.types].includes(
                "application/x-sand-component",
              )
            ) {
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
            }
          }}
          onDrop={(event) => {
            const raw = event.dataTransfer.getData(
              "application/x-sand-component",
            );
            if (!raw) return;
            event.preventDefault();
            try {
              const item = JSON.parse(raw);
              if (
                typeof item.type !== "string" ||
                typeof item.title !== "string"
              )
                return;
              const size = componentTypes.find(
                (entry) => entry.type === item.type,
              );
              const position = flow.screenToFlowPosition({
                x: event.clientX,
                y: event.clientY,
              });
              void operate({
                kind: "create",
                type: item.type,
                title: item.title,
                data: item.data || {},
                ...(item.objectId ? { objectId: item.objectId } : {}),
                rect: {
                  x: position.x,
                  y: position.y,
                  width: size?.width || 280,
                  height: size?.height || 180,
                  pinned: false,
                },
              });
              clearFilters();
            } catch {
              showNotice("这块组件没有放上去。请从工具箱再拖一次。");
            }
          }}
          onPointerDownCapture={() => {
            touched.current = true;
            stopAnimation(true);
            stopEdge();
          }}
          onPointerLeave={() => stopEdge()}
          onPointerMove={trackEdge}
        >
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            viewport={viewport}
            onMove={(_event, next: FlowViewport) => {
              if (ignoreMove.current || animation.current) return;
              touched.current = true;
              stopAnimation(false);
              setViewport(next);
            }}
            onMoveEnd={(_event, next: FlowViewport) => {
              if (ignoreMove.current || animation.current) return;
              touched.current = true;
              setViewport(next);
              scheduleCamera(next);
            }}
            onNodesChange={(changes: NodeChange<CardNodeType>[]) => {
              setNodes((current) => applyNodeChanges(changes, current));
            }}
            onNodeDragStart={(_event, _node, dragged) => {
              for (const node of dragged) dragging.current.add(node.id);
            }}
            onNodeDragStop={(_event, _node, dragged) => {
              for (const node of dragged)
                pendingMoves.current.set(node.id, node);
              queueMicrotask(() => {
                const batch = [...pendingMoves.current.values()];
                pendingMoves.current.clear();
                for (const node of batch) dragging.current.delete(node.id);
                void commitMove(batch);
              });
            }}
            onPaneClick={() => {
              userClearedSelection.current = true;
              queueMicrotask(() => {
                requestAnimationFrame(() => {
                  requestAnimationFrame(() => {
                    userClearedSelection.current = false;
                  });
                });
              });
            }}
            onSelectionChange={({ nodes: selectedNodes }) => {
              const ids = selectedNodes.map((node) => node.id);
              /* 动画每帧都换一次回调，React Flow 会把节点上的旧选区再报一遍。
                 按下才会停动画，所以动画进行时的回报不是人点的。 */
              if (animation.current) {
                clearTimeout(selectTimer.current);
                selectTimer.current = 0;
                return;
              }
              /* 镜头动画会让 React Flow 反复报选区。没在空白处点击时，
                 空选区不能写回去，否则定位后的详情面板会被关掉。 */
              if (
                ids.length === 0 &&
                selectionServer.current.length > 0 &&
                !userClearedSelection.current &&
                !selectionEcho.current
              ) {
                clearTimeout(selectTimer.current);
                selectTimer.current = 0;
                return;
              }
              if (selectionEcho.current) {
                clearTimeout(selectTimer.current);
                selectTimer.current = 0;
                return;
              }
              selectionOverride.current = ids;
              /* 先清掉上一次还没发出的选择。拖不动的卡片会先报一次空选区，
                 紧接着又回到原来的选中；那次空选区不能再写出去。 */
              clearTimeout(selectTimer.current);
              selectTimer.current = 0;
              if (sameIds(ids, selectionServer.current)) return;
              const epoch = boardEpoch.current;
              selectTimer.current = window.setTimeout(() => {
                if (!viewWriteStillCurrent(epoch, boardEpoch.current)) return;
                void operateRef.current({ kind: "select", ids });
              }, 300);
            }}
            onConnect={(connection) => {
              void openLinkDialog(connection);
            }}
            onConnectEnd={(event, state) => {
              /* 默认只在离把手 20px 内才算连上。拖到卡片上时这里补一次。 */
              if (!state.fromNode || state.toNode) return;
              const point = releasePoint(event);
              if (!point) return;
              const targetId = nodeIdAtPoint(point.x, point.y);
              if (!targetId || targetId === state.fromNode.id) return;
              void openLinkDialog({
                source: state.fromNode.id,
                target: targetId,
                sourceHandle: state.fromHandle?.id ?? null,
                targetHandle: null,
              });
            }}
            onNodesDelete={(deleted) => {
              if (!deleted.length) return;
              const intentId = `remove:${Date.now()}:${++removalSeq}`;
              void operateRef
                .current({
                  kind: "remove",
                  instanceIds: deleted.map((node) => node.id),
                  intentId,
                })
                .then((result) => {
                  if (result === undefined)
                    showNotice("没有删掉这些组件。请看页面上方的说明。");
                });
            }}
            connectionMode={ConnectionMode.Loose}
            nodeDragThreshold={0}
            autoPanOnNodeDrag={false}
            deleteKeyCode={deleteEnabled ? ["Delete", "Backspace"] : null}
            minZoom={0.05}
            maxZoom={3}
            onlyRenderVisibleElements={onBoard.length > 200}
            panOnScroll={false}
            zoomOnDoubleClick={false}
            nodesConnectable
            elementsSelectable
            selectNodesOnDrag={false}
            proOptions={{ hideAttribution: true }}
            colorMode="light"
          />
          {!filtered.length && (query || onBoard.length > 0) && (
            <p className="empty">
              没有匹配对象。尝试切换到文件或清除筛选，或从组件面板添加内容。
            </p>
          )}
          {notice && (
            <p className="canvas-notice" role="status">
              {notice}
            </p>
          )}
          {link && (
            <div
              className="relation-picker"
              role="dialog"
              aria-label="选择关系"
            >
              <p>选择要建立的关系</p>
              {link.kinds.map((kindChoice) => (
                <button
                  key={kindChoice.kind}
                  onClick={() => chooseRelation(kindChoice)}
                >
                  {kindChoice.title}
                </button>
              ))}
              <button onClick={() => setLink(undefined)}>取消</button>
            </div>
          )}
          <div className="zoom">
            <button
              aria-label="缩小"
              onClick={() => {
                const next = {
                  ...viewport,
                  zoom: Math.max(0.05, viewport.zoom - 0.1),
                };
                setView(next, true);
              }}
            >
              −
            </button>
            <span>{Math.round(viewport.zoom * 100)}%</span>
            <button
              aria-label="放大"
              onClick={() => {
                const next = {
                  ...viewport,
                  zoom: Math.min(3, viewport.zoom + 0.1),
                };
                setView(next, true);
              }}
            >
              +
            </button>
            <button onClick={() => fit(filtered)}>适应</button>
            <button
              onClick={() => {
                setView({ ...DEFAULT_VIEWPORT }, true);
              }}
            >
              复位
            </button>
          </div>
        </section>
      </div>
    </CanvasApiProvider>
  );
}
