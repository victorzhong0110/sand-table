import { useEffect, useState } from "react";
import type { RelationSlotView } from "./format.ts";

export type SlotLink = { id: string; otherId: string; title: string };

export function RelationSlots({
  slots,
  linksBySlot,
  readOnly,
  selfId,
  call,
  onChange,
}: {
  slots: RelationSlotView[];
  linksBySlot: Record<string, SlotLink[]>;
  readOnly: boolean;
  selfId: string;
  call: (name: string, args?: Record<string, unknown>) => Promise<any>;
  onChange: (change: {
    removeIds: string[];
    create?: { kind: string; sourceId: string; targetId: string };
  }) => void;
}) {
  if (!slots.length) return null;
  return (
    <section className="relation-slots">
      {slots.map((slot) => (
        <SlotRow
          key={slot.key}
          slot={slot}
          links={linksBySlot[slot.key] ?? []}
          readOnly={readOnly}
          selfId={selfId}
          call={call}
          onChange={onChange}
        />
      ))}
    </section>
  );
}

function SlotRow({
  slot,
  links,
  readOnly,
  selfId,
  call,
  onChange,
}: {
  slot: RelationSlotView;
  links: SlotLink[];
  readOnly: boolean;
  selfId: string;
  call: (name: string, args?: Record<string, unknown>) => Promise<any>;
  onChange: (change: {
    removeIds: string[];
    create?: { kind: string; sourceId: string; targetId: string };
  }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<{ id: string; title: string }[]>([]);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void call("sand_query", {
        text: query,
        ...(slot.targetTypes?.length ? { types: slot.targetTypes } : {}),
        limit: 8,
      })
        .then((data) => {
          if (cancelled) return;
          const rows = Array.isArray(data?.rows) ? data.rows : [];
          setHits(
            rows
              .filter(
                (row: { id?: string }) =>
                  row?.id &&
                  row.id !== selfId &&
                  !links.some((link) => link.otherId === row.id),
              )
              .map((row: { id: string; title?: string }) => ({
                id: row.id,
                title: row.title || "未命名",
              })),
          );
        })
        .catch(() => {
          if (!cancelled) setHits([]);
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, query, call, selfId, slot.targetTypes, links]);
  const choose = (otherId: string) => {
    const sourceId = slot.direction === "out" ? selfId : otherId;
    const targetId = slot.direction === "out" ? otherId : selfId;
    onChange({
      removeIds: slot.many ? [] : links.map((link) => link.id),
      create: { kind: slot.kind, sourceId, targetId },
    });
    setOpen(false);
    setQuery("");
  };
  return (
    <div className="relation-slot">
      <span>{slot.label}</span>
      <ul>
        {links.map((link) => (
          <li key={link.id}>
            {link.title}
            {!readOnly && (
              <button
                type="button"
                aria-label={`移除${slot.label} ${link.title}`}
                onClick={() => onChange({ removeIds: [link.id] })}
              >
                ×
              </button>
            )}
          </li>
        ))}
      </ul>
      {!readOnly && (
        <button
          type="button"
          aria-label={`添加${slot.label}`}
          onClick={() => setOpen((value) => !value)}
        >
          +
        </button>
      )}
      {open && (
        <div className="slot-search">
          <input
            aria-label={`搜索${slot.label}`}
            value={query}
            placeholder="搜索对象"
            onChange={(event) => setQuery(event.target.value)}
          />
          <ul>
            {hits.map((hit) => (
              <li key={hit.id}>
                <button type="button" onClick={() => choose(hit.id)}>
                  {hit.title}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
