import { useEffect, useRef, useState } from "react";
import type { Command, CommentEntry } from "../../kernel/index.ts";
import { commentSections } from "./scope.ts";

export type CommentTarget = {
  objectId: string;
  presentationId: string;
  title: string;
};
export type CommentCall = (
  name: string,
  args: Record<string, unknown>,
) => Promise<unknown>;
type Thread = {
  workspaceId: string;
  revision: number;
  entries: CommentEntry[];
  targetRemoved: boolean;
  targetVersion: number;
  truncated: boolean;
};

export function CommentThread({
  target,
  workspaceId,
  revision,
  call,
  close,
  refreshCounts,
}: {
  target: CommentTarget;
  workspaceId: string;
  revision: number;
  call: CommentCall;
  close: () => void;
  refreshCounts: () => void;
}) {
  const { objectId, presentationId, title } = target;
  const [thread, setThread] = useState<Thread>();
  const [body, setBody] = useState("");
  const [local, setLocal] = useState(false);
  const [replyId, setReplyId] = useState<string>();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const lock = useRef(false);
  const invoke = useRef(call);
  invoke.current = call;
  useEffect(() => {
    let active = true;
    void invoke
      .current("app_comments", {
        action: "thread",
        workspaceId,
        objectId,
        presentationId,
      })
      .then((result) => {
        const next = result as Thread;
        if (
          active &&
          next.workspaceId === workspaceId &&
          next.revision >= revision
        )
          setThread(next);
      })
      .catch((reason: unknown) => {
        if (active)
          setError(reason instanceof Error ? reason.message : "无法读取评论。");
      });
    return () => {
      active = false;
    };
  }, [workspaceId, objectId, presentationId, revision, refresh]);
  const entries = thread?.entries ?? [];
  const { current, removedPlacements } = commentSections(
    entries,
    presentationId,
  );
  const reply = replyId
    ? entries.find((item) => item.id === replyId && !item.threadRemoved)
    : undefined;
  const canWrite = thread && !thread.targetRemoved;

  async function edit(commands: Command[]) {
    if (lock.current || !canWrite) return false;
    lock.current = true;
    setPending(true);
    setError("");
    try {
      await call("app_edit", { workspaceId, commands });
      setRefresh((value) => value + 1);
      refreshCounts();
      return true;
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "评论未保存，请重试。",
      );
      return false;
    } finally {
      lock.current = false;
      setPending(false);
    }
  }

  async function post() {
    if (!thread || !body.trim() || (replyId && !reply)) return;
    const saved = await edit([
      {
        op: "object.create",
        ref: "comment",
        type: "base.comment",
        title: "评论",
        data: { body: body.trim() },
      },
      {
        op: "relation.create",
        sourceId: "@comment",
        kind: reply ? "base.reply_to" : "base.comments_on",
        targetId: reply?.id ?? objectId,
        expectedTargetVersion: reply?.version ?? thread.targetVersion,
        ...(!reply && local
          ? { attributes: { scope: "presentation", presentationId } }
          : {}),
      },
    ]);
    if (saved) {
      setBody("");
      setReplyId(undefined);
    }
  }

  function item(entry: CommentEntry) {
    const time = new Date(entry.createdAt);
    return (
      <article
        key={entry.id}
        className={entry.parentId ? "comment-reply" : undefined}
      >
        <small>
          {entry.scope === "object" ? "共享" : "仅此处"} ·{" "}
          {entry.createdBy === "human" ? "人" : `Agent · ${entry.createdBy}`} ·{" "}
          <time dateTime={time.toISOString()}>{time.toLocaleString()}</time>
          {entry.originalRemoved && " · 原展示已移除"}
          {entry.threadRemoved && " · 原讨论已移除"}
          {entry.resolved && " · 已解决"}
        </small>
        <p>{entry.body}</p>
        {canWrite && (
          <div>
            {!entry.threadRemoved && (
              <button
                type="button"
                disabled={pending}
                onClick={() => setReplyId(entry.id)}
              >
                回复
              </button>
            )}
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                void edit([
                  {
                    op: "object.update",
                    id: entry.id,
                    expectedVersion: entry.version,
                    set: { resolved: !entry.resolved },
                  },
                ])
              }
            >
              {entry.resolved ? "重新打开" : "标记已解决"}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                void edit([
                  {
                    op: "object.delete",
                    id: entry.id,
                    expectedVersion: entry.version,
                  },
                ])
              }
            >
              删除评论
            </button>
          </div>
        )}
      </article>
    );
  }

  return (
    <aside
      className="comment-thread"
      role="dialog"
      aria-label={`评论 · ${title}`}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          close();
        }
      }}
    >
      <header>
        <strong>评论 · {title}</strong>
        <button type="button" autoFocus onClick={close}>
          关闭评论
        </button>
      </header>
      {error && <p role="alert">{error}</p>}
      {!thread && !error && <p role="status">正在读取评论…</p>}
      {thread && !current.length && <p>暂无评论</p>}
      {thread?.targetRemoved && <p role="status">原对象已移除。</p>}
      {thread?.truncated && <p role="status">当前显示前 200 条评论。</p>}
      {current.map(item)}
      {removedPlacements.length > 0 && (
        <details>
          <summary>其他位置的批注</summary>
          {removedPlacements.map(item)}
        </details>
      )}
      {canWrite && (
        <div>
          {replyId && (
            <p>
              {reply ? `回复 ${reply.body.slice(0, 50)}` : "原评论已移除。"}{" "}
              <button type="button" onClick={() => setReplyId(undefined)}>
                取消回复
              </button>
            </p>
          )}
          <textarea
            aria-label="评论正文"
            rows={3}
            maxLength={20000}
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
          {!replyId && (
            <label>
              <input
                type="checkbox"
                checked={local}
                onChange={(event) => setLocal(event.target.checked)}
              />
              仅此处
            </label>
          )}
          <button
            type="button"
            disabled={pending || !body.trim() || Boolean(replyId && !reply)}
            onClick={() => void post()}
          >
            {replyId ? "发送回复" : "发布评论"}
          </button>
        </div>
      )}
    </aside>
  );
}
