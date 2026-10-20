import { test } from "node:test";
import assert from "node:assert/strict";
import { pythonSymbols } from "../domains/code/python-indexer.ts";
import { bind } from "../connectors/git.ts";
import { scan, sourceFor } from "../domains/code/indexer.ts";
test("Python parsing does not execute inspected text and prefers the final definition over overload stubs", () => {
  const source =
    'raise RuntimeError("MUST NOT EXECUTE")\n@overload\ndef entry(value: str): ...\ndef helper(value):\n    return value\ndef entry(value):\n    return helper(value)\n';
  const result = pythonSymbols("fixture.py", source);
  assert.ok(!result.error, result.error);
  assert.equal(result.symbols.length, 2);
  const entry = result.symbols.find((s) => s.name === "entry")!;
  assert.equal(entry.startLine, 6);
  assert.deepEqual(entry.calls, ["helper"]);
  assert.ok(pythonSymbols("invalid.py", "def broken(:").error);
});
const hf = process.env.SAND_PYTHON_REPO;
test(
  "external Hugging Face Hub: root README and actual snapshot_download implementation have valid source references",
  { skip: !hf },
  () => {
    const bindings = bind([`huggingface=${hf}`]),
      p = scan(bindings);
    assert.ok(p.objects.some((o) => o.source?.path === "README.md"));
    const o = p.objects.find(
      (o) =>
        o.title === "snapshot_download" &&
        o.source?.path === "src/huggingface_hub/_snapshot_download.py",
    );
    assert.ok(o);
    const excerpt = sourceFor(bindings, o, { maxLines: 6 });
    assert.match(excerpt.text, /def snapshot_download/);
    assert.doesNotMatch(excerpt.text, /@overload/);
    assert.equal(excerpt.reference.hash, o.source!.hash);
    assert.ok(p.workspaces[0].omitted.length > 0);
    console.log(
      `HF index: ${p.workspaces[0].files} files, ${p.objects.length} objects; omissions reported.`,
    );
  },
);
