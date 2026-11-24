import { useEffect, useRef, useState, type PointerEvent } from "react";
import type { MediaCrop } from "../../kernel/index.ts";
import { cropFromPoints } from "./crop.ts";

type ImageProps = { src: string; alt: string; crop?: MediaCrop };

export function CroppedImage({ src, alt, crop }: ImageProps) {
  const [ratio, setRatio] = useState(1);
  const image = (
    <img
      src={src}
      alt={alt}
      draggable={false}
      onLoad={(event) => {
        const { naturalWidth, naturalHeight } = event.currentTarget;
        if (naturalHeight) setRatio(naturalWidth / naturalHeight);
      }}
      style={
        crop
          ? {
              position: "absolute",
              width: `${100 / crop.w}%`,
              height: `${100 / crop.h}%`,
              left: `${(-100 * crop.x) / crop.w}%`,
              top: `${(-100 * crop.y) / crop.h}%`,
              maxWidth: "none",
              maxHeight: "none",
            }
          : undefined
      }
    />
  );
  return crop ? (
    <span
      className="media-cropped"
      style={{ aspectRatio: (ratio * crop.w) / crop.h }}
    >
      {image}
    </span>
  ) : (
    image
  );
}

export function ImageView({
  src,
  alt,
  crop,
  readOnly,
  onCrop,
}: ImageProps & {
  readOnly: boolean;
  onCrop(crop?: MediaCrop): Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="media-image"
        aria-label="查看图片"
        onClick={(event) => {
          if (event.detail === 0) setOpen(true);
        }}
        onDoubleClick={(event) => {
          event.stopPropagation();
          setOpen(true);
        }}
      >
        <CroppedImage src={src} alt={alt} crop={crop} />
      </button>
      {open && (
        <ImageViewer
          src={src}
          alt={alt}
          crop={crop}
          readOnly={readOnly}
          onCrop={onCrop}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function ImageViewer({
  src,
  alt,
  crop,
  readOnly,
  onCrop,
  onClose,
}: ImageProps & {
  readOnly: boolean;
  onCrop(crop?: MediaCrop): Promise<void>;
  onClose(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const gesture = useRef<
    { x: number; y: number; startX: number; startY: number } | undefined
  >(undefined);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<MediaCrop>();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    dialog.current?.showModal();
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      dialog.current?.close();
    };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, []);

  const normalized = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: (event.clientX - bounds.left) / bounds.width,
      y: (event.clientY - bounds.top) / bounds.height,
    };
  };

  function start(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = editing
      ? normalized(event)
      : { x: event.clientX, y: event.clientY };
    gesture.current = { ...point, startX: offset.x, startY: offset.y };
  }

  function move(event: PointerEvent<HTMLDivElement>) {
    const origin = gesture.current;
    if (!origin) return;
    if (editing) {
      setDraft(cropFromPoints(origin, normalized(event)));
    } else {
      setOffset({
        x: origin.startX + event.clientX - origin.x,
        y: origin.startY + event.clientY - origin.y,
      });
    }
  }

  async function save(value?: MediaCrop) {
    setPending(true);
    setMessage("");
    try {
      await onCrop(value);
      setEditing(false);
      closeButton.current?.focus();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "图片裁剪未保存。");
    } finally {
      setPending(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      className="media-dialog nodrag nopan nowheel"
      aria-label="图片查看器"
      aria-modal="true"
      onClose={onClose}
    >
      <div className="media-actions">
        <button
          type="button"
          onClick={() => setZoom(Math.max(0.5, zoom / 1.25))}
        >
          缩小
        </button>
        <button type="button" onClick={() => setZoom(Math.min(8, zoom * 1.25))}>
          放大
        </button>
        <button
          type="button"
          onClick={() => {
            setZoom(1);
            setOffset({ x: 0, y: 0 });
          }}
        >
          重置视角
        </button>
        {!readOnly && !editing && (
          <button
            type="button"
            onClick={() => {
              setZoom(1);
              setOffset({ x: 0, y: 0 });
              setDraft(crop);
              setEditing(true);
            }}
          >
            裁剪图片
          </button>
        )}
        {editing && (
          <button
            type="button"
            disabled={!draft || pending}
            onClick={() => void save(draft)}
          >
            保存裁剪
          </button>
        )}
        {!readOnly && crop && (
          <button type="button" disabled={pending} onClick={() => void save()}>
            恢复原图
          </button>
        )}
        <button
          ref={closeButton}
          type="button"
          onClick={() => dialog.current?.close()}
        >
          关闭查看器
        </button>
      </div>
      {editing && <p role="status">在原图上拖动鼠标选出裁剪范围。</p>}
      {message && <p role="alert">{message}</p>}
      <div className="media-stage">
        <div
          className="media-sheet"
          onPointerDown={start}
          onPointerMove={move}
          onPointerUp={() => {
            gesture.current = undefined;
          }}
          onPointerCancel={() => {
            gesture.current = undefined;
          }}
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
          }}
        >
          <CroppedImage src={src} alt={alt} crop={editing ? undefined : crop} />
          {editing && draft && (
            <span
              className="media-selection"
              style={{
                left: `${draft.x * 100}%`,
                top: `${draft.y * 100}%`,
                width: `${draft.w * 100}%`,
                height: `${draft.h * 100}%`,
              }}
            />
          )}
        </div>
      </div>
    </dialog>
  );
}
