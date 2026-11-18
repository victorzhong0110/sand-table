import { useEffect, useRef, useState } from "react";
import { resolveBridge } from "../../core/host-bridge.ts";
import { resultData } from "../data-client/results.ts";
import type {
  ResourceOpen,
  ResourceRead,
  ResourceRequest,
  ResourceRoute,
} from "../../resources/types.ts";

export function ResourceReference({
  objectId,
  objectVersion,
  workspaceId,
  call,
  onOpen,
}: {
  objectId: string;
  objectVersion: number;
  workspaceId: string;
  call: (name: string, args?: Record<string, unknown>) => Promise<unknown>;
  onOpen: (route: ResourceRoute) => void | Promise<void>;
}) {
  const [value, setValue] = useState<ResourceRead>();
  const [error, setError] = useState("");
  const [opening, setOpening] = useState(false);
  const epoch = useRef(0);
  const callRef = useRef(call);
  callRef.current = call;
  async function request(action: ResourceRequest["action"]) {
    const args: ResourceRequest = {
      objectId,
      expectedVersion: objectVersion,
      workspaceId,
      action,
    };
    const bridge = resolveBridge(window);
    const result = bridge.resourceRequest
      ? await bridge.resourceRequest(args)
      : await callRef.current("app_resource", args);
    const payload = (resultData(result) ?? result) as {
      workspaceId?: string;
      objectId?: string;
      objectVersion?: number;
      value?: ResourceRead | ResourceOpen;
    };
    if (
      payload?.workspaceId !== workspaceId ||
      payload.objectId !== objectId ||
      payload.objectVersion !== objectVersion ||
      !payload.value
    )
      throw Error("资源响应不属于当前引用，请刷新后重试。");
    return payload.value;
  }
  useEffect(() => {
    const current = ++epoch.current;
    let loading = false;
    setValue(undefined);
    setError("");
    setOpening(false);
    const refresh = async () => {
      if (loading) return;
      loading = true;
      try {
        const result = (await request("read")) as ResourceRead;
        if (current === epoch.current) {
          setValue(result);
          setError("");
        }
      } catch (failure) {
        if (current === epoch.current) setError(String(failure));
      } finally {
        loading = false;
      }
    };
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 5000);
    return () => {
      epoch.current++;
      clearInterval(timer);
    };
  }, [objectId, objectVersion, workspaceId]);
  return (
    <section className="resource-preview nodrag nopan" aria-label="资源预览">
      {error ? (
        <p role="status">{error}</p>
      ) : value?.status === "available" ? (
        <>
          <p>{value.summary}</p>
          <small>原资源版本：{value.revision} · 正文由原插件管理</small>
          <p>
            {value.capabilities.edit
              ? "原插件支持编辑；请在原资源中修改。"
              : "原插件提供只读内容。"}
          </p>
          <button
            type="button"
            disabled={!value.capabilities.open || opening}
            onClick={async (event) => {
              event.stopPropagation();
              const current = epoch.current;
              setOpening(true);
              try {
                const result = (await request("open")) as ResourceOpen;
                if (current !== epoch.current) return;
                if (result.status === "available") await onOpen(result.route);
                else setError(result.reason);
              } catch (failure) {
                if (current === epoch.current) setError(String(failure));
              } finally {
                if (current === epoch.current) setOpening(false);
              }
            }}
          >
            {opening ? "正在打开…" : "打开原资源"}
          </button>
        </>
      ) : (
        <p role="status">{value?.reason ?? "正在读取资源…"}</p>
      )}
    </section>
  );
}
