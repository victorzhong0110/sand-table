import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import {
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, delimiter, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "../../node_modules/playwright/index.mjs";
import { DatabaseSync } from "node:sqlite";
import {
  applyCommands,
  createRegistry,
  getMeta,
  openWorkspace,
} from "../../kernel/index.ts";
import { builtinPacks } from "../../packs/index.ts";

const bundle = dirname(fileURLToPath(import.meta.url));
const deps = resolve(bundle, "../../spikes/dsh-providers/node_modules");
const distribution = resolve(process.argv[2] || "artifacts/dsh-bundle");
const cli = join(deps, "@deepseek-ai/dsh/lib/bin.js");
const root = await mkdtemp(join(tmpdir(), "sand-dsh-install-check-"));
const cwd = join(root, "empty");
const workspaceDir = join(root, "workspaces");
const env = {
  ...process.env,
  DSH_HOME: join(root, "dsh"),
  PATH: join(deps, ".bin") + delimiter + process.env.PATH,
};
const overlay = join(root, "overlay.json");
const probe = join(root, "verify-host.mjs");
const report = join(root, "report.json");
const ready = join(root, "ready");
const scrub = (text) => text.replace(/token=[^\s"'<>]+/g, "token=REDACTED");
let child, browser, closed;
async function stop() {
  if (!child) return;
  child.kill("SIGTERM");
  if (
    !(await Promise.race([
      closed.then(() => true),
      delay(3000, false, { ref: false }),
    ]))
  ) {
    child.kill("SIGKILL");
    await closed;
  }
  child = undefined;
}
const install = () =>
  execFileSync(process.execPath, [join(distribution, "install.mjs")], {
    cwd,
    env,
    stdio: "pipe",
    timeout: 120000,
  });
try {
  await mkdir(cwd);
  await copyFile(join(bundle, "verify-host.mjs"), probe);
  const registry = createRegistry();
  for (const pack of builtinPacks) registry.registerPack(pack, "builtin");
  const old = openWorkspace(workspaceDir, "default", registry);
  const oldContent = "安装前保存的旧作品";
  try {
    applyCommands(old.db, registry, {
      actor: { kind: "human", id: "before-install" },
      commands: [
        {
          op: "object.create",
          type: "base.note",
          ref: "original",
          title: oldContent,
          data: { body: "安装前记录" },
        },
        {
          op: "presentation.create",
          boardId: getMeta(old.db, "home_board_id"),
          objectId: "@original",
          x: 425,
          y: 180,
        },
      ],
    });
  } finally {
    old.db.close();
  }
  install();
  await writeFile(
    overlay,
    JSON.stringify([
      { id: "sand-table", config: { workspaceDir } },
      {
        insert: [
          {
            id: "sand-package-probe",
            name: probe,
            config: {
              report,
              ready,
              cwd,
              workspaceDir,
            },
          },
        ],
      },
    ]),
  );
  child = spawn(
    process.execPath,
    [cli, "--profile", "web", "--patch", overlay, "--port", "0", "--no-open"],
    { cwd, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let log = "";
  child.stdout.on("data", (chunk) => {
    log = (log + chunk).slice(-16000);
  });
  child.stderr.on("data", (chunk) => {
    log = (log + chunk).slice(-16000);
  });
  closed = new Promise((done) => child.once("close", done));
  let state;
  let url;
  const deadline = Date.now() + 35000;
  while (!state && Date.now() < deadline && child.exitCode === null) {
    if (!url) {
      url = log.match(/http:\/\/127\.0\.0\.1:\d+\/[^\s]+/)?.[0];
      if (url) await writeFile(ready, "ready");
    }
    try {
      state = JSON.parse(await readFile(report, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError))
        throw error;
    }
    if (!state) await delay(100);
  }
  assert.equal(
    state?.ok,
    true,
    scrub([state?.error, log].filter(Boolean).join("\n")),
  );
  assert.ok(url, scrub(log));
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(scrub(error.message)));
  await page.goto(url);
  const nav = page.getByRole("button", { name: "Sand Table", exact: true });
  await nav.waitFor();
  for (const label of ["Continue", "Close"]) {
    const dialog = page.getByRole("button", { name: label, exact: true });
    try {
      await dialog.waitFor({ state: "visible", timeout: 2500 });
    } catch {
      continue;
    }
    await dialog.click();
  }
  await nav.click();
  const workbench = page.frameLocator('iframe[title="Sand Table 白板"]');
  await workbench
    .frameLocator("iframe")
    .getByText("安装验证白板", { exact: true })
    .first()
    .waitFor();
  await workbench
    .frameLocator("iframe")
    .getByText(oldContent, { exact: true })
    .first()
    .waitFor();
  await workbench.getByText("组合文件", { exact: true }).click();
  const downloadEvent = page.waitForEvent("download");
  await workbench.getByRole("button", { name: "导出完整组合" }).click();
  const download = await downloadEvent;
  const file = await download.path();
  const exported = JSON.parse(await readFile(file, "utf8"));
  assert.equal(
    exported.resources[0].exact.revision,
    exported.resources[0].ref.revision,
  );
  await workbench.locator("#composition-file").setInputFiles(file);
  await workbench.getByText(/已导入/).waitFor();
  assert.deepEqual(errors, []);
  await browser.close();
  browser = undefined;
  await stop();
  execFileSync(
    process.execPath,
    [cli, "plugin", "--profile", "web", "remove", "@sand-table/dsh-plugin"],
    {
      cwd,
      env,
      stdio: "pipe",
      timeout: 60000,
    },
  );
  install();
  const durable = new DatabaseSync(join(workspaceDir, "default/workspace.db"), {
    readOnly: true,
  });
  try {
    const contents = durable
      .prepare("SELECT title FROM objects WHERE title IN (?, ?) ORDER BY title")
      .all(oldContent, "安装验证白板");
    assert.equal(contents.length, 2);
  } finally {
    durable.close();
  }
  console.log(
    "Clean DSH installation, existing board, exact export, editable import and data retained after uninstall and reinstall passed.",
  );
} catch (error) {
  throw Error(scrub(String(error.stack ?? error)));
} finally {
  await browser?.close();
  await stop();
  await rm(root, { recursive: true, force: true });
}
