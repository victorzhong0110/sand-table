import { z } from "zod";
import { isResourceRef, type ResourceRef } from "../../kernel/index.ts";

const id = z.string().min(1).max(512);
const revision = z.number().int().nonnegative();
export const boardScope = z.object({
  workspaceId: z.string().min(1).max(64),
  boardId: id,
});
export const sessionIdentity = z.object({ id, createdAt: revision });
export const taskRequest = boardScope.extend({
  requestId: z.uuid(),
  instruction: z.string().trim().min(1).max(9000),
  displayText: z.string().trim().min(1).max(8000),
  contextVersion: revision,
  targets: z
    .array(z.object({ objectId: id, version: revision.min(1) }))
    .max(200),
  sessionId: id.optional(),
  sessionCreatedAt: revision.optional(),
});
const title = z.string().trim().min(1).max(280);
const cell = z.union([
  z.string().max(2000),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
export const artifact = z
  .discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("note"),
      title,
      body: z.string().min(1).max(19000),
      candidateFor: z
        .object({ objectId: id, version: revision.min(1) })
        .optional(),
    }),
    z.strictObject({
      kind: z.literal("table"),
      title,
      columns: z.array(z.string().min(1).max(200)).min(1).max(20),
      rows: z.array(z.array(cell).max(20)).max(200),
    }),
    z.strictObject({
      kind: z.literal("resource"),
      title,
      note: z.string().max(2000).optional(),
      resource: z.custom<ResourceRef>(
        (value) => isResourceRef(value) && value.revision !== undefined,
      ),
    }),
  ])
  .refine(
    (value) =>
      value.kind !== "table" ||
      value.rows.every((row) => row.length === value.columns.length),
    "表格每行的长度必须与列名一致。",
  );

export const binding = taskRequest
  .omit({ sessionId: true, sessionCreatedAt: true })
  .extend({
    workspaceNamespace: id,
    session: sessionIdentity,
  });
export const operationId = z.string().regex(/^[a-f0-9]{64}$/);
export const delivery = z.object({ operationId, seq: revision, artifact });
export const record = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("binding"), binding }),
  z.object({ kind: z.literal("accepted"), requestId: z.uuid() }),
  z.object({ kind: z.literal("delivery"), requestId: z.uuid(), delivery }),
  z.object({
    kind: z.literal("written"),
    requestId: z.uuid(),
    operationId,
    objectId: id,
    revision,
  }),
  z.object({
    kind: z.literal("delivery-error"),
    requestId: z.uuid(),
    operationId,
    reason: z.string().max(500),
  }),
]);
export type Binding = z.infer<typeof binding>;
export type Delivery = z.infer<typeof delivery>;
