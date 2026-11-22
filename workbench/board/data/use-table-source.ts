import { useEffect, useMemo, useState } from "react";
import type { BindingItem } from "../../kernel/index.ts";
import type { Bindings } from "../views/bindings.ts";
import { deriveTable, tableViewOf, type TableFilter } from "./derive-table.ts";
import { tableOf, type Cell } from "./table-model.ts";

export function useBoundTables(
  bindings: Bindings,
  slot: "source" | "self" | "targets",
) {
  const [items, setItems] = useState<BindingItem[]>([]);
  const [reading, setReading] = useState(true);
  const [bindingError, setBindingError] = useState("");
  useEffect(() => {
    let serial = 0,
      active = true;
    async function refresh() {
      const current = ++serial;
      try {
        const { items } = await bindings.read(
          slot,
          slot === "self" ? { fields: [] } : { limit: 200 },
        );
        if (!active || current !== serial) return;
        setItems(items);
        const item = slot === "targets" ? undefined : items[0];
        setBindingError(
          item?.migrationError ||
            (item?.unavailable
              ? /已删除|被删除/.test(item.unavailable)
                ? "绑定的表格已删除。"
                : item.unavailable
              : ""),
        );
      } catch (error) {
        if (!active || current !== serial) return;
        setBindingError(
          error instanceof Error ? error.message : "暂时读取不到源表格。",
        );
      } finally {
        if (active && current === serial) setReading(false);
      }
    }
    const stop = bindings.subscribe(slot, () => void refresh());
    void refresh();
    return () => {
      active = false;
      stop();
    };
  }, [bindings, slot]);

  return { items, reading, error: bindingError };
}

export function useConnectedFilters(item?: BindingItem): TableFilter[] {
  return useMemo(
    () =>
      (item?.tableFilters ?? []).flatMap(({ data }) => {
        const op = (
          [
            "eq",
            "contains",
            "gt",
            "lt",
            "between",
            "empty",
            "not_empty",
          ] as const
        ).find((value) => value === data.op);
        if (!op || typeof data.column !== "string") return [];
        if (op !== "empty" && op !== "not_empty" && data.value === undefined)
          return [];
        return [
          {
            column: data.column,
            op,
            value: data.value as Cell | undefined,
            upper: data.upper as Cell | undefined,
          },
        ];
      }),
    [item],
  );
}

export function useDerivedTableSource(bindings: Bindings) {
  const { items, reading, error } = useBoundTables(bindings, "source");
  const source = items[0];
  const filters = useConnectedFilters(source);
  const table = useMemo(() => {
    if (!source || source.unavailable || source.migrationError)
      return undefined;
    const derived = deriveTable(
      tableOf(source.data),
      tableViewOf(source.data),
      filters,
    );
    const scopes = (source.chartScopes ?? []).flatMap(({ keys }) =>
      keys ? [new Set(keys)] : [],
    );
    if (!scopes.length) return derived;
    return {
      ...derived,
      rows: derived.rows.filter(({ key }) =>
        scopes.every((keys) => keys.has(key)),
      ),
    };
  }, [source, filters]);
  return { source, table, filters, reading, error };
}
