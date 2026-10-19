import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { BoardStore } from "../core/store.ts";
import type { Binding } from "./repository.ts";
import type { FileRef, FileTarget, Proposal } from "../core/changes.ts";
import { proposalSummary } from "../core/changes.ts";
import { viewResult } from "../core/results.ts";
import {
  currentFile,
  worktreeState,
  digest,
  validatePath,
} from "./worktree.ts";
import type { RegisterTool } from "./tool-types.ts";
const id = z.string().min(1).max(500),
  board = { boardId: id };
const ref = z.object({ workspaceId: id, path: id });
const key = (r: FileRef) => `${r.workspaceId}:${r.path}`;
export class Changes {
  store: BoardStore;
  bindings: Binding[];
  constructor(store: BoardStore, bindings: Binding[]) {
    this.store = store;
    this.bindings = bindings;
  }
  intent(boardId: string, intentId: string) {
    const b = this.store.get(boardId),
      i = b.intents.find((i) => i.id === intentId);
    if (!i) throw Error("Unknown change intent.");
    return { b, i };
  }
  proposal(
    boardId: string,
    proposalId: string,
    version?: number,
    hash?: string,
  ) {
    const b = this.store.get(boardId),
      p = b.proposals.find((p) => p.id === proposalId);
    if (!p) throw Error("Unknown proposal.");
    if (version !== undefined && (p.version !== version || p.digest !== hash))
      throw Error(
        "Proposal content changed. Read and confirm the current version.",
      );
    return { b, p };
  }
  createIntent(
    boardId: string,
    revision: number,
    a: {
      request: string;
      objectIds: string[];
      allowedFiles: FileRef[];
      intentId?: string;
    },
  ) {
    const b = this.store.get(boardId);
    if (b.revision !== revision)
      throw Error("Board changed. Reload before submitting your intent.");
    this.store.ids(b, a.objectIds);
    for (const f of a.allowedFiles) {
      validatePath(f.path);
      if (!this.bindings.some((w) => w.id === f.workspaceId))
        throw Error("Unknown workspace.");
    }
    if (new Set(a.allowedFiles.map(key)).size !== a.allowedFiles.length)
      throw Error("Duplicate allowed file.");
    const old = a.intentId
      ? b.intents.find((i) => i.id === a.intentId)
      : undefined;
    if (a.intentId && !old) throw Error("Unknown intent.");
    if (!old && b.intents.length >= 8)
      throw Error("Intent limit reached; revise an existing intent.");
    const intent = {
      id: old?.id || randomUUID(),
      version: (old?.version || 0) + 1,
      request: a.request,
      objectIds: [...a.objectIds],
      allowedFiles: structuredClone(a.allowedFiles),
      arrangement: {
        placements: structuredClone(b.placements),
        notes: structuredClone(b.notes),
        groups: b.groups.map((g) => ({
          title: g.title,
          objectIds: [...g.objectIds],
        })),
      },
      createdAt: Date.now(),
    };
    b.intents = b.intents.filter((i) => i.id !== intent.id);
    b.intents.push(intent);
    for (const p of b.proposals)
      if (p.intentId === intent.id) p.decision = "stale";
    b.revision++;
    return this.store.read(boardId);
  }
  publish(
    boardId: string,
    a: {
      intentId: string;
      intentVersion: number;
      proposalId?: string;
      previousVersion?: number;
      agentId: string;
      title: string;
      explanation: string;
      testPlan: string;
      files: FileTarget[];
    },
  ) {
    const { b, i } = this.intent(boardId, a.intentId);
    if (i.version !== a.intentVersion)
      throw Error("Intent changed. Read the current intent.");
    const old = a.proposalId
      ? b.proposals.find((p) => p.id === a.proposalId)
      : undefined;
    if (a.proposalId && (!old || old.version !== a.previousVersion))
      throw Error("Proposal revision conflict.");
    if (old && old.intentId !== i.id)
      throw Error("Cannot replace a proposal belonging to another intent.");
    if (!old && b.proposals.length >= 12)
      throw Error("Proposal limit reached; replace an existing proposal.");
    if (new Set(a.files.map(key)).size !== a.files.length)
      throw Error("Duplicate proposal path.");
    let bytes = 0;
    const files = a.files.map((f) => {
      if (!i.allowedFiles.some((r) => key(r) === key(f)))
        throw Error("File is outside the human-requested edit scope.");
      const before = currentFile(this.bindings, f);
      if (before.hash !== f.beforeHash)
        throw Error(`Stale file baseline: ${f.path}`);
      if (f.after !== null) {
        if (f.after.includes("\0") || Buffer.byteLength(f.after) > 200000)
          throw Error("Target must be text of at most 200 KB.");
        bytes += Buffer.byteLength(f.after);
      }
      if (before.text === f.after)
        throw Error("Proposal has no change for " + f.path);
      return {
        ...f,
        before: before.text,
        afterHash: f.after === null ? null : digest(f.after),
      };
    });
    if (bytes > 1_000_000) throw Error("Proposal exceeds 1 MB.");
    const baseline = worktreeState(this.bindings, i.allowedFiles);
    for (const f of files) {
      const observed =
        baseline.find((s) => s.workspaceId === f.workspaceId)?.files[f.path]
          ?.hash ?? null;
      if (observed !== f.beforeHash)
        throw Error("Worktree changed during proposal capture. Retry.");
    }
    const version = (old?.version || 0) + 1,
      proposalId = old?.id || randomUUID();
    const hash = digest(
      JSON.stringify({
        id: proposalId,
        version,
        intentId: i.id,
        intentVersion: i.version,
        title: a.title,
        explanation: a.explanation,
        testPlan: a.testPlan,
        files: files.map(({ workspaceId, path, beforeHash, afterHash }) => ({
          workspaceId,
          path,
          beforeHash,
          afterHash,
        })),
      }),
    );
    const p: Proposal = {
      id: proposalId,
      version,
      digest: hash,
      intentId: i.id,
      intentVersion: i.version,
      agentId: a.agentId,
      title: a.title,
      explanation: a.explanation,
      testPlan: a.testPlan,
      files,
      baseline,
      decision: "pending",
    };
    b.proposals = b.proposals.filter((p) => p.id !== proposalId);
    b.proposals.push(p);
    b.validations = b.validations.filter((v) => v.proposalId !== p.id);
    b.revision++;
    return proposalSummary(p);
  }
  observe(boardId: string, p: Proposal) {
    const b = this.store.get(boardId);
    const states = worktreeState(this.bindings, p.files);
    const files = p.files.map((f) => {
      let actual: string | null;
      try {
        actual = currentFile(this.bindings, f).hash;
      } catch {
        return {
          workspaceId: f.workspaceId,
          path: f.path,
          state: "unexpected" as const,
          actualHash: null,
        };
      }
      const beforeMode = p.baseline.find((s) => s.workspaceId === f.workspaceId)
        ?.files[f.path]?.mode;
      const actualMode = states.find((s) => s.workspaceId === f.workspaceId)
        ?.files[f.path]?.mode;
      const modeChanged =
        beforeMode !== undefined &&
        actualMode !== undefined &&
        beforeMode !== actualMode;
      return {
        workspaceId: f.workspaceId,
        path: f.path,
        state: modeChanged
          ? ("unexpected" as const)
          : actual === f.afterHash
            ? ("after" as const)
            : actual === f.beforeHash
              ? ("before" as const)
              : ("unexpected" as const),
        actualHash: actual,
      };
    });
    const outsideChanges: FileRef[] = [];
    for (const state of states) {
      const before = p.baseline.find(
        (s) => s.workspaceId === state.workspaceId,
      )!;
      for (const path of new Set([
        ...Object.keys(before.files),
        ...Object.keys(state.files),
      ])) {
        if (
          p.files.some(
            (f) => f.workspaceId === state.workspaceId && f.path === path,
          )
        )
          continue;
        if (
          JSON.stringify(before.files[path]) !==
          JSON.stringify(state.files[path])
        )
          outsideChanges.push({ workspaceId: state.workspaceId, path });
      }
    }
    const omitted = [
      ...p.baseline.flatMap((s) => s.omitted),
      ...states.flatMap((s) => s.omitted),
    ];
    const allAfter = files.every((f) => f.state === "after"),
      allBefore = files.every((f) => f.state === "before");
    const state =
      outsideChanges.length || files.some((f) => f.state === "unexpected")
        ? "diverged"
        : omitted.length
          ? "incomplete"
          : allAfter
            ? "matches"
            : allBefore
              ? "not-applied"
              : "partial";
    p.verification = {
      at: Date.now(),
      state,
      files,
      outsideChanges,
      omitted,
      fingerprint: digest(
        JSON.stringify(
          states.map((s) => ({
            workspaceId: s.workspaceId,
            fingerprint: s.fingerprint,
          })),
        ),
      ),
    };
    b.revision++;
    return p.verification;
  }
  decide(
    boardId: string,
    proposalId: string,
    version: number,
    hash: string,
    decision: "accepted" | "rejected" | "revise",
  ) {
    const { b, p } = this.proposal(boardId, proposalId, version, hash);
    if (p.decision === "stale")
      throw Error("Proposal is stale. Ask the Agent to revise it.");
    if (decision === "accepted") {
      if (
        b.intents.find((i) => i.id === p.intentId)?.version !== p.intentVersion
      )
        throw Error("Intent changed.");
      const observation = this.observe(boardId, p);
      if (
        observation.files.some((f) => f.state !== "before") ||
        observation.outsideChanges.length
      ) {
        p.decision = "stale";
        throw Error("Actual worktree changed. Review a new proposal.");
      }
    }
    p.decision = decision;
    p.decidedAt = Date.now();
    b.revision++;
    return this.store.read(boardId);
  }
  prepare(boardId: string, proposalId: string, version: number, hash: string) {
    const { p } = this.proposal(boardId, proposalId, version, hash);
    if (p.decision !== "accepted")
      throw Error("This exact proposal version has not been accepted.");
    const verification = this.observe(boardId, p);
    if (verification.state === "diverged")
      throw Error(
        "Actual worktree differs from the confirmed proposal. Inspect verification and revise.",
      );
    return {
      proposal: proposalSummary(p),
      ready: verification.state !== "matches",
      coverageComplete: !verification.omitted.length,
      instruction:
        "Use the host file tools only. For each approved file, call sand_read_approved_file immediately before writing, compare its beforeHash with actual contents, write the exact after content, then call sand_verify_proposal. These checks are not an atomic write guarantee.",
    };
  }
}
export function registerChangeTools(tool: RegisterTool, changes: Changes) {
  tool(
    "sand_create_intent",
    "Human explicitly requests a code change and its allowed files; arrangement alone is not edit authorization.",
    {
      ...board,
      revision: z.number().int(),
      request: z.string().min(1).max(4000),
      objectIds: z.array(id).max(1200),
      allowedFiles: z.array(ref).min(1).max(12),
      intentId: id.optional(),
    },
    (a) => changes.createIntent(a.boardId, a.revision, a),
    true,
  );
  tool(
    "sand_read_intents",
    "Read explicit human change requests, exact edit scope and arrangement context.",
    { ...board },
    (a) => changes.store.get(a.boardId).intents,
  );
  tool(
    "sand_read_target",
    "Read a user-allowed target file or its absence, including untracked files. No writes.",
    {
      ...board,
      intentId: id,
      ...ref.shape,
      startLine: z.number().int().positive().default(1),
    },
    (a) => {
      const { i } = changes.intent(a.boardId, a.intentId);
      if (!i.allowedFiles.some((r) => key(r) === key(a)))
        throw Error("Outside requested edit scope.");
      const f = currentFile(changes.bindings, a);
      const lines = f.text?.split("\n");
      return {
        workspaceId: a.workspaceId,
        path: a.path,
        hash: f.hash,
        startLine: a.startLine,
        text:
          lines
            ?.slice(a.startLine - 1, a.startLine + 119)
            .join("\n")
            .slice(0, 12000) ?? null,
        nextLine:
          lines && a.startLine + 120 <= lines.length ? a.startLine + 120 : null,
      };
    },
  );
  tool(
    "sand_publish_proposal",
    "Submit exact target file content against actual beforeHash, bound to an explicit intent. Publishing invalidates earlier confirmation for this proposal.",
    {
      ...board,
      intentId: id,
      intentVersion: z.number().int().positive(),
      proposalId: id.optional(),
      previousVersion: z.number().int().positive().optional(),
      agentId: id,
      title: z.string().min(1).max(120),
      explanation: z.string().min(1).max(4000),
      testPlan: z.string().min(1).max(2000),
      files: z
        .array(
          ref.extend({
            beforeHash: z.string().nullable(),
            after: z.string().max(200000).nullable(),
          }),
        )
        .min(1)
        .max(12),
    },
    (a) => changes.publish(a.boardId, a),
  );
  tool(
    "sand_read_proposal",
    "Read current proposal status. Full exact before/after content is available to the App; approved per-file content uses sand_read_approved_file.",
    { ...board, proposalId: id },
    (a) => {
      const { p } = changes.proposal(a.boardId, a.proposalId);
      return viewResult(proposalSummary(p), {
        ...p,
        baseline: p.baseline.map((s) => ({ ...s, files: {} })),
      });
    },
  );
  tool(
    "sand_decide_proposal",
    "Human accepts, rejects or requests revision of exactly this proposal version and digest.",
    {
      ...board,
      proposalId: id,
      version: z.number().int(),
      digest: id,
      decision: z.enum(["accepted", "rejected", "revise"]),
    },
    (a) =>
      changes.decide(a.boardId, a.proposalId, a.version, a.digest, a.decision),
    true,
  );
  tool(
    "sand_prepare_apply",
    "Check accepted version and actual worktree immediately before using host write tools. Does not write files.",
    { ...board, proposalId: id, version: z.number().int(), digest: id },
    (a) => changes.prepare(a.boardId, a.proposalId, a.version, a.digest),
  );
  tool(
    "sand_read_approved_file",
    "Read exact accepted target content for one file and fresh precondition. Host must compare beforeHash immediately before writing. No atomicity or host enforcement is claimed.",
    {
      ...board,
      proposalId: id,
      version: z.number().int(),
      digest: id,
      fileIndex: z.number().int().nonnegative(),
    },
    (a) => {
      const { p } = changes.proposal(
        a.boardId,
        a.proposalId,
        a.version,
        a.digest,
      );
      if (p.decision !== "accepted") throw Error("Not accepted.");
      if (changes.observe(a.boardId, p).state === "diverged")
        throw Error("Worktree diverged from the confirmed scope.");
      const f = p.files[a.fileIndex];
      if (!f) throw Error("Unknown file.");
      const current = currentFile(changes.bindings, f);
      if (current.hash !== f.beforeHash && current.hash !== f.afterHash)
        throw Error("Current file no longer matches the approved baseline.");
      return { ...f, alreadyMatchesTarget: current.hash === f.afterHash };
    },
  );
  tool(
    "sand_verify_proposal",
    "Read actual worktree after host writes, check exact targets and changes outside scope, and distinguish partial or unverifiable results.",
    { ...board, proposalId: id },
    (a) => {
      const { p } = changes.proposal(a.boardId, a.proposalId);
      return changes.observe(a.boardId, p);
    },
  );
  tool(
    "sand_report_validation",
    "Attach a host Agent test report to current verified content. It is a self-report, not server-executed proof.",
    {
      ...board,
      proposalId: id,
      version: z.number().int(),
      digest: id,
      agentId: id,
      workspaceId: id,
      command: z.string().min(1).max(1000),
      environment: z.string().min(1).max(1000),
      outcome: z.enum(["passed", "failed", "not-run"]),
      output: z.string().max(8000),
    },
    (a) => {
      const { b, p } = changes.proposal(
        a.boardId,
        a.proposalId,
        a.version,
        a.digest,
      );
      const v = changes.observe(a.boardId, p);
      if (v.state !== "matches")
        throw Error("Actual content/scope does not fully match the proposal.");
      if (!p.files.some((f) => f.workspaceId === a.workspaceId))
        throw Error("Wrong validation workspace.");
      if (b.validations.length >= 40) b.validations.shift();
      const report = {
        id: randomUUID(),
        proposalId: p.id,
        version: p.version,
        digest: p.digest,
        agentId: a.agentId,
        workspaceId: a.workspaceId,
        command: a.command,
        environment: a.environment,
        outcome: a.outcome,
        output: a.output,
        reportedAt: Date.now(),
        fingerprint: v.fingerprint,
        source: "agent-report" as const,
      };
      b.validations.push(report);
      b.revision++;
      return report;
    },
  );
}
