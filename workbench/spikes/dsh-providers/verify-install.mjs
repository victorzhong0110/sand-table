import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const runtime = await mkdtemp(join(tmpdir(), "sand-dsh-install-"));
const cli = join(root, "node_modules/@deepseek-ai/dsh/lib/bin.js");
const env = {
  ...process.env,
  DSH_HOME: runtime,
  PATH: join(root, "node_modules/.bin") + delimiter + process.env.PATH,
};
async function command(args) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const collect = (data) => {
      output = (output + data).slice(-16000);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(Error("DSH command timed out: " + args.join(" ")));
    }, 60000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve({ code, output });
    });
  });
}
const manifest = async () =>
  JSON.parse(
    await readFile(join(runtime, "profiles/web/package.json"), "utf8"),
  );
try {
  assert.equal((await command(["web", "--dump-config"])).code, 0);
  const rejected = await command([
    "plugin",
    "--profile",
    "web",
    "add",
    "dsh-diagram@0.6.1",
  ]);
  assert.notEqual(rejected.code, 0);
  assert.match(rejected.output, /incompatible with dsh 0\.2\.2-rc\.1/);
  assert.equal((await manifest()).dependencies?.["dsh-diagram"], undefined);
  const context = ["plugin", "--profile", "web", "add", "dsh-context@0.85.1"];
  const installed = await command(context);
  assert.equal(installed.code, 0, installed.output);
  assert.equal((await manifest()).dependencies["dsh-context"], "0.85.1");
  assert.ok((await manifest()).dsh.profile.bundles.includes("dsh-context"));
  const removed = await command([
    "plugin",
    "--profile",
    "web",
    "remove",
    "dsh-context",
  ]);
  assert.equal(removed.code, 0, removed.output);
  assert.equal((await manifest()).dependencies?.["dsh-context"], undefined);
  const reinstalled = await command(context);
  assert.equal(reinstalled.code, 0, reinstalled.output);
  const sand = await command([
    "plugin",
    "--profile",
    "web",
    "add",
    resolve(root, "../../dsh-plugin"),
  ]);
  assert.equal(sand.code, 0, sand.output);
  assert.ok(
    (await manifest()).dsh.profile.bundles.includes("@sand-table/dsh-plugin"),
  );
  console.log(
    JSON.stringify(
      {
        dsh: "0.2.2-rc.1",
        context: "0.85.1",
        pnpm: "10.32.1",
        node: process.version,
        checks: {
          diagramRejectedWithoutExemption: true,
          contextInstalled: true,
          contextUninstalled: true,
          contextReinstalled: true,
          whiteboardLinked: true,
        },
        diagramDiagnostic: rejected.output
          .split("\n")
          .find((line) => line.includes("incompatible with dsh")),
        limits: [
          "Profile lifecycle only; browser rendering and model execution are separate checks.",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  await rm(runtime, { recursive: true, force: true });
}
