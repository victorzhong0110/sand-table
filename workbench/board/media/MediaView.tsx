import { useEffect, useRef, useState } from "react";
import type { MediaCrop } from "../../kernel/index.ts";
import type { V3Tool } from "../data-client/store.ts";
import { safeUrl } from "../data-client/spaces.ts";
import { imageDataUrl } from "../views/format.ts";
import type { ViewProps } from "../views/registry.tsx";
import { ImageView } from "./ImageView.tsx";
import type { DownloadFile } from "./host.ts";

export { CroppedImage, CoverEditor } from "./CoverEditor.tsx";

const ATTACHMENT_MISSING = "附件缺失";

export function LinkView({
  href,
  openLink,
}: {
  href: unknown;
  openLink?: (url: string) => void;
}) {
  const url = safeUrl(href);
  return url ? (
    <button
      type="button"
      className="nodrag nopan"
      title="打开链接"
      disabled={!openLink}
      onClick={() => openLink?.(url)}
    >
      {new URL(url).hostname}
    </button>
  ) : (
    <p>链接不可用</p>
  );
}

export function MediaView({
  object,
  workspaceId,
  readOnly,
  dispatch,
  call,
  downloadFile,
  openLink,
}: ViewProps & {
  call: V3Tool;
  downloadFile?: DownloadFile;
  openLink?: (url: string) => void;
}) {
  const { data } = object;
  const sha256 = typeof data.blob === "string" ? data.blob : "";
  const mime =
    typeof data.mime === "string" && /^[\w.+-]+\/[\w.+-]+$/.test(data.mime)
      ? data.mime.toLowerCase()
      : "application/octet-stream";
  const [asset, setAsset] = useState<{ base64: string; bytes: number }>();
  const [readFailed, setReadFailed] = useState(false);
  const [problem, setProblem] = useState("");
  const read = useRef(call);
  read.current = call;
  useEffect(() => {
    if (!sha256) return;
    let active = true;
    void read
      .current("app_asset", { action: "read", sha256, workspaceId })
      .then(
        (result) => {
          if (!active) return;
          if (typeof result?.base64 === "string") setAsset(result);
          else setReadFailed(true);
        },
        () => {
          if (active) setReadFailed(true);
        },
      );
    return () => {
      active = false;
    };
  }, [sha256, workspaceId]);

  const label =
    typeof data.filename === "string" ? data.filename : object.title || "附件";
  const external = object.source?.external;
  const url = asset && `data:${mime};base64,${asset.base64}`;
  const image =
    url && (!data.mime || mime.startsWith("image/")) && imageDataUrl(url);
  const saveCrop = async (crop?: MediaCrop) => {
    await dispatch([
      {
        op: "object.update",
        id: object.id,
        expectedVersion: object.version,
        ...(crop ? { set: { crop } } : { unset: ["crop"] }),
      },
    ]);
  };
  return (
    <div className="media-view nodrag nopan nowheel" aria-label="媒体附件">
      {external && (
        <p>
          外部引用 <LinkView href={external.uri} openLink={openLink} />
        </p>
      )}
      {sha256 && !asset && (
        <p role="status">{readFailed ? ATTACHMENT_MISSING : "正在读取附件…"}</p>
      )}
      {!sha256 && !external && <p role="status">{ATTACHMENT_MISSING}</p>}
      {image ? (
        <ImageView
          src={image}
          alt={typeof data.alt === "string" ? data.alt : label}
          crop={previewCrop(data.crop)}
          readOnly={readOnly}
          onCrop={saveCrop}
        />
      ) : url && mime.startsWith("video/") ? (
        <Video src={url} label={label} />
      ) : url && mime.startsWith("audio/") ? (
        <audio controls preload="metadata" src={url} aria-label={label} />
      ) : (
        asset && (
          <>
            <p>
              {label} · {mime} · {asset.bytes} 字节
            </p>
            <button
              type="button"
              disabled={!downloadFile}
              onClick={() =>
                void downloadFile?.(label, {
                  blob: asset.base64,
                  mimeType: mime,
                }).catch((error) =>
                  setProblem(
                    error instanceof Error ? error.message : "附件下载失败。",
                  ),
                )
              }
            >
              下载附件
            </button>
          </>
        )
      )}
      {typeof data.caption === "string" && <p>{data.caption}</p>}
      {problem && <p role="alert">{problem}</p>}
    </div>
  );
}

function previewCrop(value: unknown): MediaCrop | undefined {
  if (!value || typeof value !== "object") return;
  const crop = value as MediaCrop;
  // A read-only object can still expose data written by a newer schema.
  // Only use coordinates that produce finite, positive display dimensions.
  if (
    [crop.x, crop.y, crop.w, crop.h].every(Number.isFinite) &&
    crop.w > 0 &&
    crop.h > 0
  )
    return crop;
}

function Video({ src, label }: { src: string; label: string }) {
  const [poster, setPoster] = useState("");
  return (
    <video
      controls
      preload="auto"
      playsInline
      src={src}
      poster={poster || undefined}
      aria-label={label}
      onLoadedData={(event) => {
        const video = event.currentTarget;
        if (poster || !video.videoWidth || !video.videoHeight) return;
        const canvas = document.createElement("canvas");
        canvas.width = Math.min(video.videoWidth, 480);
        canvas.height = Math.round(
          (canvas.width * video.videoHeight) / video.videoWidth,
        );
        const context = canvas.getContext("2d");
        if (!context) return;
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        setPoster(canvas.toDataURL("image/jpeg", 0.8));
      }}
    />
  );
}
