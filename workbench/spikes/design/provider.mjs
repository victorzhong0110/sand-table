import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const [oldCli, targetCli] = process.argv
  .slice(2)
  .map((entry) => resolve(entry));
assert.ok(
  oldCli && targetCli,
  "Pass bin.js paths for DSH 0.1.7-rc.2 and 0.2.2-rc.1.",
);
const sandbox = await mkdtemp(join(tmpdir(), "sand-drawing-"));
const diagramPackage = "dsh-diagram@0.6.1";
const probe = fileURLToPath(new URL("./provider-host.mjs", import.meta.url));

function run(cli, home, args) {
  let output = "";
  const child = spawn(process.execPath, [cli, ...args], {
    env: {
      ...process.env,
      DSH_HOME: home,
      PATH:
        resolve(dirname(cli), "../../../.bin") + delimiter + process.env.PATH,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const collect = (data) => {
    output = (output + data).slice(-20000);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  return { child, closed, output: () => output };
}

async function stop(processRun) {
  if (
    processRun.child.exitCode !== null ||
    processRun.child.signalCode !== null
  )
    return;
  processRun.child.kill("SIGTERM");
  await Promise.race([
    processRun.closed,
    new Promise((resolve) => setTimeout(resolve, 5000).unref()),
  ]);
  if (
    processRun.child.exitCode === null &&
    processRun.child.signalCode === null
  ) {
    processRun.child.kill("SIGKILL");
    await processRun.closed;
  }
}

async function command(cli, home, args, timeoutMs = 120000) {
  const processRun = run(cli, home, args);
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`DSH command timed out: ${args.join(" ")}`)),
      timeoutMs,
    ).unref();
  });
  try {
    const code = await Promise.race([processRun.closed, deadline]);
    return { code, output: processRun.output() };
  } finally {
    clearTimeout(timer);
    await stop(processRun);
  }
}

async function measure(directory) {
  let bytes = 0,
    assetsBytes = 0,
    assetsGzip = 0;
  let biggestChunk = { file: "", bytes: 0, gzip: 0 };
  for (const item of await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!item.isFile()) continue;
    const data = await readFile(join(item.parentPath, item.name));
    bytes += data.length;
    if (!item.name.endsWith(".js") && !item.name.endsWith(".css")) continue;
    assetsBytes += data.length;
    const gzip = gzipSync(data).length;
    assetsGzip += gzip;
    if (gzip > biggestChunk.gzip)
      biggestChunk = { file: item.name, bytes: data.length, gzip };
  }
  return {
    totalEditorBytes: bytes,
    jsCssBytes: assetsBytes,
    jsCssGzipSum: assetsGzip,
    biggestChunk,
  };
}

async function hostPhase(home, phase) {
  const report = join(sandbox, phase + ".json");
  const patch = join(sandbox, phase + ".patch.json");
  await writeFile(
    patch,
    JSON.stringify([
      {
        insert: [
          {
            id: "sand-diagram-host-probe",
            name: probe,
            config: {
              phase,
              report,
              marker: join(sandbox, "diagram.json"),
              cwd: sandbox,
            },
          },
        ],
      },
    ]),
  );
  const launched = run(oldCli, home, [
    "--patch",
    patch,
    "--profile",
    "web",
    "--host",
    "127.0.0.1",
    "--port",
    "0",
    "--no-open",
  ]);
  try {
    const deadline = Date.now() + 45000;
    do {
      try {
        const result = JSON.parse(await readFile(report, "utf8"));
        return { phase, ...result };
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (launched.child.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    } while (Date.now() < deadline);
    return {
      phase,
      ok: false,
      diagnostic: launched.output().replace(/token=[^\s]+/g, "token=REDACTED"),
    };
  } finally {
    await stop(launched);
  }
}

try {
  const [target, previous] = await Promise.all(
    [
      { cli: targetCli, version: "0.2.2-rc.1", home: join(sandbox, "target") },
      { cli: oldCli, version: "0.1.7-rc.2", home: join(sandbox, "previous") },
    ].map(async (runtime) => {
      const actual = JSON.parse(
        await readFile(
          resolve(dirname(runtime.cli), "../package.json"),
          "utf8",
        ),
      );
      assert.equal(actual.version, runtime.version);
      const initialized = await command(runtime.cli, runtime.home, [
        "--profile",
        "web",
        "--dump-config",
      ]);
      assert.equal(initialized.code, 0, initialized.output);
      const added = await command(runtime.cli, runtime.home, [
        "plugin",
        "--profile",
        "web",
        "add",
        diagramPackage,
      ]);
      const profile = JSON.parse(
        await readFile(join(runtime.home, "profiles/web/package.json"), "utf8"),
      );
      return { ...runtime, added, profile };
    }),
  );
  assert.notEqual(target.added.code, 0);
  assert.equal(target.profile.dependencies?.["dsh-diagram"], undefined);
  const rejection = target.added.output
    .split("\n")
    .find((line) => line.includes("incompatible with dsh"));
  assert.ok(rejection, target.added.output);
  assert.equal(previous.added.code, 0, previous.added.output);
  assert.equal(previous.profile.dependencies["dsh-diagram"], "0.6.1");
  assert.ok(previous.profile.dsh.profile.bundles.includes("dsh-diagram"));
  const editor = join(
    previous.home,
    "profiles/web/node_modules/dsh-diagram/lib/editor",
  );
  const host = [await hostPhase(previous.home, "write")];
  if (host[0].ok) host.push(await hostPhase(previous.home, "read"));
  console.log(
    JSON.stringify(
      {
        node: process.version,
        diagramPackage,
        target: { version: target.version, installed: false, rejection },
        previous: { version: previous.version, installed: true, host },
        editor: await measure(editor),
      },
      null,
      2,
    ),
  );
  assert.ok(host.length === 2 && host.every(({ ok }) => ok));
} finally {
  await rm(sandbox, { recursive: true, force: true });
}
