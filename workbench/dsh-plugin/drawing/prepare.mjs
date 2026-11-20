import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

const upstream = "dsh-diagram@0.6.1";
const sha256 =
  "def15df587c0abe04dd78f28b139db47d4f837911b36bd536ba9d51c8194d87a";
const host = "0.2.2-rc.1";
const version = "0.6.1-sand-table.1";
const output = resolve(process.argv[2] ?? "artifacts/drawing");
const scratch = await mkdtemp(join(tmpdir(), "sand-diagram-dist-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
try {
  await mkdir(output, { recursive: true });
  const tarball = process.argv[3]
    ? resolve(process.argv[3])
    : join(
        scratch,
        JSON.parse(
          execFileSync(
            npm,
            [
              "pack",
              upstream,
              "--ignore-scripts",
              "--json",
              "--pack-destination",
              scratch,
            ],
            { encoding: "utf8" },
          ),
        )[0].filename,
      );
  assert.equal(
    createHash("sha256")
      .update(await readFile(tarball))
      .digest("hex"),
    sha256,
  );
  execFileSync("tar", ["-xzf", tarball, "-C", scratch]);
  const root = join(scratch, "package");
  const manifestPath = join(root, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.version, "0.6.1");
  const peers = manifest.peerDependencies;
  // The published host and client bundles have no import of the removed primitives package.
  delete peers["@deepseek-ai/dsh-client-ui-primitives"];
  for (const peer of Object.keys(peers))
    if (peer.startsWith("@deepseek-ai/dsh-")) peers[peer] = host;
  peers["@deepseek-ai/cordis"] = "4.1.0";
  peers["@deepseek-ai/schemastery"] = "3.19.0";
  peers.react = "19.3.0";
  manifest.peerDependenciesMeta.react = { optional: true };
  delete manifest.peerDependenciesMeta["@deepseek-ai/dsh-client-ui-primitives"];
  manifest.dependencies["@dagrejs/dagre"] = "3.1.3";
  manifest.dependencies.zod = "4.6.7";
  manifest.version = version;
  manifest.dsh.compatibility = { dshReleases: { [host]: "unknown" } };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  const entry = join(root, "lib/editor/assets/editor.js");
  const original = await readFile(entry, "utf8");
  assert.ok(
    original.includes(
      'URLSearchParams(globalThis.location.search).get("sessionId")',
    ),
  );
  // The existing editor consumes and validates this same one-shot link from its chat tab.
  const link = `{
  const query = new URLSearchParams(globalThis.location.search);
  const sessionId = query.get("sessionId"), diagramId = query.get("diagramId");
  if (sessionId && sessionId.length <= 512 && diagramId &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(diagramId)) {
    try {
      sessionStorage.setItem("dsh-diagram:canvas-link:v1", JSON.stringify({ sessionId, diagramId }));
    } catch {}
  }
}\n`;
  await writeFile(entry, link + original);

  const hostEntry = join(root, "lib/index.js");
  let hostModule = await readFile(hostEntry, "utf8");
  function patchHost(before, after) {
    assert.equal(hostModule.split(before).length, 2, before);
    hostModule = hostModule.replace(before, () => after);
  }
  // Reuse the repository's creation queue and limits for a one-write import.
  patchHost(
    "async create(session, sourceSpec, signal) {",
    "async create(session, sourceSpec, signal, scene) {",
  );
  patchHost(
    "sourceSpec: structuredClone(sourceSpec),",
    `sourceSpec: structuredClone(sourceSpec),
                ...(scene === undefined ? {} : { scene: structuredClone(scene) }),`,
  );
  patchHost(
    "\tdispose() {\n\t\tthis.mutationAdmissionOpen = false;",
    `  remove(session, id, expectedRevision, signal) {
    return this.enqueue(id, async () => {
      signal.throwIfAborted();
      const current = this.table.get(id);
      if (!current || !ownedBy(current, session)) return { ok: false, code: "diagram-not-found" };
      if (current.revision !== expectedRevision) return { ok: false, code: "version-conflict", revision: current.revision };
      return this.enqueueCapacity(async () => {
        signal.throwIfAborted();
        if (!await this.table.delete(id)) return { ok: false, code: "diagram-not-found" };
        this.storedBytes -= serializedRecordBytes(current);
        return { ok: true, revision: current.revision };
      });
    });
  }
\tdispose() {\n\t\tthis.mutationAdmissionOpen = false;`,
  );
  patchHost(
    "\tresolveSession(sessionId, signal) {",
    `  importDiagram(session, input, signal) {
    const sourceSpec = createDiagramSpecSchema(this.validationPolicy).parse(input.sourceSpec);
    const scene = createSceneSchema(this.validationPolicy).parse(input.scene);
    return this.requireRepository().create(session, sourceSpec, signal, scene);
  }
  removeDiagram(session, id, expectedRevision, signal) {
    return this.requireRepository().remove(session, id, expectedRevision, signal);
  }
  \tresolveSession(sessionId, signal) {`,
  );
  await writeFile(hostEntry, hostModule);

  const packaged = execFileSync(
    npm,
    ["pack", root, "--ignore-scripts", "--json", "--pack-destination", output],
    { encoding: "utf8" },
  );
  console.log(resolve(output, JSON.parse(packaged)[0].filename));
} finally {
  await rm(scratch, { recursive: true, force: true });
}
