/** 打开白板时，库里还没人调过镜头，插入视角用的就是这一组。 */
export const UNSET_VIEWPORT = { x: 0, y: 0, zoom: 1 };
/** 空白首页的默认镜头。不拿它去套内容。 */
export const DEFAULT_VIEWPORT = { x: 24, y: 24, zoom: 1 };

export type Viewport = { x: number; y: number; zoom: number };

export type MapPresentation = {
  id: string;
  boardId: string;
  objectId: string;
  parentId?: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  z?: number;
  locked?: boolean;
  deleted?: boolean;
  appearance?: { detail?: string };
};

export type MapRelation = {
  id: string;
  kind: string;
  sourceId: string;
  targetId: string;
  deleted?: boolean;
};

export type MappedNode = {
  id: string;
  type: string;
  position: { x: number; y: number };
  width: number;
  height: number;
  parentId?: string;
  zIndex: number;
  draggable: boolean;
  data: {
    objectId: string;
    storedWidth: number;
    storedHeight: number;
  };
};

export type MappedEdge = {
  id: string;
  source: string;
  target: string;
  kind: string;
  label: string;
};

export type RelationKindChoice = {
  kind: string;
  title: string;
  sourceTypes?: string[];
  targetTypes?: string[];
};

export type RelationSlotChoice = {
  kind: string;
  direction: "out" | "in";
  targetTypes?: string[];
};

const KIND_LABEL: Record<string, string> = {
  "base.related": "相关",
  related: "相关",
  "base.depends_on": "依赖",
  "depends-on": "依赖",
  "base.supports": "支持",
  supports: "支持",
  "base.compares": "比较",
  compares: "比较",
  "base.belongs_to": "从属",
  "belongs-to": "从属",
  "base.about": "关于",
  contains: "包含",
  imports: "导入",
  "syntactic-call": "可能调用（语法推断）",
};

/** 折叠只改画出来的尺寸，存储的宽高留在 data 里。 */
export function renderSize(
  width: number,
  height: number,
  detail?: string,
): { width: number; height: number } {
  if (detail === "icon") return { width: 48, height: 48 };
  if (detail === "label") return { width: Math.min(width, 240), height: 48 };
  return { width, height };
}

export function isUnsetViewport(camera: Viewport): boolean {
  return (
    camera.x === UNSET_VIEWPORT.x &&
    camera.y === UNSET_VIEWPORT.y &&
    camera.zoom === UNSET_VIEWPORT.zoom
  );
}

/**
 * 有人调过的镜头照原样恢复。
 * 首页不 fitView，避免空白工作空间被缩到示例上。
 * 其他已经有展示、又没有镜头的白板才 fitView。
 */
export function openingViewport(input: {
  camera: Viewport | null;
  isHome: boolean;
  presentationCount: number;
}): { viewport: Viewport; fit: boolean } {
  if (input.camera && !isUnsetViewport(input.camera))
    return { viewport: { ...input.camera }, fit: false };
  if (input.isHome || input.presentationCount === 0)
    return { viewport: { ...DEFAULT_VIEWPORT }, fit: false };
  return { viewport: { ...DEFAULT_VIEWPORT }, fit: true };
}

/**
 * 进入另一块白板。上一张上的点击不能挡住这张的镜头，所以 touched 固定清掉。
 * camera 必须是这块白板自己的镜头，不是上一张留下的变换。
 */
export function enterBoard(input: {
  touched: boolean;
  camera: Viewport | null;
  isHome: boolean;
  presentationCount: number;
}): { touched: false; viewport: Viewport; fit: boolean } {
  const decision = openingViewport({
    camera: input.camera,
    isHome: input.isHome,
    presentationCount: input.presentationCount,
  });
  return { touched: false, ...decision };
}

/** 切走之后，旧计时器上的序号对不上，选区和镜头就不能再写。 */
export function viewWriteStillCurrent(
  scheduledEpoch: number,
  boardEpoch: number,
): boolean {
  return scheduledEpoch === boardEpoch;
}

/** 把 sand_types 精简列表里的关系种类收成选择框用的形状，端点约束留着。 */
export function listedRelationKind(item: {
  kind?: string;
  title?: string;
  sourceTypes?: readonly string[];
  targetTypes?: readonly string[];
}): RelationKindChoice {
  return {
    kind: item.kind ?? "",
    title: item.title || item.kind || "",
    ...(item.sourceTypes?.length ? { sourceTypes: [...item.sourceTypes] } : {}),
    ...(item.targetTypes?.length ? { targetTypes: [...item.targetTypes] } : {}),
  };
}

function byId(a: { id: string }, b: { id: string }): number {
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/**
 * 一条关系只画一条线。
 * 一端有多份展示时：当前选中的优先，选中了多份再按 id 排序取第一份；
 * 没有选中就按 id 排序取第一份。不把每份展示互相连成笛卡尔积。
 */
export function pickEndpoint(
  candidates: readonly MapPresentation[],
  selection: ReadonlySet<string>,
): MapPresentation | undefined {
  if (!candidates.length) return undefined;
  const selected = candidates.filter((item) => selection.has(item.id));
  const pool = selected.length ? selected : candidates;
  return [...pool].sort(byId)[0];
}

export function toFlowNodes(
  presentations: readonly MapPresentation[],
  boardId: string,
  viewOf: (objectId: string) => string | undefined = () => undefined,
): MappedNode[] {
  const live = presentations.filter(
    (item) => item.boardId === boardId && !item.deleted,
  );
  const ids = new Set(live.map((item) => item.id));
  const parents = idsOf(live);
  return live
    .map((item) => {
      const size = renderSize(item.width, item.height, item.appearance?.detail);
      const parentId =
        item.parentId && ids.has(item.parentId) ? item.parentId : undefined;
      const view = viewOf(item.objectId);
      return {
        id: item.id,
        type: view && view.length > 0 ? view : "generic",
        position: { x: item.x, y: item.y },
        width: size.width,
        height: size.height,
        ...(parentId ? { parentId } : {}),
        zIndex: item.z ?? 0,
        draggable: !item.locked,
        data: {
          objectId: item.objectId,
          storedWidth: item.width,
          storedHeight: item.height,
        },
      };
    })
    .sort((a, b) => depth(a.id, parents) - depth(b.id, parents) || byId(a, b));
}

function idsOf(items: readonly MapPresentation[]): Map<string, string | null> {
  return new Map(items.map((item) => [item.id, item.parentId ?? null]));
}

function depth(nodeId: string, parents: Map<string, string | null>): number {
  let current: string | null = nodeId;
  let guard = 0;
  let level = 0;
  while (current && guard < 30) {
    const next: string | null = parents.get(current) ?? null;
    if (!next) break;
    level += 1;
    current = next;
    guard += 1;
  }
  return level;
}

export function edgeLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind;
}

export function toFlowEdges(
  relations: readonly MapRelation[],
  presentations: readonly MapPresentation[],
  boardId: string,
  selection: readonly string[],
): MappedEdge[] {
  const live = presentations.filter(
    (item) => item.boardId === boardId && !item.deleted,
  );
  const byObject = new Map<string, MapPresentation[]>();
  for (const item of live) {
    const list = byObject.get(item.objectId) ?? [];
    list.push(item);
    byObject.set(item.objectId, list);
  }
  const selected = new Set(selection);
  const edges: MappedEdge[] = [];
  for (const relation of relations) {
    if (relation.deleted) continue;
    const source = pickEndpoint(
      byObject.get(relation.sourceId) ?? [],
      selected,
    );
    const target = pickEndpoint(
      byObject.get(relation.targetId) ?? [],
      selected,
    );
    if (!source || !target) continue;
    if (source.id === target.id) continue;
    edges.push({
      id: relation.id,
      source: source.id,
      target: target.id,
      kind: relation.kind,
      label: edgeLabel(relation.kind),
    });
  }
  return edges.sort(byId);
}

function slotAllows(
  slots: readonly RelationSlotChoice[],
  direction: "out" | "in",
  kind: string,
  otherType: string,
): boolean {
  const matched = slots.filter(
    (slot) => slot.direction === direction && slot.kind === kind,
  );
  if (!matched.length) return false;
  return matched.some(
    (slot) => !slot.targetTypes?.length || slot.targetTypes.includes(otherType),
  );
}

/** 两端类型对得上的关系才留给选择框。没有槽位限制的通用关系保留。 */
export function relationChoices(
  kinds: readonly RelationKindChoice[],
  sourceType: string,
  targetType: string,
  sourceSlots: readonly RelationSlotChoice[],
  targetSlots: readonly RelationSlotChoice[],
): RelationKindChoice[] {
  return kinds.filter((kind) => {
    if (kind.sourceTypes?.length && !kind.sourceTypes.includes(sourceType))
      return false;
    if (kind.targetTypes?.length && !kind.targetTypes.includes(targetType))
      return false;
    const mentioned =
      sourceSlots.some((slot) => slot.kind === kind.kind) ||
      targetSlots.some((slot) => slot.kind === kind.kind);
    if (!mentioned) return true;
    return (
      slotAllows(sourceSlots, "out", kind.kind, targetType) ||
      slotAllows(targetSlots, "in", kind.kind, sourceType)
    );
  });
}
