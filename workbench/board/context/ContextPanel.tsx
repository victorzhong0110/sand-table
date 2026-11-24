import { useEffect, useRef, useState } from "react";
import type { QueryRow } from "../../kernel/index.ts";
import { readParticipants, type ContextCall } from "./defaults.ts";

type Page = { rows: QueryRow[]; nextCursor: string | null };

function useContextRead<T>(key: string, load: () => Promise<T>) {
  const [result, setResult] = useState<{
    key: string;
    data?: T;
    error?: string;
  }>();
  const loader = useRef(load);
  loader.current = load;
  useEffect(() => {
    let active = true;
    void loader.current().then(
      (data) => {
        if (active) setResult({ key, data });
      },
      (error) => {
        if (active)
          setResult({
            key,
            error: error instanceof Error ? error.message : String(error),
          });
      },
    );
    return () => {
      active = false;
    };
  }, [key]);
  return result?.key === key ? result : undefined;
}

function PageButtons({
  cursor,
  next,
  onPage,
}: {
  cursor?: string;
  next?: string | null;
  onPage: (cursor?: string) => void;
}) {
  return (
    <>
      {cursor && (
        <button type="button" onClick={() => onPage()}>
          回到第一页
        </button>
      )}
      {next && (
        <button type="button" onClick={() => onPage(next)}>
          下一页
        </button>
      )}
    </>
  );
}

export function ContextPanel({
  workspaceId,
  objectId,
  revision,
  call,
  onClose,
  onPlace,
}: {
  workspaceId: string | undefined;
  objectId: string;
  revision: number;
  call: ContextCall;
  onClose?: () => void;
  onPlace?: (object: QueryRow) => void;
}) {
  const [cursor, setCursor] = useState<string>();
  const result = useContextRead(
    JSON.stringify([workspaceId, objectId, revision, cursor]),
    async () => {
      const participants = await readParticipants(call, workspaceId, objectId);
      const missingParticipants = participants.length < 2;
      const page: Page | undefined =
        !onPlace || missingParticipants
          ? undefined
          : await call("sand_query", {
              boardId: undefined,
              relatedToAll: participants.map(({ id }) => id),
              cursor,
            });
      return { missingParticipants, page };
    },
  );
  const { missingParticipants, page } = result?.data ?? {};
  const problem = result?.error;
  const participantHint = missingParticipants && (
    <p>请添加至少两个参与对象。</p>
  );
  if (!onPlace) return participantHint || null;
  return (
    <aside
      className="studio-inspector is-context"
      aria-label="符合这次交叉的内容"
    >
      <div className="inspector-heading">
        <h2>符合这次交叉的内容</h2>
        <button type="button" onClick={onClose} aria-label="收起交叉建议">
          ×
        </button>
      </div>
      {problem ? (
        <p role="alert">{problem}</p>
      ) : participantHint ? (
        participantHint
      ) : !page ? (
        <p>读取关系…</p>
      ) : (
        <>
          {!page.rows.length && <p>没有同时关联这几方的内容。</p>}
          <ul>
            {page.rows.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  draggable
                  title="拖入白板"
                  onClick={() => onPlace(row)}
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = "copy";
                    event.dataTransfer.setData(
                      "application/x-sand-component",
                      JSON.stringify({
                        objectId: row.id,
                        type: row.type,
                        title: row.title,
                      }),
                    );
                  }}
                >
                  {row.title || "未命名"}
                </button>
                <ul>
                  {row.participantRelations?.map((link) => (
                    <li key={link.participantId}>
                      {link.title || "未命名"} · {link.label}
                      {link.status === "inferred" && "（推测）"}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
          <PageButtons
            cursor={cursor}
            next={page.nextCursor}
            onPage={setCursor}
          />
        </>
      )}
    </aside>
  );
}

export function ParticipantContexts({
  objectId,
  revision,
  call,
  onOpen,
}: {
  objectId: string;
  revision: number;
  call: ContextCall;
  onOpen: (id: string) => void;
}) {
  const [cursor, setCursor] = useState<string>();
  const result = useContextRead<Page>(
    JSON.stringify([objectId, revision, cursor]),
    () =>
      call("sand_query", {
        boardId: undefined,
        types: ["base.context"],
        relatedTo: { id: objectId, kind: "base.involves", direction: "in" },
        cursor,
      }),
  );
  const rows = result?.data?.rows ?? [];
  if (!rows.length && !cursor) return null;
  return (
    <section aria-label="参与的交叉情境">
      <h4>参与的交叉情境</h4>
      <ul>
        {rows.map((row) => (
          <li key={row.id}>
            <button type="button" onClick={() => onOpen(row.id)}>
              {row.title || "未命名"}
            </button>
          </li>
        ))}
      </ul>
      <PageButtons
        cursor={cursor}
        next={result?.data?.nextCursor}
        onPage={setCursor}
      />
    </section>
  );
}
