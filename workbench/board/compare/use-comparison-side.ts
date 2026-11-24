import { useEffect, useState } from "react";
import type { BindingItem } from "../../kernel/index.ts";
import type { Bindings } from "../views/bindings.ts";

type Side = {
  entry?: BindingItem;
  reading: boolean;
  error?: string;
};

export function useComparisonSide(
  bindings: Bindings,
  slot: "left" | "right",
  pinned?: number,
): Side {
  const [side, setSide] = useState<Side>({ reading: true });
  useEffect(() => {
    let active = true;
    let serial = 0;
    setSide({ reading: true });
    const refresh = async () => {
      const request = ++serial;
      const complete = (result: Omit<Side, "reading">) => {
        if (active && request === serial)
          setSide({ ...result, reading: false });
      };
      try {
        const { items, nextCursor } = await bindings.read(slot, { limit: 1 });
        const entry = items[0];
        if (nextCursor) {
          complete({ error: "这一侧绑定了多个对象，请保留一个。" });
          return;
        }
        if (
          !entry ||
          entry.unavailable ||
          entry.migrationError ||
          pinned === undefined
        ) {
          complete({
            entry,
            error: entry?.unavailable ?? entry?.migrationError,
          });
          return;
        }
        const historical = await bindings.readVersion(slot, entry.id, pinned);
        if (!historical.ok) {
          complete({ entry, error: historical.reason });
          return;
        }
        complete({ entry: historical.row });
      } catch (reason) {
        complete({
          error:
            reason instanceof Error ? reason.message : "暂时无法读取来源。",
        });
      }
    };
    const stop = bindings.subscribe(slot, () => void refresh());
    void refresh();
    return () => {
      active = false;
      stop();
    };
  }, [bindings, slot, pinned]);
  return side;
}
