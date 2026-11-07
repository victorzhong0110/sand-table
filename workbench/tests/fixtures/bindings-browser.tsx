import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { V3Store } from "../../board/data-client/store.ts";
import { CustomView } from "../../board/views/CustomView.tsx";
import {
  customViews,
  ViewRuntimeContext,
  type ViewProps,
} from "../../board/views/registry.tsx";
import type { TypeSpecView } from "../../board/views/format.ts";

declare global {
  interface Window {
    startBindingFixture: (input: {
      token: string;
      workspaceId: string;
      boardId: string;
      readerId: string;
      presentationId: string;
      spec: TypeSpecView;
    }) => Promise<void>;
  }
}
function Probe({ bindings }: ViewProps) {
  const [value, setValue] = useState("正在读取");
  useEffect(() => {
    let active = true;
    const refresh = () =>
      void bindings
        .read("source")
        .then((result) => {
          if (active) setValue(String(result.items[0]?.data.value ?? "无"));
        })
        .catch((error) => {
          if (active) setValue(String(error));
        });
    const unsubscribe = bindings.subscribe("source", refresh);
    refresh();
    return () => {
      active = false;
      unsubscribe();
    };
  }, [bindings]);
  return <output data-testid="binding-value">{value}</output>;
}
customViews["test.binding"] = Probe;
window.startBindingFixture = async ({
  token,
  workspaceId,
  boardId,
  readerId,
  presentationId,
  spec,
}) => {
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await fetch("/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sand-Token": token },
      body: JSON.stringify({
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    const result = await response.json();
    if (!response.ok || result.isError) throw Error(JSON.stringify(result));
    return result._meta?.data ?? result.structuredContent?.data;
  };
  const store = new V3Store(call);
  await store.load(boardId, { workspaceId });
  createRoot(document.getElementById("fixture")!).render(
    <ViewRuntimeContext.Provider value={{ store, call }}>
      <CustomView
        objectId={readerId}
        presentationId={presentationId}
        spec={spec}
      />
    </ViewRuntimeContext.Provider>,
  );
  setInterval(() => void store.sync(), 300);
};
