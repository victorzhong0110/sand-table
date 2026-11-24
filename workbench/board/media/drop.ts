import { MAX_ASSET_BYTES } from "../../core/asset-limits.ts";
import type { Command } from "../../kernel/index.ts";
import { COMMAND_LIMIT } from "../canvas/clipboard.ts";

type AssetCall = (name: string, args: Record<string, unknown>) => Promise<any>;

export async function uploadAssetFile(
  call: AssetCall,
  file: File,
  workspaceId?: string,
) {
  assertAssetSize(file);
  const name = file.name.slice(0, 200) || "附件";
  const mime = file.type || "application/octet-stream";
  const base64 = await readBase64(file);
  const { sha256 } = await call("app_asset", {
    action: "upload",
    workspaceId,
    name,
    mime,
    base64,
  });
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256))
    throw Error("没有收到附件编号。请重新上传。");
  return { sha256, name, mime, bytes: file.size };
}

function assertAssetSize(file: File) {
  if (!file.size) throw Error("文件是空的。请重新选择。");
  if (file.size > MAX_ASSET_BYTES)
    throw Error(
      `单个附件最大 ${MAX_ASSET_BYTES / 1024 / 1024} MB。请压缩后再上传。`,
    );
}

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () =>
      reject(reader.error ?? Error("没有读到文件。请重新选择。"));
    reader.readAsDataURL(file);
  });
}

export async function prepareMediaDrop(
  files: readonly File[],
  position: { x: number; y: number },
  scope: { workspaceId: string; boardId: string; current(): boolean },
  call: AssetCall,
): Promise<Command[]> {
  if (files.length * 2 > COMMAND_LIMIT)
    throw Error("一次最多放入 100 个附件。请减少文件数量后再试。");
  files.forEach(assertAssetSize);
  const commands: Command[] = [];
  for (const [index, file] of files.entries()) {
    if (!scope.current()) throw Error("白板已切换。请重新放入附件。");
    const { sha256, name, mime, bytes } = await uploadAssetFile(
      call,
      file,
      scope.workspaceId,
    );
    const ref = `media${index}`;
    commands.push(
      {
        op: "object.create",
        ref,
        type: "base.media",
        title: name,
        data: { blob: sha256, mime, filename: name, size: bytes },
      },
      {
        op: "presentation.create",
        boardId: scope.boardId,
        objectId: `@${ref}`,
        x: position.x + index * 24,
        y: position.y + index * 24,
      },
    );
  }
  if (!scope.current()) throw Error("白板已切换。请重新放入附件。");
  return commands;
}
