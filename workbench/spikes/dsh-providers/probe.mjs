import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { z } from "zod";
import { appendPluginRecord, pluginRecordOf } from "@deepseek-ai/dsh-session";
import { createUserMessage } from "@deepseek-ai/dsh-llm";

export const name = "sand-table-provider-probe";
export const inject = [
  "sessions",
  "sessionPersistence",
  "sessionProjections",
  "tools",
  "llm",
];

const recordType = "plugin:sand-table/provider-probe";
const stateSchema = z.object({
  boardId: z.string().nullable(),
  revision: z.number(),
});
const definition = {
  key: "sandTableProviderProbe",
  stateVersion: 1,
  stateSchema,
  init: () => ({ boardId: null, revision: 0 }),
  apply(state, event) {
    const record = pluginRecordOf(event);
    return record?.type === recordType ? stateSchema.parse(record.data) : state;
  },
  wire: { viewSchema: stateSchema, view: (state) => state },
};

export async function apply(ctx, config) {
  const report = { phase: config.phase, ok: false, checks: {} };
  try {
    const handle = await ctx.sessionProjections.register(definition);
    const observed = [];
    const off = ctx.sessionProjections.onChanged((session, key, value, seq) => {
      if (key === definition.key) observed.push({ key, value, seq });
    });
    let session, stored;
    if (config.phase === "write") {
      session = ctx.sessions.create("sand-table-provider-probe", {
        meta: { cwd: config.workspace },
      });
      stored = await ctx.sessionPersistence.create(session.header);
      await assert.rejects(ctx.sessionPersistence.open(session.id, "write"), {
        name: "SessionAlreadyOwnedError",
      });
      report.checks.singleWriter = true;
      session.append(
        "user/message",
        createUserMessage({
          content: [
            { type: "text", text: "Selected board: board-probe, revision: 7" },
          ],
          source: { kind: "user" },
        }),
        { surfaceOp: "append" },
      );
      appendPluginRecord(session, recordType, {
        boardId: "board-probe",
        revision: 7,
      });
      await stored.flush();
      report.checks.liveProjection = observed.some(
        (e) => e.value.revision === 7,
      );
    } else {
      stored = await ctx.sessionPersistence.open(
        "sand-table-provider-probe",
        "read",
      );
      const read = await stored.read();
      session = ctx.sessions.create(stored.id, {
        seed: read.events,
        meta: { cwd: stored.header.cwd, createdAt: stored.header.createdAt },
      });
      report.persistedEventTypes = read.events.map((event) => event.type);
      assert.ok(
        read.events.some((event) => pluginRecordOf(event)?.type === recordType),
      );
      assert.ok(read.events.some((event) => event.type === "user/message"));
      report.checks.coldRead = true;
      const before = session.seq;
      assert.deepEqual(handle.stateOf(session), {
        boardId: "board-probe",
        revision: 7,
      });
      assert.equal(session.seq, before);
      report.checks.replayHasNoWrites = true;
      await assert.rejects(stored.append([]), { name: "SessionReadOnlyError" });
      report.checks.readOnly = true;
    }
    assert.deepEqual(handle.stateOf(session), {
      boardId: "board-probe",
      revision: 7,
    });
    assert.deepEqual(
      ctx.sessionProjections.snapshot(session).values[definition.key],
      {
        boardId: "board-probe",
        revision: 7,
      },
    );
    report.checks.projection = true;
    const messages = session.deriveMessages();
    assert.ok(
      messages.some((m) =>
        m.content.some(
          (p) => p.type === "text" && p.text.includes("revision: 7"),
        ),
      ),
    );
    report.checks.durableModelContext = true;
    report.eventCount = session.seq;
    await handle.dispose();
    assert.equal(
      ctx.sessionProjections.snapshot(session).values[definition.key],
      undefined,
    );
    const reinstalled = await ctx.sessionProjections.register(definition);
    assert.equal(reinstalled.stateOf(session).revision, 7);
    report.checks.projectionReinstall = true;
    await stored.close();
    off();
    assert.ok(Object.values(report.checks).every((value) => value === true));
    report.ok = true;
  } catch (error) {
    report.error = String(error);
  }
  await writeFile(config.reportPath, JSON.stringify(report, null, 2) + "\n");
}
