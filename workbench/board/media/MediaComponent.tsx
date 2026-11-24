import { useViewModule } from "../runtime/resources.ts";
import { useViewRuntime, type ViewProps } from "../views/registry.tsx";
import type { ComponentProps } from "react";
import type * as Views from "./MediaView.tsx";

export function CoverEditor(props: ComponentProps<typeof Views.CoverEditor>) {
  const { loaded, error } = useViewModule("media-views");
  return loaded ? (
    <loaded.CoverEditor {...props} />
  ) : error ? (
    <p role="alert">{error}</p>
  ) : null;
}

export function CroppedCover(props: ComponentProps<typeof Views.CroppedImage>) {
  const { loaded } = useViewModule("media-views");
  return loaded ? <loaded.CroppedImage {...props} /> : null;
}

export function MediaComponent(props: ViewProps) {
  const { loaded, error } = useViewModule("media-views");
  const runtime = useViewRuntime();
  return loaded && runtime ? (
    <loaded.MediaView
      key={JSON.stringify([
        props.workspaceId,
        props.object.data.blob,
        props.object.data.mime,
      ])}
      {...props}
      call={runtime.call}
      downloadFile={runtime.downloadFile}
      openLink={runtime.openLink}
    />
  ) : (
    <p role="status">{error || "正在加载媒体…"}</p>
  );
}

export function LinkComponent(props: ViewProps) {
  const { loaded, error } = useViewModule("media-views");
  const openLink = useViewRuntime()?.openLink;
  return loaded ? (
    <loaded.LinkView href={props.object.data.url} openLink={openLink} />
  ) : (
    <p role="status">{error || "正在加载链接…"}</p>
  );
}
