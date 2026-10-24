import { proposalSummary } from "./changes.ts";
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
    instanceCount: b.instances.length,
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
    spaceActivities: b.spaceActivities,
    intents: b.intents.map((i) => ({
      id: i.id,
      version: i.version,
      request: i.request,
      allowedFiles: i.allowedFiles,
    })),
    proposals: b.proposals.map(proposalSummary),
    hint: "objectCount counts repository objects and sources; instanceCount counts whiteboard components. sand_find_objects searches both (objects and instances) so a component you just created is findable; sand_read_spaces lists instances with their configuration.",
  };
}
/** App-only metadata contains the full board; text/structured results remain bounded for models. */
export function resultData(result: any) {
  return result._meta?.data ?? result.structuredContent?.data;
}

export const viewResult = (summary: unknown, value: unknown) => ({
  __sandView: true,
  summary,
  value,
});
