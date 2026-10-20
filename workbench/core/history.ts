// Board-level undo history.
//
// The rule the issue fixed: an undo is *another record* on the same history,
// never a pop of a stack, and the undo itself can be undone.
//
// The model is a cursor over an append-only chain of steps:
//
//   edit A   -> steps: [A(S1)]            cursor: 0   board: S1
//   undo     -> steps: [A(S1)]            cursor: -1  board: S0
//               flips: [U1]                 (U1 says "undid A", cursor -1)
//   redo     -> steps: [A(S1)]            cursor: 0   board: S1
//               flips: [U1, R1]            (R1 says "redid A", cursor 0)
//
// The board's content is always the state recorded by the step under the
// cursor, so walking the cursor back walks the board back one edit at a
// time. The flips are a log, not a stack: they stay visible in the history
// panel, they carry the author that produced them, and the newest flip can
// itself be flipped (redo brings the undone edit back).
//
// Why not "undo = flip the newest record"? Because that makes two presses of
// Cmd+Z cancel each other, and then several edits can never be undone in a
// row — which is what the issue asks for ("Cmd+Z covers every write"). The
// cost of this model is that bringing an undone edit back is Cmd+Shift+Z
// (or clicking it in the history panel), not a second Cmd+Z.
//
// The scope is board content only (instances, spaces, relations, groups,
// placements, theme). Selection, camera and navigation are view state and
// are deliberately not undoable, and neither are change intents, proposals
// or validation reports — reverting board content must never stand in for
// the human confirmation gate.
import type { Board } from "./model.ts";
import type { ComponentInstance, Space, SpaceLink } from "./spaces.ts";
import type { ComponentPack, Group, Placement } from "./model.ts";
import type { ThemeConfig } from "./spaces.ts";

export type ContentState = {
  instances: ComponentInstance[];
  spaces: Space[];
  links: SpaceLink[];
  groups: Group[];
  placements: Record<string, Placement>;
  /** Imported component packs — a board content change, so they undo too. */
  packs: ComponentPack[];
  theme?: ThemeConfig | null;
};

/** One recorded write. It owns the board content it produced. */
export type HistoryStep = {
  id: string;
  label: string;
  at: number;
  seq: number;
  author: string;
  /** Steps sharing a non-empty intent token belong to one user intent. */
  intent?: string;
  state: ContentState;
};

/** One undo or redo. It is a record too: visible, attributed, reversible. */
export type HistoryFlip = {
  id: string;
  kind: "undo" | "redo";
  label: string;
  at: number;
  seq: number;
  author: string;
  /** Where the cursor sits after this flip. */
  cursor: number;
  /**
   * The step the cursor sits on, by id. The cursor index above is a
   * position, and positions move when old steps are trimmed; the id is an
   * anchor, so it keeps pointing at the same step.
   */
  stepId?: string;
};

export type BoardHistory = {
  initial: ContentState;
  steps: HistoryStep[];
  flips: HistoryFlip[];
  /** Index into steps; -1 means the board's initial content. */
  cursor: number;
  bytes: number;
  seq: number;
};

export type HistoryEntry = {
  id: string;
  kind: "edit" | "undo" | "redo";
  label: string;
  at: number;
  seq: number;
  author: string;
  intent?: string;
  /** The step index this entry leaves the cursor on. */
  cursor: number;
  /** The step this entry sits on, by id — stable across trimming. */
  stepId?: string;
  /** True for the newest entry that sits on the current position. */
  current: boolean;
};

export const HISTORY_LIMIT = 100;
export const HISTORY_BYTES = 8 * 1024 * 1024;

/**
 * What the history panel and the MCP tool read back.
 *
 * The panel used to carry its own copy of this shape; keeping one
 * definition means a change to the record shape cannot drift between the
 * server and the UI that renders it.
 */
export type HistorySnapshot = {
  boardId: string;
  records: HistoryEntry[];
  canUndo: boolean;
  canRedo: boolean;
  note: string;
};

export function captureState(b: Board): ContentState {
  return {
    instances: structuredClone(b.instances),
    spaces: structuredClone(b.spaces),
    links: structuredClone(b.spaceLinks),
    groups: structuredClone(b.groups),
    placements: structuredClone(b.placements),
    packs: structuredClone(b.componentPacks ?? []),
    theme: b.theme ? structuredClone(b.theme) : null,
  };
}

export function stateSize(state: ContentState) {
  return JSON.stringify(state).length;
}

/**
 * Cheap change detector: no clone, just the content as one string.
 *
 * Volatile fields (updatedAt, author) are left out on purpose: re-saving a
 * component with identical content is not a change, and must not become a
 * history step the user has to undo away.
 */
export function stateSignature(b: Board) {
  return JSON.stringify({
    instances: b.instances.map((i) => ({
      id: i.id,
      spaceId: i.spaceId,
      type: i.type,
      objectId: i.objectId,
      appearance: i.appearance ?? null,
      title: i.title,
      data: i.data,
      rect: i.rect,
    })),
    spaces: b.spaces.map((s) => ({
      id: s.id,
      title: s.title,
      parentId: s.parentId ?? null,
    })),
    links: b.spaceLinks.map((l) => ({
      id: l.id,
      source: l.source,
      target: l.target,
      kind: l.kind,
      description: l.description,
    })),
    groups: b.groups.map((g) => ({
      id: g.id,
      title: g.title,
      objectIds: g.objectIds,
      instanceIds: g.instanceIds ?? null,
    })),
    placements: b.placements,
    packs: (b.componentPacks ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      version: p.version,
      components: p.components.map((c) => ({
        key: c.key,
        type: c.type,
        title: c.title,
        data: c.data,
      })),
    })),
    theme: b.theme ?? null,
  });
}

/** Put a recorded state back onto the board. */
export function restoreState(b: Board, state: ContentState) {
  b.instances = structuredClone(state.instances);
  b.spaces = structuredClone(state.spaces);
  b.spaceLinks = structuredClone(state.links);
  b.groups = structuredClone(state.groups);
  b.placements = structuredClone(state.placements);
  b.componentPacks = structuredClone(state.packs ?? []);
  b.theme = state.theme ? structuredClone(state.theme) : null;
  pruneDangling(b);
}

/**
 * Content undo does not touch view state, so a reverted component can leave
 * dangling references behind. Drop them here, once, at the single place where
 * a state is put back.
 */
function pruneDangling(b: Board) {
  const alive = new Set(b.instances.map((i) => i.id));
  const spaces = new Set(b.spaces.map((s) => s.id));
  for (const view of Object.values(b.views)) {
    view.selection = view.selection.filter((id) => alive.has(id));
    if (!spaces.has(view.spaceId)) {
      view.spaceId = "overview";
      view.selection = [];
    }
  }
  b.groups = b.groups
    .map((g) =>
      g.instanceIds
        ? { ...g, instanceIds: g.instanceIds.filter((id) => alive.has(id)) }
        : g,
    )
    .filter((g) => !g.instanceIds || g.instanceIds.length > 0);
  b.spaceLinks = b.spaceLinks.filter(
    (l) => alive.has(l.source) && alive.has(l.target),
  );
}

/** The board content the cursor currently points at. */
export function currentState(history: BoardHistory): ContentState {
  return history.cursor < 0
    ? history.initial
    : history.steps[history.cursor].state;
}

/**
 * Record one write.
 *
 * Steps that share a non-empty intent token collapse into a single step, so
 * a burst of edits (typing, an agent batch) is one step rather than one step
 * per call. A write made while the cursor sits in an undone region drops
 * the steps after it: they are no longer reachable, and keeping them would
 * let a later undo resurrect an abandoned edit.
 */
export function pushEdit(
  history: BoardHistory,
  entry: {
    id: string;
    label: string;
    at: number;
    author: string;
    intent?: string;
    state: ContentState;
  },
) {
  if (history.cursor < history.steps.length - 1) truncate(history);
  const last = history.steps.at(-1);
  if (
    entry.intent &&
    last &&
    last.intent === entry.intent &&
    history.cursor === history.steps.length - 1
  ) {
    history.bytes -= stateSize(last.state);
    last.state = entry.state;
    last.at = entry.at;
    history.bytes += stateSize(entry.state);
    trim(history);
    return last;
  }
  const step: HistoryStep = {
    id: entry.id,
    label: entry.label,
    at: entry.at,
    seq: history.seq++,
    author: entry.author,
    intent: entry.intent,
    state: entry.state,
  };
  history.steps.push(step);
  history.cursor = history.steps.length - 1;
  history.bytes += stateSize(step.state);
  trim(history);
  return step;
}

/** Drop the steps after the cursor, and the flips that talked about them. */
function truncate(history: BoardHistory) {
  const cut = history.steps[history.cursor + 1];
  const cutSeq = cut ? cut.seq : Infinity;
  for (const step of history.steps.splice(history.cursor + 1))
    history.bytes -= stateSize(step.state);
  history.flips = history.flips.filter((f) => f.seq < cutSeq);
  if (history.bytes < 0) history.bytes = 0;
}

/**
 * Move the cursor and record the move.
 *
 * Undo walks the cursor back one edit; redo walks it forward. Either way
 * the move is pushed onto the history as its own record, so it shows up in
 * the history panel, carries the author that made it, and can be flipped
 * again.
 */
export function applyFlip(
  history: BoardHistory,
  entry: {
    id: string;
    kind: "undo" | "redo";
    at: number;
    author: string;
  },
) {
  const from = history.cursor;
  const to = entry.kind === "undo" ? from - 1 : from + 1;
  if (to < -1) throw Error("没有可回退的操作。");
  if (to > history.steps.length - 1) throw Error("没有可重做的操作。");
  const label =
    entry.kind === "undo"
      ? from >= 0
        ? `撤销 · ${history.steps[from].label}`
        : "撤销 · 初始状态"
      : `重做 · ${history.steps[to].label}`;
  history.cursor = to;
  history.flips.push({
    id: entry.id,
    kind: entry.kind,
    label,
    at: entry.at,
    seq: history.seq++,
    author: entry.author,
    cursor: to,
    stepId: to >= 0 ? history.steps[to].id : undefined,
  });
  trim(history);
  return currentState(history);
}

/**
 * Jump the cursor to a recorded step. The jump is itself a record.
 *
 * Index -1 means the board's initial content, so a flip that undid
 * everything can be jumped back to as well.
 */
export function jumpTo(
  history: BoardHistory,
  index: number,
  entry: { id: string; at: number; author: string },
) {
  if (index < -1 || index > history.steps.length - 1)
    throw Error("未知的历史步骤。");
  const forward = index > history.cursor;
  const target = index >= 0 ? history.steps[index].label : "初始状态";
  history.cursor = index;
  history.flips.push({
    id: entry.id,
    kind: forward ? "redo" : "undo",
    label: `${forward ? "前进到" : "回退到"} · ${target}`,
    at: entry.at,
    seq: history.seq++,
    author: entry.author,
    cursor: index,
    stepId: index >= 0 ? history.steps[index].id : undefined,
  });
  trim(history);
  return currentState(history);
}

function trim(history: BoardHistory) {
  while (
    history.steps.length > HISTORY_LIMIT ||
    (history.bytes > HISTORY_BYTES && history.steps.length > 10)
  ) {
    const dropped = history.steps.shift();
    if (!dropped) break;
    history.bytes -= stateSize(dropped.state);
    if (history.cursor >= 0) history.cursor--;
  }
  while (history.flips.length > HISTORY_LIMIT) history.flips.shift();
  if (history.bytes < 0) history.bytes = 0;
}

/** The merged, chronological view the history panel shows. */
export function summarize(history: BoardHistory): HistoryEntry[] {
  // The current position is named by the step id, not by an index: indices
  // shift when old steps are trimmed, ids do not.
  const currentStepId =
    history.cursor >= 0 ? history.steps[history.cursor]?.id : undefined;
  const entries: HistoryEntry[] = [
    ...history.steps.map((s, index) => ({
      id: s.id,
      kind: "edit" as const,
      label: s.label,
      at: s.at,
      seq: s.seq,
      author: s.author,
      intent: s.intent,
      cursor: index,
      stepId: s.id,
      current: false,
    })),
    ...history.flips.map((f) => ({
      id: f.id,
      kind: f.kind,
      label: f.label,
      at: f.at,
      seq: f.seq,
      author: f.author,
      intent: undefined,
      cursor: f.cursor,
      stepId: f.stepId,
      current: false,
    })),
  ].sort((a, b) => a.seq - b.seq);
  for (let i = entries.length - 1; i >= 0; i--)
    if (entries[i].stepId === currentStepId) {
      entries[i].current = true;
      break;
    }
  return entries;
}
