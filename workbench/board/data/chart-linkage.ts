import { useEffect, useState } from "react";
import type { Bindings } from "../views/bindings.ts";

type Focus = {
  workspace: string;
  chart: string;
  presentation: string;
  table: string;
  keys: string[];
};
const events = new EventTarget();

export function signalChartFocus(detail: Focus) {
  events.dispatchEvent(new CustomEvent("chart-focus", { detail }));
}

export function useLinkedChartFocus(
  bindings: Bindings,
  workspace: string,
  table?: string,
) {
  const [received, setReceived] = useState<string[]>([]);
  const [unmatched, setUnmatched] = useState(false);
  useEffect(() => {
    setReceived([]);
    setUnmatched(false);
    let active = true;
    let serial = 0;
    let peers = new Set<string>();
    const signals = new Map<string, Focus>();
    const publish = () =>
      setReceived([
        ...new Set([...signals.values()].flatMap(({ keys }) => keys)),
      ]);
    const refresh = async () => {
      const token = ++serial;
      try {
        const results = await Promise.all(
          ["highlights", "highlightedBy"].map((slot) =>
            bindings.read(slot, { fields: [], limit: 200 }),
          ),
        );
        if (!active || token !== serial) return;
        const items = results.flatMap(({ items }) => items);
        peers = new Set(
          items
            .filter((item) => table && item.tableSource === table)
            .map(({ id }) => id),
        );
        setUnmatched(items.some(({ id }) => !peers.has(id)));
        for (const [id, signal] of signals)
          if (!peers.has(signal.chart)) signals.delete(id);
        publish();
      } catch {
        if (!active || token !== serial) return;
        peers.clear();
        signals.clear();
        publish();
      }
    };
    const listener = (event: Event) => {
      const signal = (event as CustomEvent<Focus>).detail;
      if (
        signal.workspace !== workspace ||
        signal.table !== table ||
        !peers.has(signal.chart)
      )
        return;
      if (signal.keys.length) signals.set(signal.presentation, signal);
      else signals.delete(signal.presentation);
      publish();
    };
    events.addEventListener("chart-focus", listener);
    const stop = ["highlights", "highlightedBy"].map((slot) =>
      bindings.subscribe(slot, () => void refresh()),
    );
    void refresh();
    return () => {
      active = false;
      stop.forEach((unsubscribe) => unsubscribe());
      events.removeEventListener("chart-focus", listener);
    };
  }, [bindings, workspace, table]);
  return { received, unmatched };
}
