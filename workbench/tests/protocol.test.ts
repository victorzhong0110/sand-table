import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { resultData } from "../board/data-client/results.ts";

const external = process.env.SAND_EXTERNAL_REPO;

test(
  "external clsx through actual stdio: import, query, source excerpt, and the board resource",
  { skip: !external },
  async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "sand-protocol-"));
    const client = new Client({ name: "protocol-test", version: "1" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [
          "--experimental-strip-types",
          "server/main.ts",
          "--workspace-dir",
          workspaceDir,
          "--workspace-id",
          "protocol",
        ],
      }),
    );
    try {
      const raw = (name: string, args: Record<string, unknown> = {}) =>
        client.callTool({ name, arguments: args });
      const call = async (name: string, args: Record<string, unknown> = {}) => {
        const r = await raw(name, args);
        assert.ok(!r.isError, JSON.stringify(r));
        return resultData(r);
      };
      const tools = await client.listTools();
      assert.ok(tools.tools.some((t) => t.name === "sand_context"));
      await call("app_edit", {
        commands: [{ op: "pack.enable", id: "code" }],
      });
      const withCode = await client.listTools();
      assert.ok(withCode.tools.some((t) => t.name === "code_repo"));
      const status = await call("sand_status");
      assert.equal(typeof status.homeBoardId, "string");
      assert.ok(status.homeBoardId);
      const imported = await call("code_repo", {
        action: "import",
        path: external,
      });
      assert.equal(typeof imported.repositoryId, "string");
      const found = await call("sand_query", {
        types: ["code.file"],
        text: "src/index.js",
        limit: 20,
      });
      const rows = found.rows as { id: string; title: string }[];
      const file = rows.find((row) => row.title === "src/index.js");
      assert.ok(file, JSON.stringify(rows.map((row) => row.title)));
      const source = await call("code_repo", {
        action: "read_source",
        objectId: file.id,
      });
      assert.match(String(source.text), /toVal/);
      const resource = await client.readResource({
        uri: "ui://sand-table/overview.html",
      });
      assert.ok("text" in resource.contents[0]);
    } finally {
      await client.close();
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  },
);
