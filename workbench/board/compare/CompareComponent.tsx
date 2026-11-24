import { useViewModule } from "../runtime/resources.ts";
import { useViewRuntime, type ViewProps } from "../views/registry.tsx";

export function CompareComponent(props: ViewProps) {
  const { loaded, error } = useViewModule("compare");
  const call = useViewRuntime()?.call;
  return loaded ? (
    <loaded.CompareView {...props} call={call} />
  ) : (
    <p role="status">{error || "正在加载比较…"}</p>
  );
}
