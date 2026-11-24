import type { CommentEntry } from "../../kernel/index.ts";

export function commentSections(
  entries: CommentEntry[],
  presentationId: string,
) {
  const available = entries.filter(({ removed }) => !removed);
  return {
    current: available.filter(
      (entry) =>
        !entry.originalRemoved &&
        (entry.scope === "object" || entry.presentationId === presentationId),
    ),
    removedPlacements: available.filter(
      ({ originalRemoved }) => originalRemoved,
    ),
  };
}
