export type Evidence = {
  workspaceId: string;
  path: string;
  startLine: number;
  endLine: number;
  hash: string;
};
export type Item = {
  id: string;
  workspaceId: string;
  kind: "workspace" | "file" | "symbol";
  title: string;
  parentId?: string;
  source?: Evidence;
};
export type Relation = {
  source: string;
  target: string;
  kind: "contains" | "imports" | "syntactic-call";
};
export type Workspace = {
  id: string;
  label: string;
  head: string;
  branch: string;
  snapshot: string;
  files: number;
  omitted: string[];
};
export type Projection = {
  workspaces: Workspace[];
  objects: Item[];
  relations: Relation[];
};
export type Placement = { x: number; y: number; pinned: boolean };
export type Activity = {
  agentId: string;
  workspaceId: string;
  objectIds: string[];
  task: string;
  action: string;
  state: "running" | "waiting" | "done" | "unknown";
  reportedAt: number;
  stale?: boolean;
};
export type Explanation = {
  id: string;
  agentId: string;
  text: string;
  evidence: Evidence[];
  stale: boolean;
  status: "agent-inference";
};
export type GuideStep = {
  title: string;
  explanation: string;
  objectIds: string[];
  evidence: Evidence[];
  uncertainty: string;
};
export type GuideDraft = {
  title: string;
  purpose: string;
  inputs: string;
  outputs: string;
  agentId: string;
  steps: GuideStep[];
};
export type Guide = GuideDraft & {
  id: string;
  stale: boolean;
  status: "agent-inference";
  createdAt: number;
};
export type GuideFocus = { guideId: string; step: number };
export type Group = { id: string; title: string; objectIds: string[] };
export type Board = Projection & {
  id: string;
  revision: number;
  title: string;
  expiresAt: number;
  selection: string[];
  placements: Record<string, Placement>;
  notes: Record<string, string>;
  groups: Group[];
  activities: Activity[];
  explanations: Explanation[];
  guides: Guide[];
  guideFocus?: GuideFocus;
  lastContextRead?: { at: number; revision: number; objectIds: string[] };
};
