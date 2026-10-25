export type Viewport = { x: number; y: number; zoom: number };

export type NavFrame = {
  boardId: string;
  camera: Viewport;
  selection: string[];
  enteredFrom: string | null;
};

export type Area = { left: number; top: number; right: number; bottom: number };

export type FlowRect = { x: number; y: number; width: number; height: number };

export const ENTER_MS = 240;
export const MAX_MS = 600;

const DEFAULT_CAMERA: Viewport = { x: 24, y: 24, zoom: 1 };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

export function viewportOf(value: unknown): Viewport | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.x !== "number" ||
    typeof value.y !== "number" ||
    typeof value.zoom !== "number"
  )
    return null;
  if (![value.x, value.y, value.zoom].every(Number.isFinite)) return null;
  return { x: value.x, y: value.y, zoom: value.zoom };
}

export function normalizeFrame(value: unknown): NavFrame | null {
  if (typeof value === "string" && value)
    return {
      boardId: value,
      camera: { ...DEFAULT_CAMERA },
      selection: [],
      enteredFrom: null,
    };
  if (!isRecord(value) || typeof value.boardId !== "string" || !value.boardId)
    return null;
  const camera = viewportOf(value.camera) ?? { ...DEFAULT_CAMERA };
  const selection = Array.isArray(value.selection)
    ? value.selection.filter((item): item is string => typeof item === "string")
    : [];
  const enteredFrom =
    typeof value.enteredFrom === "string" && value.enteredFrom
      ? value.enteredFrom
      : null;
  return { boardId: value.boardId, camera, selection, enteredFrom };
}

export function normalizeStack(raw: readonly unknown[]): NavFrame[] {
  return raw.flatMap((item) => {
    const frame = normalizeFrame(item);
    return frame ? [frame] : [];
  });
}

export function pushFrame(
  stack: readonly NavFrame[],
  frame: NavFrame,
): NavFrame[] {
  return [...stack, frame];
}

/** 面包屑：离开过的白板，再加上当前这块。 */
export function breadcrumbIds(
  stack: readonly NavFrame[],
  currentId: string,
): string[] {
  const ids = [...stack.map((frame) => frame.boardId), currentId].filter(
    Boolean,
  );
  return ids.filter((id, index) => index === 0 || id !== ids[index - 1]);
}

export type ReturnPlan = {
  boardId: string;
  camera: Viewport;
  selection: string[];
  stack: NavFrame[];
  /** 进入时的那一处展示。来源还在才有。 */
  focusId: string | null;
  /** 来源还在才做收缩动画。 */
  shrink: boolean;
  duration: number;
};

function liveSelection(
  selection: readonly string[],
  boardId: string,
  presentationBoard: (id: string) => string | null,
): string[] {
  return selection.filter((id) => presentationBoard(id) === boardId);
}

/**
 * 从栈顶往回找还在的白板。
 * 来源展示还在：回到进入时的那一处，可以收缩。
 * 来源没了：用栈里记下的视角，去掉失效选区，不收缩，也不把镜头改到白板中心。
 */
export function planReturn(input: {
  stack: readonly NavFrame[];
  homeId: string;
  aliveBoards: ReadonlySet<string>;
  presentationBoard: (id: string) => string | null;
  reduceMotion: boolean;
}): ReturnPlan | null {
  const stack = [...input.stack];
  while (stack.length) {
    const frame = stack[stack.length - 1];
    if (!frame) break;
    if (!input.aliveBoards.has(frame.boardId)) {
      stack.pop();
      continue;
    }
    const sourceBoard = frame.enteredFrom
      ? input.presentationBoard(frame.enteredFrom)
      : null;
    const shrink = sourceBoard === frame.boardId;
    return {
      boardId: frame.boardId,
      camera: frame.camera,
      selection: liveSelection(
        frame.selection,
        frame.boardId,
        input.presentationBoard,
      ),
      stack: stack.slice(0, -1),
      focusId: shrink ? frame.enteredFrom : null,
      shrink,
      duration: shrink && !input.reduceMotion ? ENTER_MS : 0,
    };
  }
  if (!input.homeId) return null;
  return {
    boardId: input.homeId,
    camera: { ...DEFAULT_CAMERA },
    selection: [],
    stack: [],
    focusId: null,
    shrink: false,
    duration: 0,
  };
}

/** 点面包屑跳到某一级。只对紧邻的上一层做收缩。 */
export function planJump(input: {
  stack: readonly NavFrame[];
  currentId: string;
  targetId: string;
  homeId: string;
  aliveBoards: ReadonlySet<string>;
  presentationBoard: (id: string) => string | null;
  reduceMotion: boolean;
}): ReturnPlan | null {
  if (!input.targetId || input.targetId === input.currentId) return null;
  const index = input.stack.findIndex(
    (frame) => frame.boardId === input.targetId,
  );
  if (index < 0) {
    if (input.targetId !== input.homeId) return null;
    return planReturn({
      stack: input.stack,
      homeId: input.homeId,
      aliveBoards: input.aliveBoards,
      presentationBoard: input.presentationBoard,
      reduceMotion: true,
    });
  }
  const immediate = index === input.stack.length - 1;
  const kept = input.stack.slice(0, index + 1);
  const plan = planReturn({
    stack: kept,
    homeId: input.homeId,
    aliveBoards: input.aliveBoards,
    presentationBoard: input.presentationBoard,
    reduceMotion: input.reduceMotion || !immediate,
  });
  if (!plan) return null;
  if (!immediate) return { ...plan, shrink: false, duration: 0, focusId: null };
  return plan;
}

export function screenBox(
  camera: Viewport,
  rect: FlowRect,
): { x: number; y: number; width: number; height: number } {
  return {
    x: rect.x * camera.zoom + camera.x,
    y: rect.y * camera.zoom + camera.y,
    width: rect.width * camera.zoom,
    height: rect.height * camera.zoom,
  };
}

export function rectFullyVisible(
  camera: Viewport,
  rect: FlowRect,
  area: Area,
): boolean {
  const box = screenBox(camera, rect);
  return (
    box.x >= area.left - 0.5 &&
    box.y >= area.top - 0.5 &&
    box.x + box.width <= area.right + 0.5 &&
    box.y + box.height <= area.bottom + 0.5
  );
}

/** 已经完全落在可用区域里就不动。否则平移到可用区域中央，不改缩放。 */
export function panIntoView(
  camera: Viewport,
  rect: FlowRect,
  area: Area,
): Viewport | null {
  if (rectFullyVisible(camera, rect, area)) return null;
  return {
    x: (area.left + area.right) / 2 - (rect.x + rect.width / 2) * camera.zoom,
    y: (area.top + area.bottom) / 2 - (rect.y + rect.height / 2) * camera.zoom,
    zoom: camera.zoom,
  };
}

/** 几块展示在白板上占的那一整块。没有展示时没法对准。 */
export function contentBounds(rects: readonly FlowRect[]): FlowRect | null {
  if (!rects.length) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const rect of rects) {
    left = Math.min(left, rect.x);
    top = Math.min(top, rect.y);
    right = Math.max(right, rect.x + rect.width);
    bottom = Math.max(bottom, rect.y + rect.height);
  }
  if (![left, top, right, bottom].every(Number.isFinite)) return null;
  return {
    x: left,
    y: top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}

/** 镜头放大到这块组件填满可用区域。 */
export function frameCamera(rect: FlowRect, area: Area): Viewport {
  const width = Math.max(1, area.right - area.left);
  const height = Math.max(1, area.bottom - area.top);
  const zoom = Math.min(
    3,
    Math.max(0.05, Math.min(width / rect.width, height / rect.height)),
  );
  return {
    zoom,
    x: (area.left + area.right) / 2 - (rect.x + rect.width / 2) * zoom,
    y: (area.top + area.bottom) / 2 - (rect.y + rect.height / 2) * zoom,
  };
}

/** 留一圈空，把内容放进可用区域。和进入白板时的 fitView 同一留白。 */
export function fitCamera(rect: FlowRect, area: Area): Viewport {
  const width = Math.max(1, area.right - area.left);
  const height = Math.max(1, area.bottom - area.top);
  return frameCamera(rect, {
    left: area.left + width * 0.2,
    top: area.top + height * 0.2,
    right: area.right - width * 0.2,
    bottom: area.bottom - height * 0.2,
  });
}

export function motionDuration(
  from: Viewport,
  to: Viewport,
  reduceMotion: boolean,
): number {
  if (reduceMotion) return 0;
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const zoomSpan = Math.abs(Math.log((to.zoom || 1) / (from.zoom || 1))) * 400;
  const span = distance + zoomSpan;
  if (span < 120) return ENTER_MS;
  return Math.min(MAX_MS, Math.max(ENTER_MS, span));
}

export type FocusChoice =
  | { kind: "none" }
  | { kind: "here"; presentationId: string }
  | { kind: "choose"; options: { presentationId: string; boardId: string }[] };

/** 当前板选最近的可见展示；returnTo 还在这块板上就用它。别的板列出来，没有展示则 none。 */
export function focusObject(input: {
  objectId: string;
  returnTo?: string;
  currentBoardId: string;
  camera: Viewport;
  viewport: { width: number; height: number };
  presentations: readonly (FlowRect & {
    id: string;
    boardId: string;
    objectId: string;
  })[];
}): FocusChoice {
  const mine = input.presentations.filter(
    (item) => item.objectId === input.objectId,
  );
  if (input.returnTo) {
    const pinned = mine.find((item) => item.id === input.returnTo);
    if (pinned?.boardId === input.currentBoardId)
      return { kind: "here", presentationId: pinned.id };
  }
  return focusChoice({
    currentBoardId: input.currentBoardId,
    camera: input.camera,
    viewport: input.viewport,
    presentations: mine,
  });
}

/** 当前白板有多份展示时选最近的可见者；别的白板列出来让人挑；没有展示就不开。 */
export function focusChoice(input: {
  currentBoardId: string;
  camera: Viewport;
  viewport: { width: number; height: number };
  presentations: readonly (FlowRect & { id: string; boardId: string })[];
}): FocusChoice {
  const here = input.presentations.filter(
    (item) => item.boardId === input.currentBoardId,
  );
  if (here.length) {
    const area: Area = {
      left: 0,
      top: 0,
      right: input.viewport.width,
      bottom: input.viewport.height,
    };
    const centerX = input.viewport.width / 2;
    const centerY = input.viewport.height / 2;
    const visible = here.filter((item) =>
      rectFullyVisible(input.camera, item, area),
    );
    const pool = visible.length ? visible : here;
    const nearest = [...pool].sort((a, b) => {
      const da = Math.hypot(
        screenBox(input.camera, a).x +
          screenBox(input.camera, a).width / 2 -
          centerX,
        screenBox(input.camera, a).y +
          screenBox(input.camera, a).height / 2 -
          centerY,
      );
      const db = Math.hypot(
        screenBox(input.camera, b).x +
          screenBox(input.camera, b).width / 2 -
          centerX,
        screenBox(input.camera, b).y +
          screenBox(input.camera, b).height / 2 -
          centerY,
      );
      return da - db || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    })[0];
    return nearest
      ? { kind: "here", presentationId: nearest.id }
      : { kind: "none" };
  }
  if (!input.presentations.length) return { kind: "none" };
  return {
    kind: "choose",
    options: [...input.presentations]
      .map((item) => ({ presentationId: item.id, boardId: item.boardId }))
      .sort((a, b) =>
        a.boardId < b.boardId
          ? -1
          : a.boardId > b.boardId
            ? 1
            : a.presentationId < b.presentationId
              ? -1
              : 1,
      ),
  };
}
