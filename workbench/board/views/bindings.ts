import type {
  BindingItem,
  BindingsResult,
  ExpandedBindings,
  VersionResult,
} from "../../kernel/index.ts";
import type { V3Store, V3Tool } from "../data-client/store.ts";
import type { RelationSlotView } from "./format.ts";

export type BindingOptions = {
  ids?: string[];
  fields?: string[];
  limit?: number;
  cursor?: string;
};
export type Bindings = {
  read(slot: string, opts?: BindingOptions): Promise<BindingsResult>;
  readVersion(
    slot: string,
    id: string,
    version: number,
  ): Promise<VersionResult>;
  subscribe(slot: string, onChange: () => void): () => void;
};
export type BindingSession = Bindings & {
  readGraph(forAction?: boolean): Promise<ExpandedBindings>;
  subscribeGraph(onChange: () => void): () => void;
  dispose(): void;
};

type Subscription = {
  slot: string;
  callback: () => void;
  ids: Set<string>;
  sourceTables: Set<string>;
  complete: boolean;
  token: number;
  key: string;
};

export function createBindings(
  store: V3Store,
  call: V3Tool,
  objectId: string,
  slots: readonly RelationSlotView[],
): BindingSession {
  const workspaceId = store.workspaceId;
  const readerPack = store.cache.objects.get(objectId)?.type.split(".")[0];
  const pending = new Map<string, number>();
  const subscriptions = new Set<Subscription>();
  const graphSubscribers = new Set<() => void>();
  let graphNodes: Set<string> | undefined;
  let disposed = false;
  let serial = 0;
  const stale = () => Error("绑定读取结果已过期。请刷新后重试。");
  function valid() {
    return (
      !disposed && Boolean(workspaceId) && store.workspaceId === workspaceId
    );
  }
  async function request(
    action: "read" | "version" | "expand",
    slot: string,
    options: Record<string, unknown>,
    key: string,
  ) {
    if (!valid()) throw stale();
    const token = ++serial;
    pending.set(key, token);
    try {
      const result = await call("app_bindings", {
        action,
        workspaceId,
        objectId,
        slot,
        ...options,
      });
      if (
        !valid() ||
        pending.get(key) !== token ||
        result?.workspaceId !== workspaceId ||
        typeof result?.revision !== "number" ||
        result.revision < store.cache.revision
      )
        throw stale();
      return result;
    } finally {
      if (pending.get(key) === token) pending.delete(key);
    }
  }
  async function refresh(sub: Subscription) {
    const token = ++sub.token;
    try {
      const result = await request("read", sub.slot, { limit: 200 }, sub.key);
      if (!subscriptions.has(sub) || token !== sub.token) return;
      const items = result.items as BindingItem[];
      sub.ids = new Set(
        items.flatMap((item) => [
          item.id,
          ...(item.tableFilters ?? []).map(({ id }) => id),
          ...(item.tableConsumers ?? []).map(({ id }) => id),
          ...(item.chartScopes ?? []).map(({ id }) => id),
        ]),
      );
      sub.sourceTables = new Set(
        items
          .filter((item) => item.tableFilters || item.tableConsumers)
          .map(({ id }) => id),
      );
      sub.complete = !result.nextCursor;
    } catch {
      if (subscriptions.has(sub)) sub.complete = false;
    }
  }
  const unsubscribeStore = store.subscribeChanges((event) => {
    if (event.workspaceId !== workspaceId) {
      dispose();
      return;
    }
    if (
      readerPack &&
      event.packs.some(
        (pack) => pack.id === readerPack && (!pack.enabled || pack.deleted),
      )
    ) {
      dispose();
      return;
    }
    if (
      graphSubscribers.size &&
      (event.reset ||
        event.packs.length ||
        event.objects.some(
          ({ id }) => id === objectId || !graphNodes || graphNodes.has(id),
        ) ||
        event.relations.some(
          ({ sourceId, targetId }) =>
            sourceId === objectId ||
            !graphNodes ||
            graphNodes.has(sourceId) ||
            graphNodes.has(targetId),
        ))
    )
      for (const callback of graphSubscribers) callback();
    for (const sub of subscriptions) {
      const slot = slots.find((item) => item.key === sub.slot);
      const relationChanged = event.relations.some(
        (row) =>
          (slot &&
            row.kind === slot.kind &&
            (slot.direction === "out" ? row.sourceId : row.targetId) ===
              objectId) ||
          (row.kind === "base.filters" &&
            (sub.sourceTables.has(row.targetId) ||
              (sub.slot === "source" && row.targetId === objectId))) ||
          (row.kind === "base.data_source" &&
            (sub.sourceTables.has(row.targetId) ||
              (["source", "highlights", "highlightedBy"].includes(sub.slot) &&
                sub.ids.has(row.sourceId)))),
      );
      const objectChanged = event.objects.some(
        (row) => row.id === objectId || sub.ids.has(row.id) || !sub.complete,
      );
      if (
        event.reset ||
        event.packs.length ||
        relationChanged ||
        objectChanged
      ) {
        sub.token++;
        sub.complete = false;
        try {
          sub.callback();
        } catch {
          /* 单个视图不能中断其他视图的同步 */
        }
        void refresh(sub);
      }
    }
  });
  function dispose() {
    if (disposed) return;
    disposed = true;
    pending.clear();
    subscriptions.clear();
    graphSubscribers.clear();
    graphNodes = undefined;
    unsubscribeStore();
  }
  return {
    async readGraph(forAction = false) {
      const result: ExpandedBindings = await request(
        "expand",
        "focus",
        {},
        forAction ? "graph-action" : "graph",
      );
      if (!forAction) graphNodes = new Set(result.nodes.map(({ id }) => id));
      return result;
    },
    subscribeGraph(callback) {
      if (!valid()) return () => {};
      graphSubscribers.add(callback);
      return () => {
        graphSubscribers.delete(callback);
        if (!graphSubscribers.size) graphNodes = undefined;
      };
    },
    async read(slot, opts = {}) {
      const result = await request("read", slot, opts, `read:${slot}`);
      return {
        revision: result.revision,
        items: result.items,
        nextCursor: result.nextCursor,
      };
    },
    async readVersion(slot, id, version) {
      const result = await request(
        "version",
        slot,
        { targetId: id, version },
        `version:${slot}:${id}`,
      );
      return result.ok
        ? { revision: result.revision, ok: true, row: result.row }
        : { revision: result.revision, ok: false, reason: result.reason };
    },
    subscribe(slot, callback) {
      if (!valid()) return () => {};
      const sub: Subscription = {
        slot,
        callback,
        ids: new Set(),
        sourceTables: new Set(),
        complete: false,
        token: 0,
        key: `subscription:${++serial}`,
      };
      subscriptions.add(sub);
      void refresh(sub);
      return () => {
        sub.token++;
        subscriptions.delete(sub);
      };
    },
    dispose,
  };
}
