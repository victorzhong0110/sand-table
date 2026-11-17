import type { Actor, ResourceRef } from "../kernel/index.ts";
export type { ResourceIdentity, ResourceRef } from "../kernel/index.ts";
export type ResourceRequest = {
  objectId: string;
  expectedVersion: number;
  workspaceId?: string;
  action: "read" | "open";
};

export type Unavailable = {
  status:
    | "provider_missing"
    | "not_found"
    | "version_unavailable"
    | "unsupported"
    | "disconnected"
    | "forbidden";
  ref: ResourceRef;
  reason: string;
};
export type ResourceDescription = {
  providerId: string;
  namespace: string;
  title: string;
  capabilities: {
    read: true;
    open?: boolean;
    subscribe?: boolean;
    edit?: boolean;
    export?: boolean;
  };
  idempotency: "none" | "process" | "durable";
};
export type ResourceRead =
  | Unavailable
  | {
      status: "available";
      ref: ResourceRef;
      revision: string;
      title: string;
      summary: string;
      capabilities: ResourceDescription["capabilities"];
    };
export type ResourceRoute =
  | {
      kind: "board-object";
      workspaceId: string;
      boardId: string;
      objectId: string;
      presentationId?: string;
    }
  | { kind: "url"; url: string };
export type ResourceOpen =
  | Unavailable
  | {
      status: "available";
      ref: ResourceRef;
      revision: string;
      route: ResourceRoute;
    };
export type ResourceEdit = {
  operationId: string;
  expectedRevision: string;
  actor: Actor;
  operation: {
    title?: string;
    set?: Record<string, unknown>;
    unset?: string[];
  };
};
export type ResourceProvider = {
  describe(): ResourceDescription;
  read(
    ref: ResourceRef,
    signal?: AbortSignal,
  ): Promise<ResourceRead> | ResourceRead;
  open?(
    ref: ResourceRef,
    signal?: AbortSignal,
  ): Promise<ResourceOpen> | ResourceOpen;
  subscribe?(ref: ResourceRef, changed: () => void): () => void;
  edit?(
    ref: ResourceRef,
    request: ResourceEdit,
  ): Promise<ResourceRead> | ResourceRead;
  export?(ref: ResourceRef): Promise<
    | Unavailable
    | {
        status: "available";
        ref: ResourceRef;
        revision: string;
        mediaType: string;
        text: string;
      }
  >;
};
