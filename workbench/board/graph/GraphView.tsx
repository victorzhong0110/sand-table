import {
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useReactFlow,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ExpandedBindings, GraphNode } from "../../kernel/index.ts";
import { Icon } from "../Icon.tsx";
import { useComponentRuntime } from "../runtime/resources.ts";
import type { ViewProps } from "../views/registry.tsx";
import {
  graphNodeHeight,
  graphNodeWidth,
  layoutGraph,
  type LayeredLayout,
} from "./layout.ts";

type RelationNode = Node<GraphNode, "relation-node">;

function Vertex({ data }: NodeProps<RelationNode>) {
  return (
    <div className={`graph-vertex${data.depth === 0 ? " graph-center" : ""}`}>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <Icon name={data.icon} size={16} />
      <span title={data.title}>{data.title || "未命名对象"}</span>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}
const nodeTypes = { "relation-node": Vertex };

function GraphSurface({
  data,
  layered,
  locate,
  addCenter,
}: {
  data: ExpandedBindings;
  layered?: LayeredLayout;
  locate(id: string): void;
  addCenter(id: string): void;
}) {
  const { fitView } = useReactFlow();
  const positions = useRef(new Map<string, { x: number; y: number }>());
  const click = useRef<number>(0);
  const planned = useMemo(() => {
    const coordinates = layoutGraph(data.nodes, data.edges, layered);
    return data.nodes.map((node): RelationNode => ({
      id: node.id,
      type: "relation-node",
      data: node,
      position: positions.current.get(node.id) ?? coordinates.get(node.id)!,
      width: graphNodeWidth,
      height: graphNodeHeight,
      ariaLabel: node.title,
    }));
  }, [data, layered]);
  const [nodes, setNodes] = useState(planned);
  useEffect(() => setNodes(planned), [planned]);
  useEffect(() => () => window.clearTimeout(click.current), []);
  const edges = useMemo(
    () =>
      data.edges.map((edge) => ({
        id: edge.id,
        source: edge.sourceId,
        target: edge.targetId,
        label:
          edge.status === "inferred" ? `${edge.title}（推测）` : edge.title,
        style: edge.status === "inferred" ? { strokeDasharray: "5 4" } : {},
        markerEnd: { type: MarkerType.ArrowClosed },
        selectable: false,
      })),
    [data.edges],
  );
  return (
    <div className="graph-surface" aria-label="关系图画布">
      <ReactFlow<RelationNode>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        noDragClassName="graph-control"
        onNodesChange={(changes) =>
          setNodes((current) => applyNodeChanges(changes, current))
        }
        onNodeDragStop={(_, node) =>
          positions.current.set(node.id, { ...node.position })
        }
        onNodeClick={(event, node) => {
          event.stopPropagation();
          window.clearTimeout(click.current);
          click.current = window.setTimeout(() => locate(node.id), 275);
        }}
        onNodeDoubleClick={(event, node) => {
          event.stopPropagation();
          window.clearTimeout(click.current);
          addCenter(node.id);
        }}
        fitView
        fitViewOptions={{ padding: 0.18, maxZoom: 1 }}
        nodesConnectable={false}
        elementsSelectable={false}
        selectionKeyCode={null}
        deleteKeyCode={null}
        zoomOnDoubleClick={false}
        minZoom={0.06}
        maxZoom={2}
      />
      <button
        type="button"
        className="graph-fit graph-control"
        onClick={() => void fitView({ padding: 0.18, maxZoom: 1 })}
      >
        适应图大小
      </button>
    </div>
  );
}

export function RelationGraphView({
  object,
  graph,
  dispatch,
  readOnly,
}: ViewProps) {
  const [result, setResult] = useState<ExpandedBindings>();
  const [error, setError] = useState("");
  const [detail, setDetail] = useState<GraphNode>();
  const [retry, setRetry] = useState(0);
  const [saving, setSaving] = useState(false);
  const [layered, setLayered] = useState<LayeredLayout>();
  const resources = useComponentRuntime();
  const read = graph?.read;
  const subscribe = graph?.subscribe;
  const kind = object.data.layout === "radial" ? "radial" : "layered";
  const wantsLayered = kind === "layered" && Boolean(result?.nodes.length);
  const selected = Array.isArray(object.data.kinds) ? object.data.kinds : [];
  function showError(reason: unknown) {
    setError(reason instanceof Error ? reason.message : String(reason));
  }
  useEffect(() => {
    if (!read || !subscribe) return;
    let active = true;
    let latest = 0;
    const refresh = () => {
      const token = ++latest;
      void read().then(
        (data) => {
          if (!active || token !== latest) return;
          setResult(data);
          setError("");
          setDetail((current) =>
            current
              ? data.nodes.find(({ id }) => id === current.id)
              : undefined,
          );
        },
        (reason) => {
          if (active && token === latest) showError(reason);
        },
      );
    };
    const stop = subscribe(refresh);
    refresh();
    return () => {
      active = false;
      stop();
    };
  }, [read, subscribe, retry]);
  useEffect(() => {
    if (!wantsLayered || layered) return;
    if (!resources) {
      showError("此宿主无法加载分层布局，请在编辑面板切换为放射布局。");
      return;
    }
    const abort = new AbortController();
    void (async () => {
      try {
        await resources.loadComponentResource("graph-layout", abort.signal);
        if (abort.signal.aborted) return;
        const ready = (
          globalThis as typeof globalThis & {
            sandTableGraphLayout?: LayeredLayout;
          }
        ).sandTableGraphLayout;
        if (!ready) throw Error("分层布局加载失败，请重试。");
        setLayered(ready);
      } catch (reason) {
        if (!abort.signal.aborted) showError(reason);
      }
    })();
    return () => abort.abort();
  }, [wantsLayered, layered, resources, retry]);
  if (!graph) return <p>关系图服务当前不可用。</p>;
  async function update(kinds: string[]) {
    setSaving(true);
    try {
      await dispatch([
        {
          op: "object.update",
          id: object.id,
          expectedVersion: object.version,
          set: { kinds },
        },
      ]);
    } catch (reason) {
      showError(reason);
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="relation-graph nodrag nopan nowheel">
      {error && (
        <p role="status" className="graph-error">
          {error}{" "}
          <button type="button" onClick={() => setRetry((n) => n + 1)}>
            重试
          </button>
        </p>
      )}
      {result?.truncated && <p role="status">还有更多，缩小范围或减少层数。</p>}
      {result ? (
        <>
          <details className="graph-filter">
            <summary>
              {selected.length
                ? `关系类型（已选 ${selected.length} 种）`
                : "关系类型（全部）"}
            </summary>
            <label>
              筛选关系类型
              <select
                multiple
                size={Math.min(6, Math.max(2, result.kinds.length))}
                disabled={readOnly || saving}
                value={selected}
                onChange={(event) =>
                  void update(
                    Array.from(
                      event.currentTarget.selectedOptions,
                      (option) => option.value,
                    ),
                  )
                }
              >
                {result.kinds.map(({ kind, title }) => (
                  <option value={kind} key={kind}>
                    {title}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              disabled={readOnly || saving || !selected.length}
              onClick={() => void update([])}
            >
              显示全部关系
            </button>
          </details>
          {wantsLayered && !layered ? (
            !error && <p>正在加载分层布局…</p>
          ) : result.nodes.length ? (
            <ReactFlowProvider key={kind}>
              <GraphSurface
                data={result}
                layered={kind === "layered" ? layered : undefined}
                locate={(id) =>
                  void graph
                    .locate(id)
                    .then((node) => setDetail(node ?? undefined), showError)
                }
                addCenter={(id) => {
                  if (!readOnly) void graph.addCenter(id).catch(showError);
                }}
              />
            </ReactFlowProvider>
          ) : (
            <p>请在编辑面板的「中心对象」里添加对象。</p>
          )}
          {detail && (
            <div className="graph-object-detail" role="status">
              <Icon name={detail.icon} size={14} /> {detail.title} ·{" "}
              {detail.type} · 版本 {detail.version}
              <button type="button" onClick={() => setDetail(undefined)}>
                关闭详情
              </button>
            </div>
          )}
        </>
      ) : (
        !error && <p>正在读取关系图…</p>
      )}
    </section>
  );
}
