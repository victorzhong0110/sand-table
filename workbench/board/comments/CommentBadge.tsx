import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  CommentThread,
  type CommentCall,
  type CommentTarget,
} from "./CommentThread.tsx";

const CommentContext = createContext<{
  counts: Record<string, number>;
  open: (target: CommentTarget, trigger: HTMLButtonElement) => void;
} | null>(null);

export function CommentProvider({
  children,
  boardId,
  workspaceId,
  revision,
  call,
}: {
  children: ReactNode;
  boardId: string;
  workspaceId?: string;
  revision: number;
  call: CommentCall;
}) {
  const scope = JSON.stringify([workspaceId, boardId]);
  const [result, setResult] = useState<{
    scope: string;
    counts: Record<string, number>;
  }>();
  const [selection, setSelection] = useState<{
    scope: string;
    target: CommentTarget;
  }>();
  const [refresh, setRefresh] = useState(0);
  const invoke = useRef(call);
  invoke.current = call;
  const trigger = useRef<HTMLButtonElement>(null);
  const target = selection?.scope === scope ? selection.target : undefined;
  useEffect(() => {
    if (!workspaceId) return;
    let active = true;
    void invoke
      .current("app_comments", { action: "counts", workspaceId, boardId })
      .then((value) => {
        const next = value as {
          workspaceId: string;
          revision: number;
          counts: Record<string, number>;
        };
        if (
          active &&
          next.workspaceId === workspaceId &&
          next.revision >= revision
        )
          setResult({ scope, counts: next.counts });
      })
      .catch(() => {
        if (active) setResult(undefined);
      });
    return () => {
      active = false;
    };
  }, [boardId, workspaceId, scope, revision, refresh]);
  return (
    <CommentContext.Provider
      value={
        workspaceId
          ? {
              counts: result?.scope === scope ? result.counts : {},
              open(target, button) {
                trigger.current = button;
                setSelection({ scope, target });
              },
            }
          : null
      }
    >
      {children}
      {target && workspaceId && (
        <CommentThread
          key={`${scope}/${target.presentationId}`}
          target={target}
          workspaceId={workspaceId}
          revision={revision}
          call={call}
          refreshCounts={() => setRefresh((value) => value + 1)}
          close={() => {
            setSelection(undefined);
            trigger.current?.focus({ preventScroll: true });
          }}
        />
      )}
    </CommentContext.Provider>
  );
}

export function CommentBadge(target: CommentTarget) {
  const context = useContext(CommentContext);
  if (!context) return null;
  const count = context.counts[target.presentationId] ?? 0;
  return (
    <button
      type="button"
      className="comment-badge nodrag nowheel nopan"
      data-has-comments={count > 0}
      aria-label={count ? `评论（${count} 条未解决）` : "评论"}
      onClick={(event) => {
        event.stopPropagation();
        context.open(target, event.currentTarget);
      }}
    >
      {count ? `评论 ${count}` : "评论"}
    </button>
  );
}
