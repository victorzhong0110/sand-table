import Ajv from "ajv";
import type { ResourceRef } from "./types.ts";

export const RESOURCE_REF_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["providerId", "namespace", "resourceId"],
  properties: {
    providerId: { type: "string", minLength: 1, maxLength: 128 },
    namespace: { type: "string", minLength: 1, maxLength: 512 },
    resourceId: { type: "string", minLength: 1, maxLength: 512 },
    revision: { type: "string", minLength: 1, maxLength: 256 },
    anchor: { type: "string", minLength: 1, maxLength: 2048 },
  },
};

const validate = new Ajv({ strict: true }).compile(RESOURCE_REF_SCHEMA);

export function isResourceRef(value: unknown): value is ResourceRef {
  return validate(value) === true;
}

export function sourceResourceProblem(value: {
  resource?: unknown;
  external?: unknown;
}): string | undefined {
  if (value.resource === undefined) return;
  if (value.external !== undefined)
    return "同一对象不能同时绑定外部定位和插件资源。请拆成两个引用对象。";
  if (!isResourceRef(value.resource))
    return "资源引用格式不对，请检查提供者、命名空间、资源编号和版本的长度。";
}
