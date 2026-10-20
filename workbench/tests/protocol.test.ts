import { resultData } from "../core/results.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fixtureGuide } from "./fixture-guide.ts";
const external = process.env.SAND_EXTERNAL_REPO;
test(
  "external clsx through actual stdio: source, selection, explanation, stale edits and session end",
  { skip: !external },
  async () => {
    const client = new Client({ name: "protocol-test", version: "1" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [
          "--experimental-strip-types",
          "server/main.ts",
          "--workspace",
          `clsx=${external}`,
        ],
      }),
    );
    try {
      const raw = (name: string, args: Record<string, unknown>) =>
        client.callTool({ name, arguments: args });
      const call = async (name: string, args: Record<string, unknown>) => {
        const r = await raw(name, args);
        assert.ok(!r.isError, JSON.stringify(r));
        return resultData(r);
      };
      const tools = await client.listTools();
      assert.ok(tools.tools.some((t) => t.name === "sand_read_context"));
      const opened = await raw("sand_open_board", { preset: "code" });
      assert.ok(
        !(opened.structuredContent as any).data.objects,
        "Model result must be a compact summary",
      );
      const b = resultData(opened),
        boardId = b.id;
      const found = await call("sand_find_objects", {
        boardId,
        query: "src/index.js",
        kind: "symbol",
        limit: 1,
      });
      assert.equal(found.objects.length, 1);
      assert.ok(found.nextOffset !== null);
      const next = await call("sand_find_objects", {
        boardId,
        query: "src/index.js",
        kind: "symbol",
        limit: 1,
        offset: found.nextOffset,
      });
      assert.notEqual(next.objects[0].id, found.objects[0].id);
      const exact = await call("sand_find_objects", {
        boardId,
        objectIds: [found.objects[0].id],
      });
      assert.equal(exact.total, 1);
      const o = b.objects.find(
        (o: any) => o.source?.path === "src/index.js" && o.title === "clsx",
      );
      assert.ok(o);
      const source = await call("sand_read_source", {
        boardId,
        objectId: o.id,
      });
      assert.match(source.text, /toVal/);
      const updated = await call("sand_edit_view", {
        boardId,
        revision: b.revision,
        selection: [o.id],
        note: { objectId: o.id, text: "Explain this path" },
      });
      const ctx = await call("sand_read_context", { boardId });
      assert.deepEqual(ctx.selection, [o.id]);
      assert.equal(ctx.notes[o.id], "Explain this path");
      await call("sand_explain", {
        boardId,
        agentId: "Protocol test client",
        text: "Scripted test interpretation, not an AI response.",
        evidence: [o.source],
      });
      assert.ok(
        (
          await raw("sand_edit_view", {
            boardId,
            revision: updated.revision,
            selection: [],
          })
        ).isError,
      );
      assert.ok(
        (
          await raw("sand_explain", {
            boardId,
            agentId: "test",
            text: "bad reference",
            evidence: [{ ...o.source, hash: "bad" }],
          })
        ).isError,
      );
      const current = await call("sand_read_board", { boardId });
      const guideDraft = fixtureGuide(current);
      const guided = await call("sand_publish_guide", {
        boardId,
        revision: current.revision,
        ...guideDraft,
      });
      assert.equal(guided.guides.length, 1);
      assert.deepEqual(guided.selection, [o.id]);
      const focus = { guideId: guided.guides[0].id, step: 1 };
      await call("sand_focus", {
        boardId,
        revision: guided.revision,
        guideFocus: focus,
      });
      const guideContext = await call("sand_read_context", { boardId });
      assert.deepEqual(guideContext.guideFocus, focus);
      assert.equal(guideContext.objects[0].title, "toVal");
      const now = await call("sand_read_board", { boardId });
      assert.ok(
        (
          await raw("sand_publish_guide", {
            boardId,
            revision: now.revision,
            ...guideDraft,
            steps: [
              {
                ...guideDraft.steps[0],
                evidence: [{ ...o.source, hash: "stale" }],
              },
            ],
          })
        ).isError,
      );
      assert.ok(
        (
          await raw("sand_publish_guide", {
            boardId,
            revision: now.revision,
            ...guideDraft,
            steps: [
              {
                ...guideDraft.steps[0],
                objectIds: [guideDraft.steps[1].objectIds[0]],
              },
            ],
          })
        ).isError,
      );
      const excerpt = await call("sand_read_source", {
        boardId,
        objectId: o.id,
        startLine: o.source.startLine + 1,
        maxLines: 2,
      });
      assert.equal(excerpt.reference.startLine, o.source.startLine + 1);
      assert.equal(excerpt.reference.endLine, o.source.startLine + 2);
      await call("sand_explain", {
        boardId,
        agentId: "test",
        text: "Partial reference test",
        evidence: [excerpt.reference],
      });
      assert.ok(
        (
          await raw("sand_read_source", {
            boardId,
            objectId: o.id,
            startLine: o.source.endLine + 1,
          })
        ).isError,
      );
      const resource = await client.readResource({
        uri: "ui://sand-table/overview.html",
      });
      assert.ok("text" in resource.contents[0]);
      await call("sand_end_board", { boardId });
      assert.ok((await raw("sand_read_board", { boardId })).isError);
    } finally {
      await client.close();
    }
  },
);
