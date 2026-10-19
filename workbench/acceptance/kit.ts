import { createHash, randomBytes, randomInt } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
function write(dir: string, name: string, value: unknown) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, name);
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
}
function text(v: unknown, label: string, max = 20000): string {
  if (typeof v !== "string" || !v.trim() || v.length > max)
    throw Error(
      label + " must be non-empty text, at most " + max + " characters.",
    );
  return v;
}
export function seal(input: any, out: string) {
  const repository = text(input.repository, "repository", 300);
  if (!/^https:\/\/github.com\/[^/\s]+\/[^/\s]+\/?$/.test(repository))
    throw Error("Use an explicit external GitHub repository URL.");
  if (/victorzhong0110\/(sand-table|llm-research-os)/i.test(repository))
    throw Error("Acceptance tasks must use an external repository.");
  const baseCommit = text(input.baseCommit, "baseCommit", 40);
  if (!/^[a-f0-9]{40}$/.test(baseCommit))
    throw Error("Use a full immutable base commit.");
  if (
    !Array.isArray(input.criteria) ||
    input.criteria.length < 1 ||
    input.criteria.length > 20
  )
    throw Error("Provide 1–20 preregistered criteria.");
  const criteria = input.criteria.map((c: any) => ({
    id: text(c.id, "criterion id", 80),
    description: text(c.description, "criterion", 2000),
    weight: Number(c.weight),
  }));
  if (
    new Set(criteria.map((c: any) => c.id)).size !== criteria.length ||
    criteria.some((c: any) => !Number.isFinite(c.weight) || c.weight <= 0)
  )
    throw Error("Criteria need unique IDs and positive weights.");
  const packet = {
    schema: 1,
    repository,
    baseCommit,
    task: text(input.task, "task"),
    setup: text(input.setup, "setup"),
    constraints: text(input.constraints, "constraints"),
    license: text(input.license, "license", 1000),
    publicDate: text(input.publicDate, "publicDate", 100),
    contaminationDisclosure: text(
      input.contaminationDisclosure,
      "contamination disclosure",
      3000,
    ),
    criteria,
  };
  const digest = hash(JSON.stringify(canonical(packet)));
  const solver = join(out, "solver"),
    privateDir = join(out, "private");
  if (existsSync(out)) throw Error("Output must be a new directory.");
  write(solver, "task.json", { ...packet, digest });
  write(privateDir, "seal.json", {
    digest,
    sealedAt: new Date().toISOString(),
    reference: text(input.reference, "private historical reference", 20000),
    graderNotes: text(input.graderNotes, "private grader notes", 20000),
    warning:
      "Never give this directory to the solver. Sealing is a procedural boundary, not proof the model has never seen a public answer.",
  });
  return { digest, solver, privateDir };
}
export function blind(input: any, out: string) {
  if (
    !Array.isArray(input.candidates) ||
    input.candidates.length < 2 ||
    input.candidates.length > 20
  )
    throw Error("Provide 2–20 candidate artifacts.");
  const candidates = [...input.candidates];
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  if (existsSync(out)) throw Error("Output must be a new directory.");
  const keys: any[] = [];
  for (const c of candidates) {
    const id = randomBytes(8).toString("hex");
    const patch = readFileSync(
      resolve(text(c.patch, "patch path", 2000)),
      "utf8",
    );
    const explanation = readFileSync(
      resolve(text(c.explanation, "explanation path", 2000)),
      "utf8",
    );
    if (patch.length > 2_000_000 || explanation.length > 100000)
      throw Error("Candidate artifact too large.");
    // Input patches must be git diff output, without email/commit author headers.
    if (/^(From [a-f0-9]{40}|From:|Author:|Subject:)/m.test(patch))
      throw Error("Use raw git diff, not an authored mail patch.");
    write(join(out, "review"), id + ".json", {
      id,
      taskDigest: text(input.taskDigest, "task digest", 64),
      patch,
      explanation,
      artifactDigest: hash(patch + "\0" + explanation),
    });
    keys.push({
      id,
      condition: text(c.condition, "private condition", 100),
      operator: text(c.operator, "private operator", 100),
      patchPath: resolve(c.patch),
      explanationPath: resolve(c.explanation),
    });
  }
  write(join(out, "private"), "key.json", {
    keys,
    warning:
      "Keep hidden from scorers until scores are frozen. Inspect artifacts for identity clues before distribution.",
  });
  return { candidates: keys.length, review: join(out, "review") };
}
export function score(task: any, reviews: any[]) {
  if (!Array.isArray(task.criteria) || !task.digest)
    throw Error("Read a sealed solver task.");
  const { digest, ...packet } = task;
  if (hash(JSON.stringify(canonical(packet))) !== digest)
    throw Error(
      "Sealed task content changed; criteria and scope must be frozen before scoring.",
    );
  const groups = new Map<string, any[]>();
  for (const r of reviews) {
    if (r.taskDigest !== task.digest)
      throw Error("Review task digest mismatch.");
    text(r.candidateId, "anonymous candidate ID", 100);
    text(r.scorer, "scorer ID", 100);
    text(r.evidence, "review evidence", 20000);
    if (r.condition !== undefined)
      throw Error("Scoring inputs must remain blind.");
    const group = groups.get(r.candidateId) || [];
    if (group.some((x) => x.scorer === r.scorer))
      throw Error("Duplicate scorer for candidate.");
    for (const c of task.criteria)
      if (
        !Number.isFinite(r.scores?.[c.id]) ||
        r.scores[c.id] < 0 ||
        r.scores[c.id] > 4
      )
        throw Error("Each criterion needs a score from 0 to 4.");
    group.push(r);
    groups.set(r.candidateId, group);
  }
  return [...groups].map(([candidateId, rs]) => ({
    candidateId,
    scorers: rs.length,
    weightedScore:
      rs.reduce(
        (sum, r) =>
          sum +
          task.criteria.reduce(
            (n: number, c: any) => n + r.scores[c.id] * c.weight,
            0,
          ) /
            task.criteria.reduce((n: number, c: any) => n + c.weight, 0),
        0,
      ) / rs.length,
    evidence: rs.map((r) => ({ scorer: r.scorer, evidence: r.evidence })),
    interpretation:
      "Blind artifact scores only; no causal claim about the interface without controlled operators, model, budget and task allocation.",
  }));
}
export function assignment(operators: string[], tasks: string[]) {
  if (
    operators.length < 2 ||
    tasks.length < 2 ||
    new Set(operators).size !== operators.length ||
    new Set(tasks).size !== tasks.length
  )
    throw Error("Use at least two distinct operators and tasks.");
  return operators.flatMap((operator, i) =>
    tasks.map((task, j) => ({
      operator,
      task,
      condition: (i + j) % 2 ? "chat" : "board",
      order: j + 1,
    })),
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [command, inputFile, out] = process.argv.slice(2);
  try {
    if (!inputFile)
      throw Error(
        "Usage: kit.ts seal|blind|score|assign input.json [new-output-directory]",
      );
    const input = JSON.parse(readFileSync(resolve(inputFile), "utf8"));
    if ((command === "seal" || command === "blind") && !out)
      throw Error(
        "Specify a new output directory outside the solver workspace.",
      );
    const result =
      command === "seal"
        ? seal(input, resolve(out))
        : command === "blind"
          ? blind(input, resolve(out))
          : command === "score"
            ? score(input.task, input.reviews)
            : command === "assign"
              ? assignment(input.operators, input.tasks)
              : (() => {
                  throw Error("Unknown command");
                })();
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  }
}
