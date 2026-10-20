import type {
  Space,
  ComponentInstance,
  View,
  SpaceLink,
  Asset,
  ThemeConfig,
} from "./spaces.ts";
import type { ChangeIntent, Proposal, ValidationReport } from "./changes.ts";
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
export type Group = {
  id: string;
  title: string;
  objectIds: string[];
  instanceIds?: string[];
};
export type SpaceActivity = {
  agentId: string;
  spaceId: string;
  instanceIds: string[];
  task: string;
  action: string;
  state: "running" | "waiting" | "done" | "unknown";
  reportedAt: number;
  stale?: boolean;
};
/** An imported component pack: data, never code. It may only reference
 * component types that already exist, and its prefilled data goes through the
 * same check as hand-written edits. */
export type ComponentPack = {
  id: string;
  name: string;
  version: number;
  description?: string;
  author?: string;
  homepage?: string;
  /** "json" for a pasted manifest, "url:<address>" for a fetched one. */
  source: string;
  importedAt: number;
  /** Who imported it: "human", "agent", … */
  importedBy: string;
  components: {
    key: string;
    type: string;
    title: string;
    icon?: string;
    width?: number;
    height?: number;
    data?: Record<string, unknown>;
  }[];
};
export type Board = Projection & {
  id: string;
  revision: number;
  title: string;
  expiresAt: number;
  presentation?: "canvas" | "code";
  autoProjectSources?: boolean;
  selection: string[];
  placements: Record<string, Placement>;
  notes: Record<string, string>;
  groups: Group[];
  activities: Activity[];
  spaceActivities?: SpaceActivity[];
  explanations: Explanation[];
  guides: Guide[];
  spaces: Space[];
  instances: ComponentInstance[];
  views: Record<string, View>;
  focusedViewId?: string;
  spaceLinks: SpaceLink[];
  assets: Asset[];
  /** Imported component packs. Optional: a board without packs simply has
   * none, so everything that reads them uses `b.componentPacks ?? []`. */
  componentPacks?: ComponentPack[];
  theme?: ThemeConfig | null;
  intents: ChangeIntent[];
  proposals: Proposal[];
  validations: ValidationReport[];
  guideFocus?: GuideFocus;
  lastContextRead?: { at: number; revision: number; objectIds: string[] };
};
