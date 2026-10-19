import type { Board } from "./model.ts";
export function boardSummary(b: Board) {
  return {
    id: b.id,
    title: b.title,
    revision: b.revision,
    expiresAt: b.expiresAt,
    workspaces: b.workspaces.map(
      ({ id, label, head, branch, snapshot, files, omitted }) => ({
        id,
        label,
        head,
        branch,
        snapshot,
        files,
        omittedCount: omitted.length,
      }),
    ),
    objectCount: b.objects.length,
    relationCount: b.relations.length,
    selection: b.selection,
    guideFocus: b.guideFocus,
    guides: b.guides.map((g) => ({
      id: g.id,
      title: g.title,
      stale: g.stale,
      stepCount: g.steps.length,
    })),
    activities: b.activities,
    hint: "Use sand_find_objects for bounded object/source lookup; sand_read_context for the current human focus. Full map data is UI metadata.",
  };
}
/** App-only metadata contains the full board; text/structured results remain bounded for models. */
export function resultData(result: any) {
  return result._meta?.data ?? result.structuredContent?.data;
}
