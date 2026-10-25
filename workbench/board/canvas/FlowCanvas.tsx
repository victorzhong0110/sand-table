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
import { ShortcutHelp } from "../ShortcutHelp.tsx";
import { blocksCanvasShortcut } from "../keyboard.ts";
import type { Board } from "../data-client/model.ts";
import {
  CLONE_SCOPE_MESSAGE,
  DUPLICATE_OFFSET,
  EMPTY_CLIPBOARD_MESSAGE,
  OTHER_WORKSPACE_MESSAGE,
  TOO_MANY_MESSAGE,
  captureClipboard,
  clearClipboard,
  clipboardPlainText,
  layoutAt,
  layoutOffset,
  planPaste,
  readClipboard,
  saveClipboard,
  nudgeStillInWorkspace,
  syncWorkspace,
  workspaceChanged,
  type PasteItem,
  type PasteMode,
  type PlacedItem,
} from "./clipboard.ts";
import { ContextMenu, DeleteObjectDialog } from "./ContextMenu.tsx";
import {
  alignSelection,
  boardOrigin,
  componentMenu,
  distributeSelection,
  frameCommandCount,
  framePlan,
  paneMenu,
  restack,
  topLevelIds,
  unframeCommandCount,
  unframePlan,
  withinCommandLimit,
  type AlignEdge,
  type ArrangeItem,
  type DistributeAxis,
  type MenuAction,
  type ZAction,
} from "./arrange.ts";
import { Breadcrumbs } from "./Breadcrumbs.tsx";
import { detectPlatform, resolveShortcut, type ShortcutId } from "./keymap.ts";
import {
  breadcrumbIds,
  contentBounds,
  fitCamera,
  frameCamera,
  motionDuration,
  normalizeStack,
  panIntoView,
  planJump,
  planReturn,
  pushFrame,
  type NavFrame,
} from "./navigation.ts";
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
let pasteSeq = 0;

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

/** 程序同步镜头时 sourceEvent 只有 sync，不能当成用户拖动。 */
function isUserViewportEvent(event: unknown): boolean {
  if (!event || typeof event !== "object") return false;
  const source = event as { type?: unknown; sync?: unknown };
  if (source.sync === true) return false;
  return (
    source.type === "wheel" ||
    source.type === "mousemove" ||
    source.type === "pointermove" ||
    source.type === "touchmove" ||
    source.type === "mouseup" ||
    source.type === "pointerup" ||
    source.type === "touchend"
  );
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
  const [helpOpen, setHelpOpen] = useState(false);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    targetId: string | null;
    ids: string[];
  } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{
    objectId: string;
    count: number;
  } | null>(null);
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
  const workspaceRef = useRef("");
  const appliedWorkspace = useRef("");
  if (b.workspaceId) workspaceRef.current = b.workspaceId;
  const pointerClient = useRef<{ x: number; y: number } | null>(null);
  const nudgeState = useRef({
    timer: 0,
    intentId: "",
    positions: new Map<string, { x: number; y: number }>(),
    pending: new Map<string, { x: number; y: number }>(),
    token: 0,
  });
  const shortcutRef = useRef<(event: KeyboardEvent) => void>(() => {});
  const pendingMotion = useRef<{
    from: Viewport;
    to: Viewport;
    duration: number;
  } | null>(null);
  /** 进入或返回的镜头还没走完时，选区定位不能把它掐掉。 */
  const navHold = useRef(false);
  /** 刚按栈恢复的选区。这次不要再把镜头挪去对准它。 */
  const holdSelection = useRef<string[] | null>(null);
  const boardCameras = useRef(new Map<string, Viewport>());
  const focusReturn = useRef<HTMLElement | null>(null);
  const arrangeSeq = useRef(0);
  const boardRef = useRef(b);
  boardRef.current = b;
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const operateRef = useRef(operate);
  operateRef.current = operate;
  const callRef = useRef(call);
  callRef.current = call;
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

  const markNav = (duration: number, playing: boolean) => {
    const node = canvas.current;
    if (!node) return;
    node.dataset.navDuration = String(duration);
    node.dataset.navPlaying = playing ? "1" : "0";
  };

  const reduceMotionNow = () =>
    Boolean(boardRef.current.theme?.reduceMotion) ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const stopAnimation = (commit = false) => {
    animationGen.current += 1;
    navHold.current = false;
    if (commit && animation.current) scheduleCamera(viewportRef.current);
    cancelAnimationFrame(animation.current);
    animation.current = 0;
    ignoreMove.current = false;
    markNav(0, false);
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

  const animateTo = (
    next: Camera,
    options?: {
      duration?: number;
      save?: boolean;
      onDone?: () => void;
      hold?: boolean;
    },
  ) => {
    stopEdge(false);
    stopAnimation();
    const gen = ++animationGen.current;
    /* 整段动画都忽略 React Flow 回传的视口，否则它会把动画掐断。 */
    ignoreMove.current = true;
    const from = viewportRef.current;
    const reduce = reduceMotionNow();
    const distance = Math.hypot(next.x - from.x, next.y - from.y);
    const duration = reduce
      ? 0
      : (options?.duration ?? Math.min(700, Math.max(260, distance * 0.35)));
    if (options?.onDone || options?.hold) navHold.current = true;
    markNav(duration, duration > 0);
    const finish = () => {
      if (animationGen.current !== gen) return;
      animation.current = 0;
      ignoreMove.current = false;
      navHold.current = false;
      markNav(duration, false);
      if (options?.save !== false) scheduleCamera(next);
      options?.onDone?.();
    };
    if (duration === 0) {
      setView(next, options?.save !== false);
      finish();
      return;
    }
    const start = performance.now();
    const tick = (now: number) => {
      if (animationGen.current !== gen) return;
      const t = Math.min(1, (now - start) / duration);
      const eased = easeCamera(t);
      ignoreMove.current = true;
      setViewport({
        x: from.x + (next.x - from.x) * eased,
        y: from.y + (next.y - from.y) * eased,
        zoom: from.zoom + (next.zoom - from.zoom) * eased,
      });
      if (animationGen.current !== gen) return;
      if (t < 1) animation.current = requestAnimationFrame(tick);
      else finish();
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

  const enterRef = useRef<(spaceId: string, presentationId?: string) => void>(
    () => {},
  );
  const backRef = useRef<() => void>(() => {});
  const jumpRef = useRef<(boardId: string) => void>(() => {});
  const navigate = (spaceId: unknown, presentationId?: string) => {
    enterRef.current(String(spaceId ?? ""), presentationId);
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
    const nudged = nudgeState.current.positions;
    const pendingNudge = nudgeState.current.pending;
    const keep = new Set([
      ...dragging.current,
      ...resizing.current,
      ...nudged.keys(),
      ...pendingNudge.keys(),
    ]);
    setNodes((current) => {
      const live = new Map(current.map((node) => [node.id, node]));
      return mapped.map((node) => {
        const previous = live.get(node.id);
        const selected = (selectionOverride.current ?? selectedIds).includes(
          node.id,
        );
        if (previous && keep.has(node.id)) {
          const position = nudged.get(node.id) ?? pendingNudge.get(node.id);
          return {
            ...previous,
            ...(position ? { position } : {}),
            data: { objectId: node.data.objectId },
            draggable: node.draggable,
            className: "nopan",
            selected: previous.selected,
          };
        }
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
    const motion = pendingMotion.current;
    if (switching && motion) {
      pendingMotion.current = null;
      setViewport(motion.from);
      animateTo(motion.to, {
        duration: motion.duration,
        save: true,
        hold: true,
      });
      return () => {
        cancelled = true;
      };
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
      clearTimeout(cameraTimer.current);
      cameraTimer.current = 0;
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
      if (event.key === "Escape") {
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
        return;
      }
      shortcutRef.current(event);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  useEffect(() => () => clearTimeout(nudgeState.current.timer), []);

  const dropPendingNudge = () => {
    const state = nudgeState.current;
    const pending =
      state.timer !== 0 || state.positions.size > 0 || state.pending.size > 0;
    clearTimeout(state.timer);
    state.timer = 0;
    state.token += 1;
    state.positions = new Map();
    state.pending = new Map();
    state.intentId = "";
    return pending;
  };

  useEffect(() => {
    const id = b.workspaceId ?? "";
    if (!id) {
      let cancelled = false;
      void callRef
        .current("sand_list_workspaces")
        .then((data) => {
          if (cancelled) return;
          const listed =
            typeof data?.activeId === "string" ? data.activeId : "";
          if (!listed || b.workspaceId) return;
          workspaceRef.current = listed;
          syncWorkspace(listed);
        })
        .catch(() => {});
      return () => {
        cancelled = true;
      };
    }
    const previous = appliedWorkspace.current;
    appliedWorkspace.current = id;
    workspaceRef.current = id;
    if (!workspaceChanged(previous, id)) {
      syncWorkspace(id);
      return;
    }
    clearClipboard();
    if (!dropPendingNudge()) return;
    setNodes((current) =>
      current.map((node) => {
        const instance = b.instances.find((item) => item.id === node.id);
        if (!instance) return node;
        return {
          ...node,
          position: { x: instance.rect.x, y: instance.rect.y },
        };
      }),
    );
  }, [b.workspaceId]);

  useEffect(() => {
    stopAnimation();
    stopEdge(false);
  }, [motionPaused, edgePan, edgeSpeed]);

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
      const rect = placedRect(targets[0]);
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

  const placedRect = (instance: Board["instances"][number]) => {
    const rect = displayRect(instance);
    if (!view || !instance.parentId) return rect;
    const items: ArrangeItem[] = [];
    for (const item of b.instances) {
      if (item.spaceId !== view.spaceId) continue;
      items.push({
        id: item.id,
        parentId: item.parentId ?? null,
        x: item.rect.x,
        y: item.rect.y,
        width: item.rect.width,
        height: item.rect.height,
        z: item.z ?? 0,
        locked: item.rect.pinned,
      });
    }
    const origin = boardOrigin(
      instance.id,
      new Map(items.map((item) => [item.id, item])),
    );
    return { ...rect, x: origin.x, y: origin.y };
  };

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
      holdSelection.current &&
      sameIds(holdSelection.current, view?.selection ?? [])
    )
      return;
    holdSelection.current = null;
    if (
      navHold.current ||
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
    const rect = placedRect(instance);
    const current = viewportRef.current;
    const bounds = area();
    const x = rect.x * current.zoom + current.x;
    const y = rect.y * current.zoom + current.y;
    if (
      animation.current ||
      x < bounds.left ||
      x + rect.width * current.zoom > bounds.right ||
      y < bounds.top ||
      y + rect.height * current.zoom > bounds.bottom
    ) {
      const next = panIntoView(current, rect, bounds);
      if (next) animateTo(next);
    }
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

  const placedOf = (
    instance: Board["instances"][number],
  ): PlacedItem | null => {
    if (!instance.objectId) return null;
    const detail = instance.appearance?.detail;
    const accent = instance.appearance?.icon;
    const appearance = {
      ...(detail === "full" || detail === "label" || detail === "icon"
        ? { detail }
        : {}),
      ...(accent ? { accent } : {}),
    };
    return {
      objectId: instance.objectId,
      title: instance.title,
      x: instance.rect.x,
      y: instance.rect.y,
      width: instance.rect.width,
      height: instance.rect.height,
      ...(Object.keys(appearance).length ? { appearance } : {}),
      container: instance.type === "board" || instance.type === "space-link",
    };
  };

  const selectedPlaced = (): PlacedItem[] => {
    if (!view) return [];
    const picked = selectionOverride.current;
    const ids = picked && picked.length ? picked : selectionServer.current;
    return ids.flatMap((id) => {
      const instance = b.instances.find(
        (item) => item.id === id && item.spaceId === view.spaceId,
      );
      const placed = instance ? placedOf(instance) : null;
      return placed ? [placed] : [];
    });
  };

  const ensureWorkspace = async () => {
    if (workspaceRef.current) return workspaceRef.current;
    const data = await call("sand_list_workspaces");
    const id = typeof data?.activeId === "string" ? data.activeId : "";
    if (id) workspaceRef.current = id;
    return id;
  };

  const readAlive = async (ids: string[]) => {
    const alive = new Set<string>();
    for (let index = 0; index < ids.length; index += 20) {
      const data = await call("sand_read", {
        ids: ids.slice(index, index + 20),
        include: [],
      });
      for (const object of data?.objects ?? []) {
        if (object && typeof object.id === "string") alive.add(object.id);
      }
    }
    return alive;
  };

  const writePaste = async (mode: PasteMode, items: PasteItem[]) => {
    const ids = [...new Set(items.map((item) => item.objectId))];
    let alive: Set<string>;
    try {
      alive = await readAlive(ids);
    } catch (error) {
      showNotice(
        error instanceof Error
          ? error.message
          : "没能核对源对象是否还在。请稍后再试。",
      );
      return;
    }
    const planned = planPaste({ mode, items, alive });
    if (!planned.ok) {
      showNotice(planned.error);
      return;
    }
    if (mode === "clone" && planned.items.some((item) => item.container))
      showNotice(CLONE_SCOPE_MESSAGE);
    const result = await operate({
      kind: "paste",
      mode,
      items: planned.items,
      intentId: `paste:${mode}:${Date.now()}:${++pasteSeq}`,
    });
    if (result === undefined)
      showNotice("没有写上去。请看页面上方的说明，再试一次。");
  };

  const nudgeBy = (event: KeyboardEvent) => {
    if (!view) return;
    const step = event.shiftKey ? 10 : 1;
    const delta =
      event.key === "ArrowLeft"
        ? { x: -step, y: 0 }
        : event.key === "ArrowRight"
          ? { x: step, y: 0 }
          : event.key === "ArrowUp"
            ? { x: 0, y: -step }
            : event.key === "ArrowDown"
              ? { x: 0, y: step }
              : null;
    if (!delta) return;
    const selected = selectionOverride.current ?? selectionServer.current;
    const state = nudgeState.current;
    let moved = 0;
    for (const id of selected) {
      const instance = b.instances.find(
        (item) => item.id === id && item.spaceId === view.spaceId,
      );
      if (!instance || instance.rect.pinned) continue;
      const current = state.positions.get(id) ??
        state.pending.get(id) ?? {
          x: instance.rect.x,
          y: instance.rect.y,
        };
      state.positions.set(id, {
        x: current.x + delta.x,
        y: current.y + delta.y,
      });
      moved += 1;
    }
    if (!moved) {
      showNotice(
        selected.length
          ? "锁住的展示不能用方向键移动。请先取消固定。"
          : "请先选中要移动的展示。",
      );
      return;
    }
    if (!state.intentId) state.intentId = `nudge:${Date.now()}`;
    setNodes((current) =>
      current.map((node) => {
        const position = state.positions.get(node.id);
        return position ? { ...node, position } : node;
      }),
    );
    clearTimeout(state.timer);
    const intentId = state.intentId;
    const origin = workspaceRef.current;
    state.timer = window.setTimeout(() => {
      if (!nudgeStillInWorkspace(origin, workspaceRef.current)) {
        dropPendingNudge();
        return;
      }
      const items = [...state.positions.entries()].map(([id, pos]) => ({
        id,
        rect: { x: pos.x, y: pos.y },
      }));
      const token = ++state.token;
      state.pending = new Map(state.positions);
      state.positions = new Map();
      state.intentId = "";
      state.timer = 0;
      void operate({ kind: "place", items, intentId }).then((result) => {
        if (state.token !== token) return;
        state.pending = new Map();
        if (result !== undefined) return;
        showNotice(
          "方向键移动没有写入。已回到原来的位置。请看页面上方的说明。",
        );
        const board = boardRef.current;
        setNodes((current) =>
          current.map((node) => {
            const instance = board.instances.find(
              (item) => item.id === node.id,
            );
            if (!instance) return node;
            return {
              ...node,
              position: { x: instance.rect.x, y: instance.rect.y },
            };
          }),
        );
      });
    }, 500);
  };

  const publishSelection = (ids: string[]) => {
    clearTimeout(selectTimer.current);
    selectTimer.current = 0;
    selectionOverride.current = ids;
    setNodes((current) =>
      current.map((node) => ({ ...node, selected: ids.includes(node.id) })),
    );
    void operate({ kind: "select", ids });
  };

  const runShortcut = (id: ShortcutId, event: KeyboardEvent) => {
    switch (id) {
      case "delete":
      case "undo":
      case "redo":
        return;
      case "select-all": {
        if (!view) return;
        event.preventDefault();
        const ids = b.instances
          .filter((item) => item.spaceId === view.spaceId)
          .map((item) => item.id);
        publishSelection(ids);
        return;
      }
      case "duplicate-presentation":
      case "duplicate-object": {
        event.preventDefault();
        const placed = selectedPlaced();
        if (!placed.length) {
          showNotice("请先选中要再放一份的展示。");
          return;
        }
        const mode = id === "duplicate-object" ? "clone" : "reference";
        void writePaste(mode, layoutOffset(placed, DUPLICATE_OFFSET));
        return;
      }
      case "copy": {
        event.preventDefault();
        const placed = selectedPlaced();
        if (!placed.length) {
          showNotice("请先选中要复制的展示。");
          return;
        }
        const keep = (workspaceId: string) => {
          const clipboard = captureClipboard(workspaceId, placed);
          saveClipboard(clipboard);
          void navigator.clipboard
            ?.writeText(clipboardPlainText(clipboard.items))
            .catch(() => {});
        };
        if (workspaceRef.current) {
          keep(workspaceRef.current);
          return;
        }
        void ensureWorkspace().then((workspaceId) => {
          if (!workspaceId) {
            showNotice(
              "还不知道当前是哪个工作空间，复制没有记下。请稍后再试。",
            );
            return;
          }
          keep(workspaceId);
        });
        return;
      }
      case "paste-reference":
      case "paste-clone": {
        event.preventDefault();
        const clipboard = readClipboard();
        if (!clipboard?.items.length) {
          showNotice(EMPTY_CLIPBOARD_MESSAGE);
          return;
        }
        void ensureWorkspace().then((workspaceId) => {
          if (!workspaceId) {
            showNotice("还不知道当前是哪个工作空间，粘贴已取消。请稍后再试。");
            return;
          }
          if (clipboard.workspaceId !== workspaceId) {
            clearClipboard();
            showNotice(OTHER_WORKSPACE_MESSAGE);
            return;
          }
          const origin = pointerClient.current
            ? flow.screenToFlowPosition(pointerClient.current)
            : { x: 48, y: 48 };
          void writePaste(
            id === "paste-clone" ? "clone" : "reference",
            layoutAt(clipboard.items, origin),
          );
        });
        return;
      }
      case "nudge":
        event.preventDefault();
        nudgeBy(event);
        return;
      case "enter-board": {
        event.preventDefault();
        if (!view) return;
        const selected = selectionOverride.current ?? selectionServer.current;
        const instanceId = selected.at(-1);
        const instance = b.instances.find(
          (item) => item.id === instanceId && item.spaceId === view.spaceId,
        );
        if (
          !instance ||
          (instance.type !== "board" && instance.type !== "space-link")
        ) {
          showNotice("请先选中一块白板，再进入。");
          return;
        }
        enterRef.current(
          String(instance.data.spaceId ?? instance.objectId ?? ""),
          instance.id,
        );
        return;
      }
      case "leave-board":
        event.preventDefault();
        backRef.current();
        return;
      case "edit": {
        if (!view || editing) return;
        event.preventDefault();
        const selected = selectionOverride.current ?? selectionServer.current;
        const instanceId = selected.at(-1);
        const instance = b.instances.find(
          (item) => item.id === instanceId && item.spaceId === view.spaceId,
        );
        if (!instance) {
          showNotice("请先选中要编辑的组件。");
          return;
        }
        const field = editField(instance.type);
        const content = b.contentObjects.find(
          (object) => object.id === instance.objectId,
        );
        const value =
          field === "text"
            ? String((content?.data ?? instance.data).text ?? "")
            : (content?.title ?? instance.title);
        beginEdit(instance, { start: value.length, end: value.length });
        return;
      }
      case "escape":
        if (helpOpen) {
          event.preventDefault();
          setHelpOpen(false);
          return;
        }
        if (editing) {
          event.preventDefault();
          cancelEdit();
          return;
        }
        return;
      case "zoom-reset":
        event.preventDefault();
        setView({ ...DEFAULT_VIEWPORT }, true);
        return;
      case "zoom-in":
        event.preventDefault();
        setView(
          {
            ...viewportRef.current,
            zoom: Math.min(3, viewportRef.current.zoom + 0.1),
          },
          true,
        );
        return;
      case "zoom-out":
        event.preventDefault();
        setView(
          {
            ...viewportRef.current,
            zoom: Math.max(0.05, viewportRef.current.zoom - 0.1),
          },
          true,
        );
        return;
      case "help":
        event.preventDefault();
        setHelpOpen(true);
        return;
      default: {
        const unreachable: never = id;
        return unreachable;
      }
    }
  };

  shortcutRef.current = (event: KeyboardEvent) => {
    if (blocksCanvasShortcut(event)) return;
    const id = resolveShortcut({
      key: event.key,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      platform: detectPlatform(),
      typing: false,
    });
    if (!id) return;
    runShortcut(id, event);
  };

  const closeMenu = () => setMenu(null);

  const restoreFocus = () => {
    const back = focusReturn.current;
    focusReturn.current = null;
    if (!back?.isConnected) return;
    requestAnimationFrame(() => {
      if (back.isConnected) back.focus({ preventScroll: true });
    });
  };

  const rememberFocus = (instanceId: string | null) => {
    const article = instanceId
      ? document.querySelector<HTMLElement>(
          `[data-instance-id="${CSS.escape(instanceId)}"]`,
        )
      : null;
    const active =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    focusReturn.current = article ?? active ?? canvas.current;
  };

  const itemsOnBoard = (): ArrangeItem[] => {
    if (!view) return [];
    return b.instances
      .filter((item) => item.spaceId === view.spaceId)
      .map((item) => ({
        id: item.id,
        parentId: item.parentId ?? null,
        x: item.rect.x,
        y: item.rect.y,
        width: item.rect.width,
        height: item.rect.height,
        z: item.z ?? 0,
        locked: item.rect.pinned,
      }));
  };

  const arrangeIntent = (name: string) =>
    `${name}:${Date.now()}:${++arrangeSeq.current}`;

  const commitArrange = async (
    op: Record<string, unknown>,
    failure: string,
  ) => {
    const result = await operate(op);
    if (result === undefined) showNotice(failure);
  };

  const placedFor = (ids: string[]): PlacedItem[] => {
    if (!view) return [];
    return ids.flatMap((id) => {
      const instance = b.instances.find(
        (item) => item.id === id && item.spaceId === view.spaceId,
      );
      const placed = instance ? placedOf(instance) : null;
      return placed ? [placed] : [];
    });
  };

  const alignBy = async (ids: string[], edge: AlignEdge) => {
    const updates = alignSelection(itemsOnBoard(), ids, edge);
    if (!updates.length) {
      showNotice("没有移动。锁定的展示会留在原地，已经对齐的也不会再写一次。");
      return;
    }
    if (!withinCommandLimit(updates.length)) {
      showNotice(TOO_MANY_MESSAGE);
      return;
    }
    await commitArrange(
      { kind: "arrange", items: updates, intentId: arrangeIntent("align") },
      "没有对齐。请看页面上方的说明。",
    );
  };

  const distributeBy = async (ids: string[], axis: DistributeAxis) => {
    const updates = distributeSelection(itemsOnBoard(), ids, axis);
    if (!updates) {
      showNotice("至少选中 3 个展示才能等间距分布。");
      return;
    }
    if (!updates.length) {
      showNotice("没有移动。锁定的展示会留在原地，首尾也不会动。");
      return;
    }
    if (!withinCommandLimit(updates.length)) {
      showNotice(TOO_MANY_MESSAGE);
      return;
    }
    await commitArrange(
      {
        kind: "arrange",
        items: updates,
        intentId: arrangeIntent("distribute"),
      },
      "没有分布。请看页面上方的说明。",
    );
  };

  const stackBy = async (ids: string[], action: ZAction) => {
    const items = itemsOnBoard();
    const updates = restack(
      items.map((item) => ({ id: item.id, z: item.z })),
      ids,
      action,
    );
    if (!updates.length) {
      showNotice("这些展示已经在这一层了。");
      return;
    }
    if (!withinCommandLimit(updates.length)) {
      showNotice(TOO_MANY_MESSAGE);
      return;
    }
    await commitArrange(
      { kind: "restack", items: updates, intentId: arrangeIntent("z") },
      "没有调整层级。请看页面上方的说明。",
    );
  };

  const lockBy = async (ids: string[], locked: boolean) => {
    if (!withinCommandLimit(ids.length)) {
      showNotice(TOO_MANY_MESSAGE);
      return;
    }
    await commitArrange(
      {
        kind: "lock",
        ids,
        locked,
        intentId: arrangeIntent(locked ? "lock" : "unlock"),
      },
      locked
        ? "没有锁定。请看页面上方的说明。"
        : "没有解锁。请看页面上方的说明。",
    );
  };

  const frameBy = async (ids: string[]) => {
    const plan = framePlan(itemsOnBoard(), ids);
    if (!plan) {
      showNotice("没有能放进框的展示。锁定的展示会留在原地。");
      return;
    }
    if (!withinCommandLimit(frameCommandCount(plan.children.length))) {
      showNotice(TOO_MANY_MESSAGE);
      return;
    }
    await commitArrange(
      {
        kind: "frame",
        frame: plan.frame,
        children: plan.children,
        intentId: arrangeIntent("frame"),
      },
      "没有放进框。请看页面上方的说明。",
    );
  };

  const unframeBy = async (frameId: string) => {
    const plan = unframePlan(itemsOnBoard(), frameId);
    if (!plan) {
      showNotice("这个框已经不在白板上了。请刷新后再试。");
      return;
    }
    if (!withinCommandLimit(unframeCommandCount(plan.children))) {
      showNotice(TOO_MANY_MESSAGE);
      return;
    }
    await commitArrange(
      {
        kind: "unframe",
        frameId: plan.frameId,
        children: plan.children,
        intentId: arrangeIntent("unframe"),
      },
      "没有解除框。请看页面上方的说明。",
    );
  };

  const removeBy = async (ids: string[]) => {
    if (!ids.length) {
      showNotice("请先选中要移除的展示。");
      return;
    }
    if (!withinCommandLimit(ids.length)) {
      showNotice(TOO_MANY_MESSAGE);
      return;
    }
    await commitArrange(
      {
        kind: "remove",
        instanceIds: ids,
        intentId: arrangeIntent("remove"),
      },
      "没有移除展示。请看页面上方的说明。",
    );
  };

  const askDeleteObject = async (objectId: string) => {
    try {
      const data = await call("sand_read", {
        ids: [objectId],
        include: ["presentations"],
      });
      const objects = Array.isArray(data?.objects) ? data.objects : [];
      const found = objects.find(
        (item: { id?: string; presentations?: unknown }) =>
          item?.id === objectId,
      );
      if (!found) {
        showNotice("没有读到这个对象。请刷新后再删除。");
        return;
      }
      const count = Array.isArray(found.presentations)
        ? found.presentations.length
        : 0;
      setDeleteConfirm({ objectId, count });
    } catch (error) {
      showNotice(
        error instanceof Error
          ? error.message
          : "没能读到这个对象还出现在哪些白板上。请稍后再试。",
      );
    }
  };

  const openNodeMenu = (id: string, point: { x: number; y: number }) => {
    if (!view) return;
    const current = selectionOverride.current ?? selectionServer.current;
    const ids = current.includes(id)
      ? current.filter((item) =>
          b.instances.some(
            (instance) =>
              instance.id === item && instance.spaceId === view.spaceId,
          ),
        )
      : [id];
    if (!current.includes(id)) publishSelection([id]);
    rememberFocus(id);
    setMenu({ x: point.x, y: point.y, targetId: id, ids });
  };

  const performMenu = (action: MenuAction) => {
    const current = menu;
    if (!current || !view) return;
    const ids = current.ids;
    const target = current.targetId
      ? b.instances.find(
          (item) =>
            item.id === current.targetId && item.spaceId === view.spaceId,
        )
      : undefined;
    closeMenu();
    if (action !== "edit" && action !== "delete-object") restoreFocus();
    switch (action) {
      case "edit": {
        focusReturn.current = null;
        if (!target) {
          showNotice("请先选中要编辑的组件。");
          return;
        }
        const field = editField(target.type);
        const content = b.contentObjects.find(
          (object) => object.id === target.objectId,
        );
        const value =
          field === "text"
            ? String((content?.data ?? target.data).text ?? "")
            : (content?.title ?? target.title);
        beginEdit(target, { start: value.length, end: value.length });
        return;
      }
      case "duplicate":
      case "clone": {
        const placed = placedFor(ids);
        if (!placed.length) {
          showNotice("请先选中要再放一份的展示。");
          return;
        }
        void writePaste(
          action === "clone" ? "clone" : "reference",
          layoutOffset(placed, DUPLICATE_OFFSET),
        );
        return;
      }
      case "align-left":
        void alignBy(ids, "left");
        return;
      case "align-center-x":
        void alignBy(ids, "center-x");
        return;
      case "align-right":
        void alignBy(ids, "right");
        return;
      case "align-top":
        void alignBy(ids, "top");
        return;
      case "align-center-y":
        void alignBy(ids, "center-y");
        return;
      case "align-bottom":
        void alignBy(ids, "bottom");
        return;
      case "distribute-x":
        void distributeBy(ids, "x");
        return;
      case "distribute-y":
        void distributeBy(ids, "y");
        return;
      case "front":
      case "back":
      case "forward":
      case "backward":
        void stackBy(ids, action);
        return;
      case "lock":
        void lockBy(ids, true);
        return;
      case "unlock":
        void lockBy(ids, false);
        return;
      case "frame":
        void frameBy(ids);
        return;
      case "unframe":
        if (!current.targetId) return;
        void unframeBy(current.targetId);
        return;
      case "remove":
        void removeBy(ids);
        return;
      case "delete-object": {
        const objectId = target?.objectId;
        if (!objectId) {
          focusReturn.current = null;
          showNotice("这个展示没有绑定对象，没法删除对象。");
          return;
        }
        void askDeleteObject(objectId);
        return;
      }
      case "paste":
      case "paste-clone": {
        const clipboard = readClipboard();
        if (!clipboard?.items.length) {
          showNotice(EMPTY_CLIPBOARD_MESSAGE);
          return;
        }
        void ensureWorkspace().then((workspaceId) => {
          if (!workspaceId) {
            showNotice("还不知道当前是哪个工作空间，粘贴已取消。请稍后再试。");
            return;
          }
          if (clipboard.workspaceId !== workspaceId) {
            clearClipboard();
            showNotice(OTHER_WORKSPACE_MESSAGE);
            return;
          }
          const origin = flow.screenToFlowPosition({
            x: current.x,
            y: current.y,
          });
          void writePaste(
            action === "paste-clone" ? "clone" : "reference",
            layoutAt(clipboard.items, origin),
          );
        });
        return;
      }
      case "select-all": {
        const all = b.instances
          .filter((item) => item.spaceId === view.spaceId)
          .map((item) => item.id);
        publishSelection(all);
        return;
      }
      default: {
        const unreachable: never = action;
        return unreachable;
      }
    }
  };

  const currentStack = (): NavFrame[] =>
    normalizeStack(
      ((view as { navStack?: unknown[] } | undefined)?.navStack ??
        []) as unknown[],
    );

  const presentationBoard = (id: string) => {
    const boards = boardRef.current.presentationBoards;
    if (boards && Object.prototype.hasOwnProperty.call(boards, id))
      return boards[id] ?? null;
    const instance = boardRef.current.instances.find((item) => item.id === id);
    return instance ? instance.spaceId : null;
  };

  const aliveBoards = () =>
    new Set(boardRef.current.spaces.map((item) => item.id));

  const homeBoardId = () => {
    const home = boardRef.current.spaces.find((item) => !item.parentId);
    return home?.id ?? boardRef.current.spaces[0]?.id ?? "";
  };

  const applyPlan = (plan: {
    boardId: string;
    camera: { x: number; y: number; zoom: number };
    selection: string[];
    stack: NavFrame[];
    focusId: string | null;
    shrink: boolean;
    duration: number;
  }) => {
    dropBoardWrites();
    touched.current = false;
    selectionOverride.current = null;
    stopEdge(false);
    clearFilters();
    if (view)
      boardCameras.current.set(view.spaceId, { ...viewportRef.current });
    const focus = plan.focusId
      ? boardRef.current.instances.find((item) => item.id === plan.focusId)
      : undefined;
    const rect = focus ? placedRect(focus) : null;
    const camera = plan.camera;
    const from = plan.shrink && rect ? frameCamera(rect, area()) : camera;
    const duration =
      plan.shrink && rect && !reduceMotionNow()
        ? motionDuration(from, camera, false)
        : 0;
    pendingMotion.current = { from, to: camera, duration };
    holdSelection.current = plan.selection;
    markNav(duration, duration > 0);
    void operate({
      kind: "navigate",
      spaceId: plan.boardId,
      navStack: plan.stack,
      camera,
      selection: plan.selection,
    });
  };

  const enterFromInstance = (instance: Board["instances"][number]) => {
    if (!view) return;
    const target = String(instance.data.spaceId ?? instance.objectId ?? "");
    if (!target || target === view.spaceId) {
      showNotice("这块白板就是当前白板，不用再进入。");
      return;
    }
    const saved = { ...viewportRef.current };
    const picked = selectionOverride.current;
    const selection = [
      ...(picked && picked.length ? picked : selectionServer.current),
    ];
    const rect = placedRect(instance);
    const usable = area();
    const framed = frameCamera(rect, usable);
    const reduce = reduceMotionNow();
    const duration = motionDuration(saved, framed, reduce);
    const frame: NavFrame = {
      boardId: view.spaceId,
      camera: saved,
      selection,
      enteredFrom: instance.id,
    };
    const stack = pushFrame(currentStack(), frame);
    boardCameras.current.set(view.spaceId, saved);
    const bounds = contentBounds(
      boardRef.current.instances
        .filter((item) => item.spaceId === target && !item.parentId)
        .map((item) => ({
          x: item.rect.x,
          y: item.rect.y,
          width: item.rect.width,
          height: item.rect.height,
        })),
    );
    const remembered = boardCameras.current.get(target) ?? null;
    const filled = bounds ? frameCamera(bounds, usable) : null;
    const landed = bounds ? (remembered ?? fitCamera(bounds, usable)) : null;
    const opening =
      filled && landed
        ? {
            from: filled,
            to: landed,
            duration: motionDuration(filled, landed, reduce),
          }
        : remembered
          ? { from: remembered, to: remembered, duration: 0 }
          : null;
    animateTo(framed, {
      duration,
      save: false,
      onDone: () => {
        dropBoardWrites();
        touched.current = false;
        selectionOverride.current = null;
        stopEdge(false);
        clearFilters();
        pendingMotion.current = opening;
        void operate({
          kind: "navigate",
          spaceId: target,
          navStack: stack,
          enteredFrom: instance.id,
          selection: [],
        });
      },
    });
  };

  enterRef.current = (spaceId, presentationId) => {
    if (!view) return;
    const instance =
      (presentationId
        ? b.instances.find((item) => item.id === presentationId)
        : undefined) ??
      b.instances.find(
        (item) =>
          item.spaceId === view.spaceId &&
          (item.objectId === spaceId || item.data.spaceId === spaceId),
      );
    if (
      instance &&
      (instance.type === "board" || instance.type === "space-link")
    ) {
      enterFromInstance(instance);
      return;
    }
    dropBoardWrites();
    touched.current = false;
    selectionOverride.current = null;
    stopAnimation(false);
    stopEdge(false);
    clearFilters();
    void operate({ kind: "navigate", spaceId });
  };

  backRef.current = () => {
    if (!view) return;
    void call("sand_read_board").then((fresh) => {
      const board = fresh?.instances ? fresh : boardRef.current;
      const instances = (board.instances ?? []) as Board["instances"];
      const spaces = (board.spaces ??
        boardRef.current.spaces) as Board["spaces"];
      const boards = board.presentationBoards ?? {};
      const where = (id: string) =>
        Object.prototype.hasOwnProperty.call(boards, id)
          ? (boards[id] ?? null)
          : (instances.find((item) => item.id === id)?.spaceId ?? null);
      const alive = new Set(spaces.map((item) => item.id));
      const home = spaces.find((item) => !item.parentId)?.id ?? homeBoardId();
      const plan = planReturn({
        stack: currentStack(),
        homeId: home,
        aliveBoards: alive,
        presentationBoard: where,
        reduceMotion: reduceMotionNow(),
      });
      if (!plan || plan.boardId === view.spaceId) {
        showNotice("已经在首页白板，没有可以返回的上一层。");
        return;
      }
      applyPlan(plan);
    });
  };

  jumpRef.current = (boardId) => {
    if (!view || boardId === view.spaceId) return;
    const plan = planJump({
      stack: currentStack(),
      currentId: view.spaceId,
      targetId: boardId,
      homeId: homeBoardId(),
      aliveBoards: aliveBoards(),
      presentationBoard,
      reduceMotion: reduceMotionNow(),
    });
    if (!plan) {
      void operate({ kind: "navigate", spaceId: boardId });
      return;
    }
    applyPlan(plan);
  };

  if (!view)
    return (
      <section className="canvas">
        <p>正在打开视图…</p>
      </section>
    );

  const boardItems = itemsOnBoard();
  const menuItems = !menu
    ? []
    : menu.targetId
      ? componentMenu({
          alignCount: topLevelIds(
            menu.ids,
            (id) => boardItems.find((item) => item.id === id)?.parentId ?? null,
          ).length,
          targetLocked: Boolean(
            b.instances.find((item) => item.id === menu.targetId)?.rect.pinned,
          ),
          targetIsFrame:
            b.instances.find((item) => item.id === menu.targetId)?.type ===
            "base.frame",
          canFrame: framePlan(boardItems, menu.ids) !== null,
        })
      : paneMenu();

  const stack = currentStack();
  const crumbs = breadcrumbIds(stack, view.spaceId).map((id) => ({
    id,
    title:
      b.spaces.find((item) => item.id === id)?.title ||
      b.objects.find((item) => item.id === id)?.title ||
      "未命名白板",
  }));

  return (
    <CanvasApiProvider value={api}>
      <div className="space-shell">
        <Breadcrumbs
          items={crumbs}
          canReturn={stack.length > 0}
          detail={`${filtered.length} 个组件 · 本视图选中 ${view.selection.length}`}
          onOpen={(id) => jumpRef.current(id)}
          onReturn={() => backRef.current()}
        />
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
          onPointerDownCapture={(event) => {
            pointerClient.current = { x: event.clientX, y: event.clientY };
            touched.current = true;
            stopAnimation(true);
            stopEdge();
          }}
          onPointerLeave={() => stopEdge()}
          onPointerMove={(event) => {
            pointerClient.current = { x: event.clientX, y: event.clientY };
            trackEdge(event);
          }}
        >
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            viewport={viewport}
            onMove={(_event, next: FlowViewport) => {
              if (
                ignoreMove.current ||
                animation.current ||
                !isUserViewportEvent(_event)
              )
                return;
              touched.current = true;
              stopAnimation(false);
              setViewport(next);
            }}
            onMoveEnd={(_event, next: FlowViewport) => {
              if (
                ignoreMove.current ||
                animation.current ||
                !isUserViewportEvent(_event)
              )
                return;
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
              if (menu) {
                setMenu(null);
                focusReturn.current = null;
              }
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
              /* 动画每帧都会把当前选区再报一遍，空报不能把还没写走的选择清掉。
                 人在动画里新选中的卡片仍然要留下，否则方向键和复制会落空。 */
              if (animation.current) {
                const known =
                  selectionOverride.current ?? selectionServer.current;
                if (ids.length === 0 || sameIds(ids, known)) return;
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
            onNodeContextMenu={(event, node) => {
              event.preventDefault();
              openNodeMenu(node.id, { x: event.clientX, y: event.clientY });
            }}
            onPaneContextMenu={(event) => {
              event.preventDefault();
              rememberFocus(null);
              setMenu({
                x: event.clientX,
                y: event.clientY,
                targetId: null,
                ids: selectionOverride.current ?? selectionServer.current,
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
            selectionOnDrag={false}
            panOnDrag
            selectionKeyCode="Shift"
            multiSelectionKeyCode={["Meta", "Control"]}
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
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={menu.targetId ? "组件菜单" : "白板菜单"}
          items={menuItems}
          onSelect={(id) => performMenu(id)}
          onClose={() => {
            closeMenu();
            restoreFocus();
          }}
        />
      )}
      {deleteConfirm && (
        <DeleteObjectDialog
          count={deleteConfirm.count}
          onCancel={() => {
            setDeleteConfirm(null);
            restoreFocus();
          }}
          onConfirm={() => {
            const pending = deleteConfirm;
            setDeleteConfirm(null);
            focusReturn.current = canvas.current;
            restoreFocus();
            void commitArrange(
              {
                kind: "deleteObject",
                objectId: pending.objectId,
                intentId: arrangeIntent("delete-object"),
              },
              "没有删除这个对象。请看页面上方的说明。",
            );
          }}
        />
      )}
      {helpOpen && <ShortcutHelp onClose={() => setHelpOpen(false)} />}
    </CanvasApiProvider>
  );
}
