// T23：科研 PDF、文件夹读取，以及停用科研包后工具少一个。

import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { bridgeEntry } from "../local/service.ts";
import { createServerV3 } from "../server/server.ts";

const CORE_TOOLS = [
  "sand_activity",
  "sand_context",
  "sand_edit",
  "sand_history",
  "sand_query",
  "sand_read",
  "sand_status",
  "sand_types",
];

function pdf(text: string) {
  const stream = `BT /F1 12 Tf 50 750 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const at = Buffer.byteLength(body);
  return (
    body +
    `xref\n0 6\n0000000000 65535 f \n${offsets
      .slice(1)
      .map((offset) => String(offset).padStart(10, "0") + " 00000 n ")
      .join("\n")}\ntrailer << /Size 6 /Root 1 0 R >>\nstartxref\n${at}\n%%EOF`
  );
}

async function open(folder?: string) {
  const root = mkdtempSync(join(tmpdir(), "sand-research-"));
  const created = createServerV3({
    workspaceRoot: root,
    workspaceId: "research",
    ...(folder ? { folder } : {}),
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "research-tester", version: "1" });
  await Promise.all([
    client.connect(clientTransport),
    created.server.connect(serverTransport),
  ]);
  return {
    client,
    close: async () => {
      created.dispose();
      await client.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { type: string; text?: string }[])[0]?.text;
  let data: Record<string, unknown> = {};
  if (text) {
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      data = { text };
    }
  }
  return { isError: Boolean(result.isError), text: text ?? "", data };
}

async function modelTools(client: Client) {
  const listed = await client.listTools();
  return listed.tools
    .filter((tool) => {
      const visibility = (
        tool._meta as { ui?: { visibility?: string[] } } | undefined
      )?.ui?.visibility;
      return !visibility || visibility.includes("model");
    })
    .map((tool) => tool.name)
    .sort();
}

test("读页、导入证据、指纹失效、撤销", async () => {
  const session = await open();
  const root = mkdtempSync(join(tmpdir(), "sand-research-pdf-"));
  const path = join(root, "paper.pdf");
  try {
    writeFileSync(path, pdf("Evidence from a real PDF page."));
    const read = await call(session.client, "research_pdf", {
      action: "read",
      path,
      page: 1,
    });
    assert.equal(read.isError, false, read.text);
    assert.match(String(read.data.text), /real PDF page/);
    assert.equal(read.data.page, 1);
    assert.equal(read.data.pageCount, 1);
    assert.equal(read.data.fragment, "page=1");
    assert.match(String(read.data.fingerprint), /^sha256:[0-9a-f]{64}$/);
    const citation = read.data.citation as {
      kind: string;
      fragment: string;
      fingerprint: string;
    };
    assert.equal(citation.kind, "pdf");
    assert.equal(citation.fragment, "page=1");
    assert.equal(citation.fingerprint, read.data.fingerprint);

    const outOfRange = await call(session.client, "research_pdf", {
      action: "read",
      path,
      page: 2,
    });
    assert.equal(outOfRange.isError, true);
    assert.match(outOfRange.text, /越界/);

    const state = await call(session.client, "sand_status");
    assert.equal(state.isError, false, state.text);
    const home = state.data.homeBoardId as string;
    const opened = await call(session.client, "app_view", {
      action: "navigate",
      viewId: "paper",
      boardId: home,
    });
    assert.equal(opened.isError, false, opened.text);
    const current = await call(session.client, "sand_status");
    const revision = (current.data.workspace as { revision: number }).revision;

    const imported = await call(session.client, "research_pdf", {
      action: "import_evidence",
      path,
      page: 1,
      boardId: home,
      viewId: "paper",
      revision,
      title: "PDF 证据",
    });
    assert.equal(imported.isError, false, imported.text);
    const objectId = imported.data.objectId as string;
    assert.ok(objectId, "导入要返回证据编号");

    const found = await call(session.client, "sand_query", {
      types: ["research.evidence"],
    });
    assert.equal(found.isError, false, found.text);
    assert.equal(found.data.total, 1);
    const rows = found.data.rows as { id: string }[];
    assert.equal(rows[0]?.id, objectId);

    const onBoard = await call(session.client, "sand_query", {
      boardId: home,
      types: ["research.evidence"],
    });
    assert.equal(onBoard.data.total, 1);

    const full = await call(session.client, "sand_read", { ids: [objectId] });
    const evidence = (
      full.data.objects as {
        data: {
          status: string;
          citation: { kind: string; fragment: string; fingerprint: string };
          quote?: string;
        };
      }[]
    )[0];
    assert.equal(evidence?.data.status, "valid");
    assert.equal(evidence?.data.citation.kind, "pdf");
    assert.equal(evidence?.data.citation.fragment, "page=1");
    assert.equal(evidence?.data.citation.fingerprint, citation.fingerprint);
    assert.match(evidence?.data.quote ?? "", /real PDF page/);

    writeFileSync(path, pdf("Changed evidence."));
    const stale = await call(session.client, "research_pdf", {
      action: "verify_citation",
      citation: evidence?.data.citation,
    });
    assert.equal(stale.isError, false, stale.text);
    assert.equal(stale.data.status, "stale");
    assert.equal(
      (stale.data.citation as { fingerprint: string }).fingerprint,
      citation.fingerprint,
    );
    assert.notEqual(stale.data.observedFingerprint, citation.fingerprint);
    assert.match(String(stale.data.reason), /失效/);

    const unchanged = await call(session.client, "sand_read", {
      ids: [objectId],
    });
    const still = (
      unchanged.data.objects as {
        data: { status: string; citation: { fingerprint: string } };
      }[]
    )[0];
    assert.equal(still?.data.status, "valid");
    assert.equal(still?.data.citation.fingerprint, citation.fingerprint);

    unlinkSync(path);
    const missing = await call(session.client, "research_pdf", {
      action: "verify_citation",
      citation: evidence?.data.citation,
    });
    assert.equal(missing.data.status, "missing");
    assert.equal(
      (missing.data.citation as { fingerprint: string }).fingerprint,
      citation.fingerprint,
    );
    assert.match(String(missing.data.reason), /失效/);

    const undone = await call(session.client, "sand_history", {
      action: "undo",
    });
    assert.equal(undone.isError, false, undone.text);
    const afterUndo = await call(session.client, "sand_query", {
      types: ["research.evidence"],
    });
    assert.equal(afterUndo.data.total, 0);

    const redone = await call(session.client, "sand_history", {
      action: "redo",
    });
    assert.equal(redone.isError, false, redone.text);
    const afterRedo = await call(session.client, "sand_query", {
      types: ["research.evidence"],
    });
    assert.equal(afterRedo.data.total, 1);
  } finally {
    await session.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("没有文本的 PDF 不编造 OCR，给了摘要才能导入", async () => {
  const session = await open();
  const root = mkdtempSync(join(tmpdir(), "sand-research-blank-"));
  const path = join(root, "scan.pdf");
  try {
    writeFileSync(path, pdf(""));
    const read = await call(session.client, "research_pdf", {
      action: "read",
      path,
      page: 1,
    });
    assert.equal(read.isError, false, read.text);
    assert.equal(read.data.text, "");

    const state = await call(session.client, "sand_status");
    const home = state.data.homeBoardId as string;
    await call(session.client, "app_view", {
      action: "navigate",
      viewId: "paper",
      boardId: home,
    });
    const revision = (
      (await call(session.client, "sand_status")).data.workspace as {
        revision: number;
      }
    ).revision;
    const refused = await call(session.client, "research_pdf", {
      action: "import_evidence",
      path,
      page: 1,
      boardId: home,
      viewId: "paper",
      revision,
      title: "空白页",
    });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /摘要|OCR/);
    const empty = await call(session.client, "sand_query", {
      types: ["research.evidence"],
    });
    assert.equal(empty.data.total, 0);

    const imported = await call(session.client, "research_pdf", {
      action: "import_evidence",
      path,
      page: 1,
      boardId: home,
      viewId: "paper",
      revision,
      title: "空白页",
      summary: "这是一页扫描件，正文要人来补。",
    });
    assert.equal(imported.isError, false, imported.text);
    const found = await call(session.client, "sand_query", {
      types: ["research.evidence"],
    });
    assert.equal(found.data.total, 1);
  } finally {
    await session.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("停用 research 包后模型少一个 research_pdf，重新启用后恢复", async () => {
  const session = await open();
  try {
    const before = await modelTools(session.client);
    assert.deepEqual(before, [...CORE_TOOLS, "research_pdf"].sort());
    assert.equal(before.includes("folder_read"), false);
    assert.equal(before.includes("code_repo"), false);

    const disabled = await call(session.client, "sand_edit", {
      commands: [{ op: "pack.disable", id: "research" }],
    });
    assert.equal(disabled.isError, false, disabled.text);
    const without = await modelTools(session.client);
    assert.deepEqual(without, [...CORE_TOOLS].sort());
    assert.equal(without.length, before.length - 1);
    assert.equal(without.includes("research_pdf"), false);

    const enabled = await call(session.client, "sand_edit", {
      commands: [{ op: "pack.enable", id: "research" }],
    });
    assert.equal(enabled.isError, false, enabled.text);
    assert.deepEqual(await modelTools(session.client), before);
  } finally {
    await session.close();
  }
});

test("只在绑定文件夹时注册 folder_read，并且只读这个目录", async () => {
  const unbound = await open();
  try {
    assert.equal(
      (await modelTools(unbound.client)).includes("folder_read"),
      false,
    );
  } finally {
    await unbound.close();
  }

  const root = mkdtempSync(join(tmpdir(), "sand-folder-bound-"));
  const session = await open(root);
  try {
    writeFileSync(join(root, "note.md"), "# 标题\n");
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "sub", "code.ts"), "export const n = 1;\n");
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, "node_modules", "secret.js"), "secret");
    writeFileSync(join(root, "blob.bin"), Buffer.from([0, 1, 2]));
    symlinkSync("note.md", join(root, "link.md"));

    const listed = await session.client.listTools();
    const tool = listed.tools.find((item) => item.name === "folder_read");
    assert.ok(tool, "绑定文件夹后要有 folder_read");
    const properties = (
      tool.inputSchema as { properties?: Record<string, unknown> }
    ).properties;
    assert.equal(properties?.root, undefined, "不能由调用方指定别的目录");
    assert.ok(properties?.kind);
    assert.equal(
      (tool._meta as { ui?: { visibility?: string[] } } | undefined)?.ui
        ?.visibility,
      undefined,
    );

    const read = await call(session.client, "folder_read", { kind: "file" });
    assert.equal(read.isError, false, read.text);
    const contents = read.data.contents as { id: string; text: string }[];
    assert.deepEqual(contents.map((item) => item.id).sort(), [
      "folder:note.md",
      "folder:sub/code.ts",
    ]);
    assert.match(
      contents.find((item) => item.id === "folder:note.md")!.text,
      /标题/,
    );
    const omitted = read.data.omitted as string[];
    assert.ok(omitted.some((item) => item.includes("link.md: symlink")));
    assert.ok(omitted.some((item) => item.includes("blob.bin: binary file")));

    const filtered = await call(session.client, "folder_read", {
      kind: "file",
      paths: ["note.md"],
    });
    const kept = filtered.data.contents as { id: string }[];
    assert.deepEqual(
      kept.map((item) => item.id),
      ["folder:note.md"],
    );

    const rejected = await call(session.client, "folder_read", { kind: "pdf" });
    assert.equal(rejected.isError, true);
    assert.match(rejected.text, /未声明读取种类/);

    const before = await modelTools(session.client);
    assert.equal(before.includes("folder_read"), true);
    assert.equal(before.includes("research_pdf"), true);
    const enabled = await call(session.client, "app_edit", {
      commands: [{ op: "pack.enable", id: "code" }],
    });
    assert.equal(enabled.isError, false, enabled.text);
    const after = await modelTools(session.client);
    assert.deepEqual(
      after.filter((name) => !before.includes(name)),
      ["code_change", "code_repo"],
    );
    assert.equal(after.includes("folder_read"), true);

    const disabled = await call(session.client, "sand_edit", {
      commands: [{ op: "pack.disable", id: "research" }],
    });
    assert.equal(disabled.isError, false, disabled.text);
    const withoutResearch = await modelTools(session.client);
    assert.equal(withoutResearch.includes("research_pdf"), false);
    assert.equal(withoutResearch.includes("folder_read"), true);
    assert.equal(withoutResearch.includes("code_repo"), true);
  } finally {
    await session.close();
    rmSync(root, { recursive: true, force: true });
  }

  const missing = await open(join(root, "gone"));
  try {
    const failed = await call(missing.client, "folder_read", { kind: "file" });
    assert.equal(failed.isError, true);
    assert.match(failed.text, /文件夹不存在/);
  } finally {
    await missing.close();
  }
});

test("桥接条目在设置了 SAND_FOLDER 时带上同一个目录", () => {
  const previous = process.env.SAND_FOLDER;
  const sessionFile = join(tmpdir(), "sand-research-session.json");
  try {
    delete process.env.SAND_FOLDER;
    const plain = bridgeEntry(undefined, sessionFile);
    assert.equal(plain.env?.SAND_FOLDER, undefined);

    process.env.SAND_FOLDER = "/tmp/sand-bound-folder";
    const bound = bridgeEntry(undefined, sessionFile);
    assert.equal(bound.env?.SAND_FOLDER, "/tmp/sand-bound-folder");
  } finally {
    if (previous === undefined) delete process.env.SAND_FOLDER;
    else process.env.SAND_FOLDER = previous;
  }
});
