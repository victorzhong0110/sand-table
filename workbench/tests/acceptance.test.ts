import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seal, blind, score, assignment } from "../acceptance/kit.ts";
test("acceptance materials separate solver, private references and anonymous scoring", () => {
  const root = mkdtempSync(join(tmpdir(), "sand-eval-"));
  try {
    const t = {
      repository: "https://github.com/external/project",
      baseCommit: "a".repeat(40),
      task: "Unit-only task",
      setup: "No scripts",
      constraints: "Only fixture",
      license: "Fixture",
      publicDate: "2026-01-01",
      contaminationDisclosure: "Synthetic unit, not product evidence",
      criteria: [{ id: "correct", description: "Correct behavior", weight: 1 }],
      reference: "Secret reference",
      graderNotes: "Secret grader",
    };
    const s = seal(t, join(root, "sealed")),
      packet = JSON.parse(readFileSync(join(s.solver, "task.json"), "utf8"));
    assert.ok(!JSON.stringify(packet).includes("Secret"));
    assert.throws(
      () =>
        seal(
          { ...t, repository: "https://github.com/victorzhong0110/sand-table" },
          join(root, "bad"),
        ),
      /external/,
    );
    const patch = join(root, "patch"),
      explanation = join(root, "explanation");
    writeFileSync(patch, "diff --git a/a b/a\n");
    writeFileSync(explanation, "Behavior and evidence");
    const b = blind(
      {
        taskDigest: s.digest,
        candidates: [
          { patch, explanation, condition: "board", operator: "a" },
          { patch, explanation, condition: "chat", operator: "b" },
        ],
      },
      join(root, "blind"),
    );
    assert.equal(b.candidates, 2);
    const key = JSON.parse(
      readFileSync(join(root, "blind/private/key.json"), "utf8"),
    ).keys[0];
    const review = JSON.parse(
      readFileSync(join(b.review, key.id + ".json"), "utf8"),
    );
    assert.equal(review.condition, undefined);
    const reviews = [
      {
        candidateId: key.id,
        taskDigest: s.digest,
        scorer: "independent",
        scores: { correct: 3 },
        evidence: "Observed unit evidence",
      },
    ];
    assert.equal(score(packet, reviews)[0].weightedScore, 3);
    assert.throws(
      () => score(packet, [{ ...reviews[0], condition: "board" }]),
      /blind/,
    );
    const plan = assignment(["one", "two"], ["task-a", "task-b"]);
    assert.equal(plan.filter((x) => x.condition === "board").length, 2);
    assert.equal(new Set(plan.map((x) => x.operator + ":" + x.task)).size, 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
