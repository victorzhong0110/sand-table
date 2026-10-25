import { useEffect, useState } from "react";
import type { Board } from "../data-client/model.ts";

type Action = (name: string, args?: Record<string, unknown>) => Promise<any>;

type BoardRow = { id: string; title: string };
type TreeNode = {
  id: string;
  title: string;
  path: string[];
  repeat: boolean;
  children: TreeNode[];
};

function readable(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);
  try {
    const parsed = JSON.parse(raw) as { message?: unknown };
    if (typeof parsed.message === "string" && parsed.message)
      return parsed.message;
  } catch {
    /* 工具失败时文本可能是 JSON。 */
  }
  return raw || "这一步没有完成。请再试一次。";
}

function buildTree(
  rows: BoardRow[],
  edges: { parent: string; child: string }[],
  currentId: string,
): TreeNode[] {
  const titles = new Map(rows.map((row) => [row.id, row.title || "白板"]));
  if (!titles.has(currentId)) titles.set(currentId, "当前白板");
  const childrenOf = new Map<string, string[]>();
  const nested = new Set<string>();
  for (const edge of edges) {
    if (edge.parent === edge.child) continue;
    if (!titles.has(edge.parent) || !titles.has(edge.child)) continue;
    const list = childrenOf.get(edge.parent) ?? [];
    if (!list.includes(edge.child)) list.push(edge.child);
    childrenOf.set(edge.parent, list);
    nested.add(edge.child);
  }
  const roots = [...titles.keys()].filter((id) => !nested.has(id));
  if (!roots.length) roots.push(currentId);
  const expand = (id: string, path: string[]): TreeNode => {
    const next = [...path, id];
    if (path.includes(id)) {
      return {
        id,
        title: titles.get(id) || "白板",
        path: next,
        repeat: true,
        children: [],
      };
    }
    return {
      id,
      title: titles.get(id) || "白板",
      path: next,
      repeat: false,
      children: (childrenOf.get(id) ?? []).map((child) => expand(child, next)),
    };
  };
  return roots.map((id) => expand(id, []));
}

function BoardBranch({
  node,
  currentId,
  onOpen,
}: {
  node: TreeNode;
  currentId: string;
  onOpen: (id: string) => void;
}) {
  return (
    <li>
      <button
        type="button"
        aria-current={node.id === currentId ? "page" : undefined}
        onClick={() => onOpen(node.id)}
      >
        {node.title}
      </button>
      {node.repeat && <small>这条路径已经经过这块白板</small>}
      {node.children.length > 0 && (
        <ul>
          {node.children.map((child) => (
            <BoardBranch
              key={child.path.join("/")}
              node={child}
              currentId={currentId}
              onOpen={onOpen}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export function BoardsPanel({
  board,
  viewId,
  call,
  createBoard,
  onOpenBoard,
  onFocusInstance,
  onFocusObject,
}: {
  board: Board;
  viewId: string;
  call: Action;
  createBoard: () => void;
  onOpenBoard: (id: string) => void;
  onFocusInstance: (id: string) => void;
  onFocusObject: (objectId: string) => Promise<void>;
}) {
  const currentId = board.views[viewId]?.spaceId || board.id;
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [treeError, setTreeError] = useState("");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<
    { id: string; title: string; type: string }[]
  >([]);
  const [searchError, setSearchError] = useState("");
  const [searching, setSearching] = useState(false);
  const here = board.instances.filter((item) => item.spaceId === currentId);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const listed = await call("sand_query", {
          types: ["base.board"],
          limit: 50,
        });
        const rows: BoardRow[] = Array.isArray(listed?.rows)
          ? listed.rows.flatMap((row: { id?: unknown; title?: unknown }) =>
              typeof row?.id === "string"
                ? [{ id: row.id, title: String(row.title ?? "白板") }]
                : [],
            )
          : [];
        if (!rows.some((row) => row.id === currentId))
          rows.push({ id: currentId, title: board.title || "当前白板" });
        const objects: {
          id?: string;
          presentations?: { boardId?: string }[];
        }[] = [];
        for (let index = 0; index < rows.length; index += 20) {
          const ids = rows.slice(index, index + 20).map((row) => row.id);
          const read = await call("sand_read", {
            ids,
            include: ["presentations"],
          });
          if (Array.isArray(read?.objects)) objects.push(...read.objects);
        }
        const edges = objects.flatMap((object) => {
          if (typeof object.id !== "string") return [];
          const presentations = Array.isArray(object.presentations)
            ? object.presentations
            : [];
          return presentations.flatMap((item) =>
            typeof item.boardId === "string"
              ? [{ parent: item.boardId, child: object.id as string }]
              : [],
          );
        });
        if (!cancelled) {
          setTree(buildTree(rows, edges, currentId));
          setTreeError(
            listed?.nextCursor ? "还有更多白板没列在这棵树上。" : "",
          );
        }
      } catch (error) {
        if (!cancelled) setTreeError(readable(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [board.revision, currentId]);

  async function search() {
    const text = query.trim();
    if (!text) {
      setHits([]);
      setSearchError("先输入要找的文字。");
      return;
    }
    setSearching(true);
    setSearchError("");
    try {
      const listed = await call("sand_query", { text, limit: 20 });
      const rows = Array.isArray(listed?.rows) ? listed.rows : [];
      setHits(
        rows.flatMap(
          (row: { id?: unknown; title?: unknown; type?: unknown }) =>
            typeof row?.id === "string"
              ? [
                  {
                    id: row.id,
                    title: String(row.title ?? "未命名"),
                    type: String(row.type ?? ""),
                  },
                ]
              : [],
        ),
      );
      if (!rows.length) setSearchError("没有找到匹配的对象。");
    } catch (error) {
      setHits([]);
      setSearchError(readable(error));
    } finally {
      setSearching(false);
    }
  }

  return (
    <div className="boards-panel">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <input
          aria-label="搜索对象"
          placeholder="搜索对象…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button
          type="button"
          disabled={searching}
          onClick={() => void search()}
        >
          {searching ? "正在搜索…" : "搜索"}
        </button>
      </form>
      {searchError && <p role="status">{searchError}</p>}
      {hits.length > 0 && (
        <ul className="board-search-hits">
          {hits.map((hit) => (
            <li key={hit.id}>
              <button type="button" onClick={() => void onFocusObject(hit.id)}>
                打开 {hit.title}
              </button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" onClick={createBoard}>
        新建白板
      </button>
      {treeError && <p role="status">{treeError}</p>}
      {tree.length > 0 && (
        <ul className="board-tree">
          {tree.map((node) => (
            <BoardBranch
              key={node.path.join("/")}
              node={node}
              currentId={currentId}
              onOpen={onOpenBoard}
            />
          ))}
        </ul>
      )}
      <h3>这块白板上的对象</h3>
      <div className="board-components">
        {here.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-label={`定位 ${item.title || "未命名"}`}
            onClick={() => onFocusInstance(item.id)}
          >
            <span>{item.title || "未命名"}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
