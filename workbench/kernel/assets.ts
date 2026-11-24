import type { Db } from "./db.ts";

export function recordAsset(
  db: Db,
  sha256: string,
  mime: string,
  bytes: number,
): void {
  db.prepare(
    "INSERT OR IGNORE INTO blobs (sha256, mime, bytes, created_at) VALUES (?, ?, ?, ?)",
  ).run(sha256, mime, bytes, Date.now());
}

export function readAssetMime(db: Db, sha256: string): string | undefined {
  const mime = db
    .prepare("SELECT mime FROM blobs WHERE sha256 = ?")
    .get(sha256)?.mime;
  return typeof mime === "string" ? mime : undefined;
}
