import type {
  BindingItem,
  BindingsResult,
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
export type BindingSession = Bindings & { dispose(): void };

type Subscription = {
  slot: string;
  callback: () => void;
  ids: Set<string>;
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
  let disposed = false;
  let serial = 0;
  const stale = () => Error("绑定读取结果已过期。请刷新后重试。");
  function valid() {
    return (
      !disposed && Boolean(workspaceId) && store.workspaceId === workspaceId
    );
  }
  async function request(
    action: "read" | "version",
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
      sub.ids = new Set((result.items as BindingItem[]).map((item) => item.id));
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
    for (const sub of subscriptions) {
      const slot = slots.find((item) => item.key === sub.slot);
      const relationChanged = event.relations.some(
        (row) =>
          slot &&
          row.kind === slot.kind &&
          (slot.direction === "out" ? row.sourceId : row.targetId) === objectId,
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
    unsubscribeStore();
  }
  return {
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
