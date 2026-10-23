import type { Db } from "./db.ts";
import type { Registry } from "./registry.ts";

export type Actor = { id: string; kind: "human" | "agent" };

export type ExternalLocator = {
  kind: "file" | "git" | "pdf" | "url" | "dataset" | "symbol";
  uri: string;
  fragment?: string;
  version?: string;
  fingerprint?: string;
};

export type ObjectSource = {
  origin: "human" | "imported" | "ai-generated" | "ai-inferred" | "derived";
  basis?: string;
  external?: ExternalLocator;
};

export type ObjectRow = {
  id: string;
  type: string;
  typeVersion: number;
  title: string;
  data: Record<string, unknown>;
  source: ObjectSource | null;
  version: number;
  createdAt: number;
  createdBy: string;
  updatedAt: number;
  updatedBy: string;
  rev: number;
  deleted: boolean;
};

export type Appearance = {
  detail?: "full" | "label" | "icon";
  coverBlob?: string;
  accent?: string;
};

export type PresentationRow = {
  id: string;
  boardId: string;
  objectId: string;
  parentId: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  locked: boolean;
  appearance: Appearance;
  version: number;
  updatedAt: number;
  updatedBy: string;
  rev: number;
  deleted: boolean;
};

export type RelationRow = {
  id: string;
  kind: string;
  sourceId: string;
  targetId: string;
  status: "confirmed" | "inferred";
  basis: string | null;
  attributes: Record<string, unknown>;
  evidence: ExternalLocator[];
  version: number;
  createdAt: number;
  createdBy: string;
  updatedAt: number;
  updatedBy: string;
  rev: number;
  deleted: boolean;
};

export type Snapshot = Record<string, unknown> | null;

export type Change = {
  table: "objects" | "presentations" | "relations" | "settings" | "packs";
  id: string;
  before: Snapshot;
  after: Snapshot;
};

export type ErrorCode =
  | "UNKNOWN_TYPE"
  | "INVALID_DATA"
  | "LIMIT"
  | "VERSION_CONFLICT"
  | "NOT_FOUND"
  | "NOT_CONTAINER"
  | "CYCLE"
  | "LOCKED"
  | "FORBIDDEN"
  | "HISTORY_CONFLICT"
  | "INTERNAL";

export type CommandBatch = {
  actor: Actor;
  intentId?: string;
  label?: string;
  commands: Command[];
  record?: boolean;
};

export type Command =
  | {
      op: "object.create";
      ref?: string;
      type: string;
      title?: string;
      data?: Record<string, unknown>;
      source?: ObjectSource;
    }
  | {
      op: "object.update";
      id: string;
      expectedVersion?: number;
      title?: string;
      set?: Record<string, unknown>;
      unset?: string[];
      source?: ObjectSource;
    }
  | { op: "object.delete"; id: string; expectedVersion?: number }
  | { op: "object.clone"; ref?: string; id: string }
  | {
      op: "presentation.create";
      ref?: string;
      boardId: string;
      objectId: string;
      x?: number;
      y?: number;
      width?: number;
      height?: number;
      parentId?: string;
      appearance?: Appearance;
    }
  | {
      op: "presentation.update";
      id: string;
      x?: number;
      y?: number;
      width?: number;
      height?: number;
      z?: number;
      locked?: boolean;
      parentId?: string | null;
      appearance?: Appearance;
    }
  | { op: "presentation.delete"; id: string }
  | {
      op: "relation.create";
      ref?: string;
      kind: string;
      sourceId: string;
      targetId: string;
      status?: "confirmed" | "inferred";
      basis?: string;
      attributes?: Record<string, unknown>;
      evidence?: ExternalLocator[];
    }
  | {
      op: "relation.update";
      id: string;
      expectedVersion?: number;
      status?: "confirmed" | "inferred";
      basis?: string | null;
      attributes?: Record<string, unknown>;
      evidence?: ExternalLocator[];
    }
  | { op: "relation.delete"; id: string }
  | { op: "setting.set"; key: string; value: unknown }
  | { op: "pack.enable"; id: string }
  | { op: "pack.disable"; id: string }
  | { op: "pack.import"; manifest: Record<string, unknown> }
  | { op: "pack.remove"; id: string }
  | {
      op: "template.apply";
      templateId: string;
      boardId: string;
      x?: number;
      y?: number;
    };

export type SystemCommand =
  | {
      op: "pack.sync_builtin";
      id: string;
      version: number;
      enabledByDefault: boolean;
    }
  | {
      op: "object.upsert_derived";
      packId: string;
      id: string;
      type: string;
      title?: string;
      data?: Record<string, unknown>;
      source: ObjectSource;
    };

export type SystemCommandBatch = {
  actor: Actor;
  commands: SystemCommand[];
};

export type CommandResult = {
  revision: number;
  historyId: string | null;
  created: Record<string, string>;
  changed: { table: string; id: string; version: number }[];
  warnings: { commandIndex: number; message: string; path?: string }[];
};

export type JsonSchema = Record<string, unknown>;

/**
 * 工具注册器。内核不认 zod，参数结构按 zod 的 shape 传进来，
 * 具体类型由 server/v3/ 那一层收窄。
 */
export type ToolRegistrar = {
  tool(
    name: string,
    description: string,
    shape: Record<string, unknown>,
    handler: (
      args: any,
      ctx: { actor: Actor; db: Db; registry: Registry },
    ) => unknown,
    options?: { appOnly?: boolean; readOnly?: boolean; ui?: boolean },
  ): void;
};

export type PresetSpec = {
  key: string;
  type: string;
  title: string;
  data?: Record<string, unknown>;
  width?: number;
  height?: number;
};

export type RelationSlot = {
  key: string;
  label: string;
  kind: string;
  direction: "out" | "in";
  targetTypes?: string[];
  many: boolean;
};

export type TypeSpec = {
  type: string;
  title: string;
  description: string;
  icon: string;
  version: number;
  schema: JsonSchema;
  capabilities?: {
    container?: boolean;
    cover?: boolean;
  };
  display: {
    material: "paper" | "document" | "screen" | "gauge" | "container" | "media";
    defaultSize: { width: number; height: number };
    summary?: string[];
    view?: string;
  };
  relationSlots?: RelationSlot[];
  migrations?: {
    from: number;
    migrate: (data: Record<string, unknown>) => Record<string, unknown>;
  }[];
};

export type RelationKindSpec = {
  kind: string;
  title: string;
  inverseTitle: string;
  allowsInferred: boolean;
  requiresBasis?: boolean;
  sourceTypes?: string[];
  targetTypes?: string[];
};

export type TemplateSpec = {
  id: string;
  title: string;
  description?: string;
  commands: Command[];
};

export type PackSpec = {
  /** 仅内置包：新建派生对象 ID 的非重叠前缀。 */
  derivedIdPrefix?: string;
  id: string;
  title: string;
  version: number;
  description?: string;
  types?: TypeSpec[];
  relationKinds?: RelationKindSpec[];
  templates?: TemplateSpec[];
  presets?: PresetSpec[];
  registerTools?: (server: ToolRegistrar) => void;
};
