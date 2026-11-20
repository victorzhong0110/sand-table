import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

export const name = "sand-diagram-host-probe";
export const inject = ["diagram", "sessions", "sessionPersistence", "tools"];

const sessionId = "sand-diagram-probe";
const label = "Edited in the scene";
const signal = new AbortController().signal;

export async function apply(ctx, config) {
  let handle;
  const checks = {};
  let report;
  try {
    const readTool = ctx.tools.get("diagram_read");
    const createTool = ctx.tools.get("diagram_create");
    assert.ok(createTool && readTool);
    checks.registeredTools = true;
    if (config.phase === "write") {
      const session = ctx.sessions.create(sessionId, {
        meta: { cwd: config.cwd },
      });
      handle = await ctx.sessionPersistence.create(session.header);
      const exec = { agent: { session }, signal };
      const created = await createTool.execute(
        {
          kind: "flow",
          title: "Probe diagram",
          nodes: [{ id: "start", label: "Generated label" }],
          edges: [],
        },
        exec,
      );
      const current = await readTool.execute({ id: created.diagramId }, exec);
      assert.equal(current.source, "sourceSpec");
      assert.match(current.summary, /Generated label/);
      checks.agentCreateRead = true;
      const scene = {
        elements: [
          {
            id: "label",
            type: "text",
            x: 15,
            y: 20,
            width: 160,
            height: 24,
            text: label,
          },
        ],
        appState: {},
        files: {},
      };
      const edit = {
        id: created.diagramId,
        sessionId,
        expectedRevision: created.revision,
        scene,
      };
      const saved = await ctx.diagram.save(edit, signal);
      assert.equal(saved.ok, true, JSON.stringify(saved));
      const read = await readTool.execute({ id: created.diagramId }, exec);
      assert.equal(read.source, "scene");
      assert.notEqual(read.revision, created.revision);
      assert.ok(read.summary.includes(label));
      checks.editedSceneIsAuthoritative = true;
      const stale = await ctx.diagram.save(edit, signal);
      assert.equal(stale.ok, false);
      assert.equal(stale.error.code, "version-conflict");
      const other = ctx.sessions.create("sand-diagram-probe-other", {
        meta: { cwd: config.cwd },
      });
      const denied = await ctx.diagram.readDiagram(
        other.header,
        created.diagramId,
        signal,
      );
      assert.equal(denied.ok, false);
      assert.equal(denied.error.code, "diagram-not-found");
      checks.staleRevisionRejected = true;
      checks.otherSessionDenied = true;
      await handle.flush();
      await writeFile(
        config.marker,
        JSON.stringify({ id: read.diagramId, revision: read.revision }),
      );
    } else {
      assert.equal(ctx.sessions.get(sessionId), undefined);
      const marker = JSON.parse(await readFile(config.marker, "utf8"));
      const restored = await ctx.diagram.get(
        { sessionId, id: marker.id },
        signal,
      );
      assert.equal(restored.ok, true, JSON.stringify(restored));
      assert.equal(restored.value.diagram.revision, marker.revision);
      assert.equal(restored.value.diagram.scene.elements[0].text, label);
      checks.coldSessionScene = true;
    }
    report = { ok: true, checks };
  } catch (error) {
    report = { ok: false, error: String(error.stack ?? error), checks };
  } finally {
    await handle?.close();
  }
  await writeFile(config.report, JSON.stringify(report));
}
