// Actual local workbench + independent MCP bridge + disk writer. No user files or model calls.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { chromium } from "playwright";
import { startLocal } from "../local/service.ts";
import { resultData } from "../core/results.ts";
import { WorkspaceStore } from "../core/workspace.ts";
import { BoardStore } from "../core/store.ts";
import { workspacePort } from "../core/persistence.ts";
import { Spaces } from "../server/spaces.ts";
const root = mkdtempSync(join(tmpdir(), "sand-recovery-browser-")),
  workspaceRoot = join(root, "workspaces"),
  sessionFile = join(root, "connection.json");
let local: Awaited<ReturnType<typeof startLocal>> | undefined,
  browser: Awaited<ReturnType<typeof chromium.launch>> | undefined,
  client: Client | undefined;
try {
  local = await startLocal({
    workspaces: [],
    sessionFile,
    workspaceDir: workspaceRoot,
  });
  client = new Client({ name: "recovery-acceptance", version: "1" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        "--experimental-strip-types",
        fileURLToPath(new URL("../local/bridge.ts", import.meta.url)),
        "--session-file",
        sessionFile,
      ],
    }),
  );
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client!.callTool({ name, arguments: args });
    if (r.isError) throw Error(JSON.stringify(r));
    return resultData(r);
  };
  let board = await call("sand_open_board", {
    title: "Recovery",
    preset: "blank",
  });
  board = await call("sand_open_view", { boardId: board.id, viewId: "probe" });
  board = await call("sand_edit_space", {
    boardId: board.id,
    viewId: "probe",
    revision: board.revision,
    author: "human",
    operation: {
      kind: "create",
      type: "text",
      title: "before-conflict",
      data: { text: "baseline" },
    },
  });
  const waitSaved = async () => {
    for (let i = 0; i < 100; i++) {
      const status = await call("sand_workspace_status", { boardId: board.id });
      if (status.saved) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw Error("not saved");
  };
  await waitSaved();
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.setDefaultTimeout(12000);
  await page.goto(local.url);
  const frame = page.frameLocator("iframe");
  await frame.getByText("baseline", { exact: true }).waitFor();
  await waitSaved();
  const disk = new WorkspaceStore(workspaceRoot),
    external = new BoardStore();
  external.attachPersistence(workspacePort(disk), "default");
  const remote = external.open(
    { objects: [], relations: [], workspaces: [] },
    "remote",
  );
  new Spaces(external).update(
    remote.id,
    remote.revision,
    "probe",
    {
      kind: "create",
      type: "text",
      title: "remote-card",
      data: { text: "remote version" },
    },
    "human",
  );
  await external.flushSave();
  board = await call("sand_read_board", { boardId: board.id });
  board = await call("sand_edit_space", {
    boardId: board.id,
    viewId: "probe",
    revision: board.revision,
    author: "human",
    operation: {
      kind: "create",
      type: "text",
      title: "local-unsaved",
      data: { text: "local draft" },
    },
  });
  const alert = frame.getByRole("alert");
  await alert.filter({ hasText: "保存失败" }).waitFor();
  const downloading = page.waitForEvent("download").catch(() => null);
  await alert
    .getByRole("button", { name: "导出工作空间", exact: true })
    .click();
  const download = await downloading;
  if (!download) throw Error(await frame.locator("body").innerText());
  const exported = JSON.parse(readFileSync((await download.path())!, "utf8"));
  assert.ok(
    exported.workspace.objects.some((o: any) => o.title === "local-unsaved"),
  );
  assert.ok(
    !exported.workspace.objects.some((o: any) => o.title === "remote-card"),
  );
  await alert
    .getByRole("button", { name: "保留副本并重新加载", exact: true })
    .click();
  await frame.getByText("remote version", { exact: true }).waitFor();
  const listed = await call("sand_list_workspaces");
  const copy = listed.workspaces.find((w: any) =>
    w.title.endsWith("（恢复副本）"),
  );
  assert.ok(copy);
  assert.ok(
    disk
      .load(copy.id)
      .workspace.objects.some((o) => o.title === "local-unsaved"),
  );
  assert.ok(
    disk
      .load("default")
      .workspace.objects.some((o) => o.title === "remote-card"),
  );
  await frame.getByRole("button", { name: "设置", exact: true }).click();
  const row = frame.locator(".workspace-item").filter({ hasText: copy.title });
  await row.getByRole("button", { name: "切换", exact: true }).click();
  await frame.getByText("local draft", { exact: true }).waitFor();
  console.log(
    "RECOVERY BROWSER PASSED: conflict alert, native JSON download of unsaved memory, automatic recovery copy, disk reload and returning to the saved local copy through settings.",
  );
} finally {
  await browser?.close();
  await client?.close();
  await local?.close();
  rmSync(root, { recursive: true, force: true });
}
