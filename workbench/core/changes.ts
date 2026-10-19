import type { Placement } from "./model.ts";
export type FileRef = { workspaceId: string; path: string };
export type ChangeIntent = {
  id: string;
  version: number;
  request: string;
  objectIds: string[];
  allowedFiles: FileRef[];
  arrangement: {
    placements: Record<string, Placement>;
    notes: Record<string, string>;
    groups: { title: string; objectIds: string[] }[];
  };
  createdAt: number;
};
export type FileTarget = FileRef & {
  beforeHash: string | null;
  after: string | null;
};
export type ProposalFile = FileTarget & {
  before: string | null;
  afterHash: string | null;
};
export type WorkspaceState = {
  workspaceId: string;
  head: string;
  files: Record<string, { hash: string; mode: number }>;
  omitted: string[];
  fingerprint: string;
};
export type Proposal = {
  id: string;
  version: number;
  digest: string;
  intentId: string;
  intentVersion: number;
  agentId: string;
  title: string;
  explanation: string;
  testPlan: string;
  files: ProposalFile[];
  baseline: WorkspaceState[];
  decision: "pending" | "accepted" | "rejected" | "revise" | "stale";
  decidedAt?: number;
  verification?: {
    at: number;
    state: "not-applied" | "partial" | "matches" | "diverged" | "incomplete";
    files: (FileRef & {
      state: "before" | "after" | "unexpected";
      actualHash: string | null;
    })[];
    outsideChanges: FileRef[];
    omitted: string[];
    fingerprint: string;
  };
};
export type ValidationReport = {
  id: string;
  proposalId: string;
  version: number;
  digest: string;
  agentId: string;
  workspaceId: string;
  command: string;
  environment: string;
  outcome: "passed" | "failed" | "not-run";
  output: string;
  reportedAt: number;
  fingerprint: string;
  source: "agent-report";
};
export const proposalSummary = (p: Proposal) => ({
  id: p.id,
  version: p.version,
  digest: p.digest,
  intentId: p.intentId,
  intentVersion: p.intentVersion,
  title: p.title,
  agentId: p.agentId,
  decision: p.decision,
  files: p.files.map(({ workspaceId, path, beforeHash, afterHash }) => ({
    workspaceId,
    path,
    beforeHash,
    afterHash,
  })),
  verification: p.verification,
});
