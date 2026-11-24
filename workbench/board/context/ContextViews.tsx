import type { ComponentProps } from "react";
import { useViewModule } from "../runtime/resources.ts";
import type * as Views from "./ContextPanel.tsx";

export function ContextPanel(props: ComponentProps<typeof Views.ContextPanel>) {
  const { loaded, error } = useViewModule("context-views");
  if (error && props.onPlace) return <p role="alert">{error}</p>;
  return loaded ? <loaded.ContextPanel {...props} /> : null;
}

export function ParticipantContexts(
  props: ComponentProps<typeof Views.ParticipantContexts>,
) {
  const { loaded, error } = useViewModule("context-views");
  if (error) return <p role="alert">{error}</p>;
  return loaded ? <loaded.ParticipantContexts {...props} /> : null;
}
