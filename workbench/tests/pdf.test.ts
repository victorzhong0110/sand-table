import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readPdf } from "../connectors/pdf.ts";
import { registerResearchTools } from "../domains/research/tools.ts";
import { registerAllDomains } from "../domains/index.ts";
import { BoardStore } from "../core/store.ts";
import { openView } from "../core/space-state.ts";
import { workspacePort } from "../core/persistence.ts";
import { WorkspaceStore } from "../core/workspace.ts";
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
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(body));
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const at = Buffer.byteLength(body);
  return (
    body +
    `xref\n0 6\n0000000000 65535 f \n${offsets
      .slice(1)
      .map((o) => String(o).padStart(10, "0") + " 00000 n ")
      .join("\n")}\ntrailer << /Size 6 /Root 1 0 R >>\nstartxref\n${at}\n%%EOF`
  );
}
test("real PDF extraction, evidence import, persistence, changed and missing source", async () => {
  const root = mkdtempSync(join(tmpdir(), "sand-pdf-")),
    path = join(root, "paper.pdf");
  try {
    registerAllDomains();
    writeFileSync(path, pdf("Evidence from a real PDF page."));
    const read = await readPdf(path, 1);
    assert.match(read.text, /real PDF page/);
    assert.equal(read.pageCount, 1);
    await assert.rejects(readPdf(path, 2), /越界/);
    const store = new BoardStore(() => 1_700_000_000_000);
    store.attachPersistence(workspacePort(new WorkspaceStore(root)), "default");
    const board = store.open(
      { objects: [], relations: [], workspaces: [] },
      "Research",
    );
    openView(store.get(board.id), "view");
    const tools = new Map<string, any>();
    registerResearchTools(
      ((name: any, _desc: any, _shape: any, fn: any) =>
        tools.set(name, fn)) as any,
      store,
    );
    await tools.get("sand_import_pdf_evidence")({
      path,
      page: 1,
      boardId: board.id,
      viewId: "view",
      revision: store.get(board.id).revision,
      title: "PDF evidence",
    });
    store.undo(board.id, "human");
    assert.equal(store.get(board.id).contentObjects.length, 0);
    assert.equal(store.get(board.id).resources.length, 0);
    assert.equal(store.get(board.id).instances.length, 0);
    store.redo(board.id, "human");
    const live = store.get(board.id);
    const presentations = live.instances;
    live.instances = Array.from({ length: 2200 }, (_, i) => ({
      ...structuredClone(live.instances[0]),
      id: `full-${i}`,
    }));
    const before = JSON.stringify(live),
      generation = store.generation;
    await assert.rejects(
      tools.get("sand_import_pdf_evidence")({
        path,
        page: 1,
        boardId: board.id,
        viewId: "view",
        revision: live.revision,
        title: "must roll back",
      }),
      /Component limit/,
    );
    assert.equal(
      JSON.stringify(live),
      before,
      "failure leaves content, resources, history, audit and revision unchanged",
    );
    assert.equal(
      store.generation,
      generation,
      "failed import is not marked dirty",
    );
    live.instances = presentations;
    await store.flushSave();
    const reopened = new WorkspaceStore(root).load("default").workspace;
    assert.equal(reopened.objects.length, 1);
    assert.equal(reopened.boards[0].presentations.length, 1);
    assert.equal(reopened.resources[0].fragment, "p.1");
    const citation = (reopened.objects[0].data as any).citation;
    assert.equal(
      tools.get("sand_verify_pdf_citation")({ citation }).status,
      "valid",
    );
    writeFileSync(path, pdf("Changed evidence."));
    const stale = tools.get("sand_verify_pdf_citation")({ citation });
    assert.equal(stale.status, "stale");
    assert.equal(stale.fingerprint, citation.fingerprint);
    unlinkSync(path);
    assert.equal(
      tools.get("sand_verify_pdf_citation")({ citation }).status,
      "missing",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
