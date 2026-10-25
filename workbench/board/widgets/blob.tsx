import { useEffect, useState } from "react";
import type { WidgetProps } from "../views/registry.tsx";
import { imageDataUrl } from "../views/format.ts";
import { useWidgetHost } from "./host.tsx";
import { WidgetShell } from "./shell.tsx";

export function BlobEditor({ value, readOnly, onChange, label }: WidgetProps) {
  const host = useWidgetHost();
  const sha = typeof value === "string" ? value : "";
  const [detail, setDetail] = useState("");
  const [thumb, setThumb] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => {
    let cancelled = false;
    if (!sha || !host) {
      setDetail("");
      setThumb("");
      return;
    }
    void host
      .readAsset(sha)
      .then((asset) => {
        if (cancelled) return;
        if (!asset) {
          setDetail("附件读不出来。请重新选择文件。");
          setThumb("");
          return;
        }
        const size =
          typeof asset.bytes === "number" ? `，${asset.bytes} 字节` : "";
        setDetail(`${asset.name || sha.slice(0, 8)}${size}`);
        const image = asset.dataUrl ? imageDataUrl(asset.dataUrl) : undefined;
        setThumb(image ?? "");
      })
      .catch(() => {
        if (!cancelled) setDetail("附件读不出来。请重新选择文件。");
      });
    return () => {
      cancelled = true;
    };
  }, [host, sha]);
  return (
    <WidgetShell
      label={label}
      readOnly={readOnly}
      onClear={() => onChange(undefined)}
    >
      {!readOnly && (
        <input
          type="file"
          aria-label={`选择${label}`}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (!file) return;
            if (!host) {
              setMessage("当前不能上传附件。请在属性面板里再试。");
              return;
            }
            setMessage("");
            void host
              .uploadAsset(file)
              .then((asset) => onChange(asset.sha256))
              .catch((error: unknown) =>
                setMessage(
                  error instanceof Error
                    ? error.message
                    : "没有传上去。请换一个较小的文件再试。",
                ),
              );
          }}
        />
      )}
      {thumb && <img className="blob-thumb" alt="附件缩略图" src={thumb} />}
      {detail && <small className="widget-hint">{detail}</small>}
      {message && <small className="field-warning">{message}</small>}
    </WidgetShell>
  );
}
