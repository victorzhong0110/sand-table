/** 一条 `sand_history` / `app_history` list 记录。 */
export type HistoryListEntry = {
  id: string;
  parentId?: string | null;
  seq: number;
  current: boolean;
  onCurrentPath: boolean;
};

export type HistoryEntryState = "current" | "past" | "redo" | "branch";

export type HistoryRow =
  | {
      kind: "entry";
      id: string;
      indent: 0 | 1;
      state: HistoryEntryState;
    }
  | { kind: "branches"; atId: string; count: number; expanded: boolean };

/**
 * 当前路径不缩进。分叉只在当前路径的记录后面插一行，
 * 展开后的分支一律只缩进一级，不按 parentId 链长累加。
 */
export function layoutHistory(
  entries: readonly HistoryListEntry[],
  expanded: ReadonlySet<string>,
): HistoryRow[] {
  const ordered = [...entries].sort(
    (a, b) => a.seq - b.seq || a.id.localeCompare(b.id),
  );
  const byId = new Map(ordered.map((entry) => [entry.id, entry]));
  const children = new Map<string, HistoryListEntry[]>();
  for (const entry of ordered) {
    const parent = entry.parentId ?? "";
    if (!parent || !byId.has(parent)) continue;
    const list = children.get(parent) ?? [];
    list.push(entry);
    children.set(parent, list);
  }
  const current = ordered.find((entry) => entry.current);
  const cursorSeq = current?.seq ?? Number.POSITIVE_INFINITY;
  const stateOf = (entry: HistoryListEntry): HistoryEntryState => {
    if (entry.current) return "current";
    if (!entry.onCurrentPath) return "branch";
    return entry.seq > cursorSeq ? "redo" : "past";
  };
  const branchEntries = (start: HistoryListEntry): HistoryListEntry[] => {
    const out: HistoryListEntry[] = [];
    const seen = new Set<string>();
    const walk = (entry: HistoryListEntry) => {
      if (seen.has(entry.id) || entry.onCurrentPath) return;
      seen.add(entry.id);
      out.push(entry);
      for (const child of children.get(entry.id) ?? []) walk(child);
    };
    walk(start);
    return out;
  };
  const rows: HistoryRow[] = [];
  for (const entry of ordered) {
    if (!entry.onCurrentPath) continue;
    rows.push({
      kind: "entry",
      id: entry.id,
      indent: 0,
      state: stateOf(entry),
    });
    const starts = (children.get(entry.id) ?? []).filter(
      (child) => !child.onCurrentPath,
    );
    if (!starts.length) continue;
    const open = expanded.has(entry.id);
    rows.push({
      kind: "branches",
      atId: entry.id,
      count: starts.length,
      expanded: open,
    });
    if (!open) continue;
    for (const start of starts) {
      for (const branch of branchEntries(start)) {
        rows.push({
          kind: "entry",
          id: branch.id,
          indent: 1,
          state: "branch",
        });
      }
    }
  }
  return rows;
}
