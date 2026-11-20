import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "../../node_modules/playwright/index.mjs";
import { startLocal } from "../../local/service.ts";

const drawing = dirname(fileURLToPath(import.meta.url));
const dsh = resolve(drawing, "../../spikes/dsh-providers/node_modules");
const cli = join(dsh, "@deepseek-ai/dsh/lib/bin.js");
const root = await mkdtemp(join(tmpdir(), "sand-drawing-"));
const files = Object.fromEntries(
  ["seed", "edited", "report", "refs"].map((name) => [
    name,
    join(root, name + ".json"),
  ]),
);
const sessionId = "sand-drawing-verification";
const workspaceDir = join(root, "boards");
const sessionFile = join(root, "connection.json");
const env = {
  ...process.env,
  DSH_HOME: join(root, "dsh"),
  PATH: join(dsh, ".bin") + delimiter + process.env.PATH,
};
const exec = promisify(execFile);
const scrub = (value) => value.replace(/token=[^\s]+/g, "token=REDACTED");
const json = (path) => readFile(path, "utf8").then(JSON.parse);

async function command(...args) {
  try {
    return await exec(process.execPath, [cli, ...args], {
      env,
      timeout: 60000,
      maxBuffer: 2_000_000,
    });
  } catch (error) {
    throw Error(scrub(error.stderr || error.message));
  }
}

async function run(local, phase) {
  await rm(files.report, { force: true });
  const patch = join(root, "overlay.json");
  const overlay = { ...files, phase, sessionId, workspaceDir, cwd: root };
  await writeFile(
    patch,
    JSON.stringify([
      {
        insert: [
          {
            id: "sand-table",
            name: resolve(drawing, "../index.js"),
            config: {
              workspaceDir,
              sessionFile,
              boardUrl: new URL("/embed", local.url).href,
            },
          },
          {
            id: "sand-drawing-composition-probe",
            name: join(drawing, "verify-host.mjs"),
            config: overlay,
          },
        ],
      },
    ]),
  );
  const child = spawn(
    process.execPath,
    [
      cli,
      "--patch",
      patch,
      "--profile",
      "web",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--no-open",
    ],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let logs = "";
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (data) => {
      logs = (logs + data).slice(-24000);
    });
  const exited = new Promise((done) => child.once("close", done));
  let browser;

  async function waitFor(value) {
    const end = Date.now() + 35000;
    while (Date.now() < end && child.exitCode === null) {
      try {
        const result = await value();
        if (result !== undefined) return result;
      } catch (error) {
        if (error.code !== "ENOENT" && !(error instanceof SyntaxError))
          throw error;
      }
      await delay(100);
    }
    const report = await json(files.report).catch(() => undefined);
    throw Error(report?.error ?? scrub(logs));
  }

  try {
    if (phase === "edit") {
      const address = await waitFor(
        () => logs.match(/http:\/\/127.0.0.1:\d+\/[^\s]*/)?.[0],
      );
      const { route } = await waitFor(() => json(files.seed));
      browser = await chromium.launch({
        executablePath: process.env.CHROMIUM_PATH,
        args: ["--no-sandbox"],
      });
      const page = await browser.newPage();
      await page.goto(address);
      const res = await page.goto(route.route.url);
      assert.equal(res?.status(), 200);
      await page
        .getByRole("heading", { name: "Composition diagram", exact: true })
        .waitFor();
      const canvas = page.locator("canvas.interactive");
      const bounds = await canvas.boundingBox();
      assert.ok(bounds);
      await page.keyboard.press("t");
      await page.mouse.click(
        bounds.x + bounds.width * 0.64,
        bounds.y + bounds.height * 0.45,
      );
      await page.keyboard.type("Browser label");
      await page.keyboard.press("Escape");
      await writeFile(files.edited, "true");
    }
    const report = await waitFor(() => json(files.report));
    assert.equal(report.ok, true, report.error);
    console.log(phase, report);
  } finally {
    await browser?.close();
    child.kill("SIGTERM");
    if (
      !(await Promise.race([
        exited.then(() => true),
        delay(3000, false, { ref: false }),
      ]))
    ) {
      child.kill("SIGKILL");
      await exited;
    }
  }
}

let local;
try {
  const tar = process.argv[2] ? resolve(process.argv[2]) : undefined;
  const { stdout } = await exec(
    process.execPath,
    [join(drawing, "prepare.mjs"), root, ...(tar ? [tar] : [])],
    { timeout: 60000 },
  );
  const packaged = stdout.trim().split("\n").at(-1);
  await command("web", "--dump-config");
  await command("plugin", "--profile", "web", "add", packaged);
  await mkdir(workspaceDir);
  local = await startLocal({ workspaces: [], workspaceDir, sessionFile });
  await run(local, "edit");
  await run(local, "cold");
  await command("plugin", "--profile", "web", "remove", "dsh-diagram");
  await run(local, "disabled");
  await command("plugin", "--profile", "web", "add", packaged);
  await run(local, "cold");
} finally {
  await local?.close();
  await rm(root, { recursive: true, force: true });
}
