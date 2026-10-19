import type { Board } from "./model.ts";
import type { View } from "./spaces.ts";
export function initializeSpaces(b: Board) {
  b.spaces = [{ id: "overview", title: "总览" }];
  b.views = {};
  b.instances = [];
  b.spaceLinks = [];
  b.assets = [];
  syncSourceInstances(b);
}
export function syncSourceInstances(b: Board) {
  const previous = new Set(
    b.instances.filter((c) => c.objectId).map((c) => c.objectId),
  );
  for (const o of b.objects.filter((o) => o.kind !== "workspace")) {
    if (previous.has(o.id) || b.instances.length >= 2200) continue;
    const index = b.instances.length;
    b.instances.push({
      id: `ref:${o.id}`,
      spaceId: "overview",
      type: "object",
      objectId: o.id,
      title: o.title,
      data: {},
      rect: {
        x: (index % 3) * 280,
        y: Math.floor(index / 3) * 150,
        width: 252,
        height: 120,
        pinned: false,
      },
      updatedAt: Date.now(),
      author: "source-index",
    });
  }
}
export function openView(b: Board, viewId: string) {
  if (b.views[viewId]) return b.views[viewId];
  if (Object.keys(b.views).length >= 16) {
    const old = Object.values(b.views).sort(
      (a, c) => a.updatedAt - c.updatedAt,
    )[0];
    if (Date.now() - old.updatedAt < 120000)
      throw Error("Close an older view first (16-view limit).");
    delete b.views[old.id];
  }
  const v: View = {
    id: viewId,
    spaceId: "overview",
    selection: [],
    camera: { x: 24, y: 24, zoom: 1 },
    updatedAt: Date.now(),
  };
  b.views[viewId] = v;
  return v;
}
export function syncSelection(b: Board, viewId: string, objectIds: string[]) {
  const view = openView(b, viewId);
  let candidates = b.instances.filter(
    (c) =>
      c.spaceId === view.spaceId &&
      c.objectId &&
      objectIds.includes(c.objectId),
  );
  if (objectIds.some((id) => !candidates.some((c) => c.objectId === id))) {
    view.spaceId = "overview";
    candidates = b.instances.filter(
      (c) =>
        c.spaceId === "overview" &&
        c.objectId &&
        objectIds.includes(c.objectId),
    );
  }
  view.selection = candidates.map((c) => c.id);
  view.updatedAt = Date.now();
  b.focusedViewId = viewId;
}
