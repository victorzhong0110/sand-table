import { startLocal } from "./local/service.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "sand-local-probe-"));
const local = await startLocal({
  workspaces: ["clsx=/workspace/sand-table"],
  sessionFile: join(dir, "connection.json"),
  port: 0,
  preset: "code",
  workspaceDir: join(dir, "workspaces"),
});
console.log("url:", local.url);
const base = local.url.split("#")[0].replace(/\/$/, "");
const token = local.url.split("#session=")[1];
const res = await fetch(base + "/bootstrap", { method: "POST", headers: { "X-Sand-Token": token, "Content-Type": "application/json", Origin: base }, body: "{}" });
console.log("status:", res.status, "final:", res.url);
const text = await res.text();
console.log("raw:", text.slice(0, 400));
const body = JSON.parse(text);
const board = body?.boardResult?._meta?.data;
console.log("status:", res.status);
console.log("keys:", Object.keys(board || {}).join(","));
console.log("title:", board?.title, "| presentation:", board?.presentation, "| instances:", board?.instances?.length, "| spaces:", board?.spaces?.length, "| autoProjectSources:", board?.autoProjectSources);
console.log("error:", body?.error);
await local.close();
process.exit(0);
