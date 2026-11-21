import type { GraphEdge, GraphNode } from "../../kernel/index.ts";

export const graphNodeWidth = 132;
export const graphNodeHeight = 34;
export type Position = { x: number; y: number };
export type LayeredLayout = typeof import("@dagrejs/dagre");

export function layoutGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  layered: LayeredLayout | undefined,
): Map<string, Position> {
  if (layered) {
    const graph = new layered.graphlib.Graph({ multigraph: true }).setGraph({
      rankdir: "LR",
      ranker: "longest-path",
      nodesep: 36,
      ranksep: 100,
    });
    for (const { id } of nodes)
      graph.setNode(id, { width: graphNodeWidth, height: graphNodeHeight });
    for (const { id, sourceId, targetId } of edges)
      graph.setEdge(sourceId, targetId, { width: 54, height: 14 }, id);
    if (nodes.length) layered.layout(graph);
    return new Map(
      nodes.map(({ id }) => {
        const { x, y } = graph.node(id);
        return [id, { x: x - graphNodeWidth / 2, y: y - graphNodeHeight / 2 }];
      }),
    );
  }
  const positions = new Map<string, Position>();
  let radius = 0;
  for (let depth = 0; depth <= 3; depth++) {
    const ring = nodes.filter((node) => node.depth === depth);
    if (!ring.length) continue;
    if (!(depth === 0 && ring.length === 1))
      radius = Math.max(radius + 190, (ring.length * 154) / (2 * Math.PI));
    ring.forEach(({ id }, i) => {
      const angle = (2 * Math.PI * i) / ring.length - Math.PI / 2;
      positions.set(id, {
        x: radius * Math.cos(angle) - graphNodeWidth / 2,
        y: radius * Math.sin(angle) - graphNodeHeight / 2,
      });
    });
  }
  return positions;
}
