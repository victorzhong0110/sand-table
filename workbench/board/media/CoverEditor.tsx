import { useState } from "react";
import type { MediaCrop } from "../../kernel/index.ts";
import type { WorkspaceObject } from "../data-client/objects.ts";
import type { V3Tool } from "../data-client/store.ts";
import { uploadAssetFile } from "./drop.ts";

export { CroppedImage } from "./ImageView.tsx";

export function CoverEditor({
  objects,
  call,
  workspaceId,
  covered,
  onSet,
}: {
  objects: WorkspaceObject[];
  call: V3Tool;
  workspaceId: string;
  covered: boolean;
  onSet(blob: string | null, crop?: MediaCrop): Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState("");
  const images = objects.filter(
    ({ type, data }) =>
      (type === "base.media" || type === "resource") &&
      typeof data?.blob === "string" &&
      typeof data?.mime === "string" &&
      data.mime.startsWith("image/"),
  );

  async function write(change: () => Promise<void>) {
    setPending(true);
    setProblem("");
    try {
      await change();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "未能更新封面。");
    } finally {
      setPending(false);
    }
  }

  return (
    <fieldset disabled={pending}>
      <legend>展示封面</legend>
      {images.length > 0 && (
        <select
          aria-label="从图片组件设置封面"
          value=""
          onChange={(event) => {
            const data = images.find(
              ({ id }) => id === event.target.value,
            )?.data;
            if (typeof data?.blob !== "string") return;
            const blob = data.blob;
            void write(() => onSet(blob, data.crop as MediaCrop | undefined));
          }}
        >
          <option value="">从图片组件选择</option>
          {images.map(({ id, title }) => (
            <option key={id} value={id}>
              {title || "未命名图片"}
            </option>
          ))}
        </select>
      )}
      <label>
        从本地图片设置封面
        <input
          type="file"
          accept="image/*"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (!file) return;
            void write(async () => {
              if (!file.type.startsWith("image/"))
                throw Error("请选择图片文件。");
              const { sha256 } = await uploadAssetFile(call, file, workspaceId);
              await onSet(sha256);
            });
          }}
        />
      </label>
      {covered && (
        <button type="button" onClick={() => void write(() => onSet(null))}>
          移除封面
        </button>
      )}
      {problem && <p role="alert">{problem}</p>}
    </fieldset>
  );
}
