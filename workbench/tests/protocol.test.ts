import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
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
        return (r.structuredContent as any).data;
      };
      const tools = await client.listTools();
      assert.ok(tools.tools.some((t) => t.name === "sand_read_context"));
      const b = await call("sand_open_board", {}),
        boardId = b.id;
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
