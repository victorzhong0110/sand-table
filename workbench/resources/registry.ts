import { isResourceRef } from "../kernel/index.ts";
import type {
  ResourceProvider,
  ResourceRef,
  ResourceRead,
  ResourceOpen,
  ResourceEdit,
  ResourceRestore,
  Unavailable,
} from "./types.ts";

const keyOf = (ref: { providerId: string; namespace: string }) =>
  JSON.stringify([ref.providerId, ref.namespace]);
const unavailable = (
  ref: ResourceRef,
  status: Unavailable["status"],
  reason: string,
): Unavailable => ({ ref, status, reason });

/** 能力注册表不保存资源、预览或操作历史。 */
export function createResourceRegistry() {
  const providers = new Map<string, { provider: ResourceProvider }>();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const fn of listeners) fn();
  };
  function find(ref: ResourceRef) {
    if (!isResourceRef(ref)) throw Error("资源引用格式不对，请重新选择资源。");
    return providers.get(keyOf(ref));
  }
  async function invoke<T extends { status: string; ref: ResourceRef }>(
    ref: ResourceRef,
    run: (provider: ResourceProvider) => T | Promise<T>,
    options: { revisionMayChange?: boolean; propagateErrors?: boolean } = {},
  ): Promise<T | Unavailable> {
    const provider = find(ref);
    if (!provider)
      return unavailable(
        ref,
        "provider_missing",
        "资源插件尚未加载。请启用原插件；引用和本地说明仍保留。",
      );
    try {
      const result = await run(provider.provider);
      if (find(ref) !== provider)
        return unavailable(ref, "disconnected", "资源插件已切换，请重新读取。");
      if (
        ![
          "available",
          "provider_missing",
          "not_found",
          "version_unavailable",
          "unsupported",
          "disconnected",
          "forbidden",
        ].includes(result.status)
      )
        return unavailable(
          ref,
          "unsupported",
          "资源插件返回了未知状态，请更新原插件。",
        );
      if (result.status === "available") {
        const resolved = result as T & { revision?: string };
        if (
          keyOf(result.ref) !== keyOf(ref) ||
          result.ref.resourceId !== ref.resourceId ||
          result.ref.anchor !== ref.anchor
        )
          return unavailable(
            ref,
            "forbidden",
            "资源插件返回了其他资源，已拒绝显示。",
          );
        if (
          !isResourceRef({ ...ref, revision: resolved.revision }) ||
          (result.ref.revision !== undefined &&
            result.ref.revision !== resolved.revision) ||
          (!options.revisionMayChange &&
            ref.revision !== undefined &&
            resolved.revision !== ref.revision)
        )
          return unavailable(
            ref,
            "version_unavailable",
            "资源插件没有返回指定版本，请保留引用并检查原资源。",
          );
      }
      return result;
    } catch (error) {
      if (options.propagateErrors) throw error;
      return unavailable(
        ref,
        "disconnected",
        "无法连接资源插件，请检查插件状态后重试读取。",
      );
    }
  }
  const registry = {
    register(provider: ResourceProvider) {
      const description = provider.describe();
      if (
        !isResourceRef({
          providerId: description.providerId,
          namespace: description.namespace,
          resourceId: "probe",
        })
      )
        throw Error("资源提供者身份格式不对。");
      const key = keyOf(description);
      if (providers.has(key))
        throw Error("这个命名空间已有资源提供者，请先停用原实例。");
      const entry = { provider };
      providers.set(key, entry);
      notify();
      return () => {
        if (providers.get(key) !== entry) return;
        providers.delete(key);
        notify();
      };
    },
    describe(ref: ResourceRef) {
      return find(ref)?.provider.describe();
    },
    read(ref: ResourceRef, signal?: AbortSignal): Promise<ResourceRead> {
      return invoke(ref, async (provider) => {
        const result = await provider.read(ref, signal);
        if (result.status !== "available") return result;
        if (
          typeof result.title !== "string" ||
          typeof result.summary !== "string"
        )
          return unavailable(
            ref,
            "unsupported",
            "资源插件没有返回可显示的摘要，请在原应用中查看。",
          );
        return {
          ...result,
          title: result.title.slice(0, 200),
          summary: result.summary.slice(0, 1000),
          capabilities: provider.describe().capabilities,
        };
      });
    },
    open(ref: ResourceRef, signal?: AbortSignal): Promise<ResourceOpen> {
      return invoke(ref, async (provider) => {
        if (!provider.open)
          return unavailable(
            ref,
            "unsupported",
            "原插件不支持打开资源，请在原应用中查看。",
          );
        const result = await provider.open(ref, signal);
        if (
          result.status === "available" &&
          !["url", "board-object"].includes(result.route.kind)
        )
          return unavailable(
            ref,
            "unsupported",
            "资源插件没有提供受支持的打开方式。",
          );
        if (result.status === "available" && result.route.kind === "url") {
          const url = new URL(result.route.url);
          if (
            !["https:", "http:"].includes(url.protocol) ||
            url.username ||
            url.password
          )
            return unavailable(
              ref,
              "forbidden",
              "资源插件返回的打开地址不受支持。",
            );
        }
        return result;
      });
    },
    edit(ref: ResourceRef, request: ResourceEdit): Promise<ResourceRead> {
      if (
        ref.revision !== undefined &&
        ref.revision !== request.expectedRevision
      )
        return Promise.resolve(
          unavailable(
            ref,
            "version_unavailable",
            "编辑版本与固定引用不一致，请重新读取并确认。",
          ),
        );
      return invoke(
        ref,
        (provider) =>
          provider.edit
            ? provider.edit(ref, request)
            : unavailable(
                ref,
                "unsupported",
                "原插件不支持编辑，请在原应用中修改。",
              ),
        { revisionMayChange: true, propagateErrors: true },
      );
    },
    export(ref: ResourceRef) {
      return invoke(ref, (provider) =>
        provider.export
          ? provider.export(ref)
          : unavailable(ref, "unsupported", "原插件不支持导出这个资源。"),
      );
    },
    restorer(ref: ResourceRef): ResourceRestore | undefined {
      const original = find(ref);
      const alternatives = [...providers.values()].filter(
        ({ provider }) =>
          provider.describe().providerId === ref.providerId &&
          typeof provider.restore === "function",
      );
      const entry = original?.provider.restore
        ? original
        : alternatives.length === 1
          ? alternatives[0]
          : undefined;
      if (!entry?.provider.restore) return;
      const description = entry.provider.describe();
      return async (file, owner, signal) => {
        if (providers.get(keyOf(description)) !== entry)
          throw Error("导入期间资源插件已停用，请重新启用后导入。");
        const result = await entry.provider.restore!(file, owner, signal);
        if (
          isResourceRef(result.ref) &&
          keyOf(result.ref) === keyOf(ref) &&
          result.ref.resourceId === ref.resourceId
        )
          throw Error("资源插件返回了原对象，请检查独立副本支持。");
        if (
          !isResourceRef(result.ref) ||
          keyOf(result.ref) !== keyOf(description) ||
          !result.ref.revision ||
          result.ref.anchor ||
          providers.get(keyOf(description)) !== entry
        ) {
          await result.discard();
          throw Error("原插件没有返回有效的独立资源引用。");
        }
        return result;
      };
    },
    watch(ref: ResourceRef, listener: (value: ResourceRead) => void) {
      find(ref);
      let disposed = false,
        generation = 0;
      let unsubscribe: (() => void) | undefined;
      let controller: AbortController | undefined;
      const refresh = async () => {
        const current = ++generation;
        controller?.abort();
        controller = new AbortController();
        const value = await registry.read(ref, controller.signal);
        if (!disposed && current === generation) listener(value);
      };
      const attach = () => {
        unsubscribe?.();
        unsubscribe = undefined;
        const provider = find(ref);
        try {
          if (provider?.provider.subscribe)
            unsubscribe = provider.provider.subscribe(
              ref,
              () => void refresh(),
            );
        } catch {
          generation++;
          controller?.abort();
          if (!disposed)
            listener(
              unavailable(
                ref,
                "disconnected",
                "资源变更订阅失败，请重新加载原插件。",
              ),
            );
          return;
        }
        void refresh();
      };
      listeners.add(attach);
      attach();
      return () => {
        disposed = true;
        generation++;
        controller?.abort();
        unsubscribe?.();
        listeners.delete(attach);
      };
    },
    dispose() {
      providers.clear();
      notify();
      listeners.clear();
    },
  };
  return registry;
}
export type ResourceRegistry = ReturnType<typeof createResourceRegistry>;

export function registerResourceEffect(
  ctx: { effect: (fn: () => () => void, label?: string) => unknown },
  registry: ResourceRegistry,
  provider: ResourceProvider,
) {
  return ctx.effect(
    () => registry.register(provider),
    "sand-table: resource provider",
  );
}
