import type { JsonSchema } from "./types.ts";

export type MediaCrop = { x: number; y: number; w: number; h: number };

const position = { type: "number", minimum: 0, maximum: 1 };
const extent = { type: "number", exclusiveMinimum: 0, maximum: 1 };

export const MEDIA_CROP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["x", "y", "w", "h"],
  properties: { x: position, y: position, w: extent, h: extent },
} satisfies JsonSchema;

export function isMediaCrop(value: unknown): value is MediaCrop {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { x, y, w, h } = value as Partial<MediaCrop>;
  const boundary = 1 + Number.EPSILON;
  return (
    Object.keys(value).length === 4 &&
    typeof x === "number" &&
    typeof y === "number" &&
    typeof w === "number" &&
    typeof h === "number" &&
    x >= 0 &&
    y >= 0 &&
    w > 0 &&
    h > 0 &&
    x + w <= boundary &&
    y + h <= boundary
  );
}

export function isValidCoverCrop(crop: unknown, blob: unknown): boolean {
  return (
    crop === undefined ||
    (isMediaCrop(crop) &&
      typeof blob === "string" &&
      /^[0-9a-f]{64}$/.test(blob))
  );
}
