// Component Pack Protocol v1.
//
// A component pack is DATA, never code. Two rules shape this file:
//
//   1. A pack configures components that already exist; it can never add a
//      renderer or any executable content, so importing one cannot change
//      what the program can do. A pack may name a type this version does not
//      know: the data is kept and the canvas shows the same placeholder the
//      renderer already shows for an unknown type, never a new renderer.
//   2. Prefilled data goes through exactly the same check as data typed into
//      the editor — the same `checkComponentData` function from core/spaces.ts,
//      not a copy of it — so an import is not a way around that check.
//
// docs/COMPONENT-PACK-PROTOCOL.md is the authority; this file is its
// machine-readable form, and every message here is meant for the person
// holding the pack, not for a log.
import { z } from "zod";
import type { ComponentPack } from "./model.ts";
import {
  checkComponentData,
  componentIcons,
  componentTypes,
  defaultData,
  safeUrl,
} from "./spaces.ts";

export const PACK_PROTOCOL = "sand-table/component-pack";
export const PACK_VERSION = 1;
/** Limits from the protocol: 20 packs per board, 50 components per pack,
 * 256 KB per manifest. */
export const MAX_PACKS_PER_BOARD = 20;
export const MAX_COMPONENTS_PER_PACK = 50;
export const MAX_MANIFEST_BYTES = 256 * 1024;
/** Same range as the rect check in sand_edit_space. */
export const MIN_WIDTH = 120;
export const MAX_WIDTH = 2000;
export const MIN_HEIGHT = 70;
export const MAX_HEIGHT = 1600;

export type PackComponent = {
  key: string;
  type: string;
  title: string;
  icon?: string;
  width?: number;
  height?: number;
  data?: Record<string, unknown>;
};

export type PackManifest = {
  protocol: string;
  version: number;
  id: string;
  name: string;
  description?: string;
  author?: string;
  homepage?: string;
  components: PackComponent[];
};

const packComponentSchema = z.object({
  key: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, {
    error:
      "组件 key 只能包含小写字母、数字、点、下划线和连字符，并以字母或数字开头。",
  }),
  type: z
    .string()
    .min(1, { error: "组件缺少 type。" })
    .max(60, { error: "组件类型最长 60 字符。" }),
  title: z
    .string()
    .min(1, { error: "组件缺少 title。" })
    .max(120, { error: "组件标题最长 120 字。" }),
  icon: z.string().min(1).max(80).optional(),
  width: z.number().finite().optional(),
  height: z.number().finite().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});

const manifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,63}$/, {
    error:
      "包 id 只能包含小写字母、数字、点、下划线和连字符，长度 2–64，建议用反向域名。",
  }),
  name: z
    .string()
    .min(1, { error: "包缺少 name。" })
    .max(80, { error: "包名最长 80 字。" }),
  description: z.string().max(400, { error: "包说明最长 400 字。" }).optional(),
  author: z.string().max(80, { error: "包署名最长 80 字。" }).optional(),
  homepage: z.string().max(2000).optional(),
  components: z
    .array(packComponentSchema)
    .min(1, { error: "包至少要有 1 个组件。" })
    .max(MAX_COMPONENTS_PER_PACK, {
      error: `一个包最多 ${MAX_COMPONENTS_PER_PACK} 个组件。`,
    }),
});

/** Data keys a renderer reads but `defaultData` does not spell out. Anything
 * outside this set is not understood by the component and gets dropped. */
const EXTRA_DATA_KEYS: Record<string, string[]> = {
  resource: ["assetId"],
  status: ["observedAt"],
  intent: ["intentId"],
  proposal: ["proposalId"],
  validation: ["proposalId"],
  board: ["spaceId"],
  "space-link": ["spaceId"],
};

function knownDataKeys(type: string) {
  return new Set([
    ...Object.keys(defaultData(type)),
    ...(EXTRA_DATA_KEYS[type] ?? []),
  ]);
}

/**
 * The limits every component data has to meet whatever the type: the same
 * head of the check the editor runs — total size and link fields. This is what
 * a type this version does not know is held to: it has no rules of its own in
 * the editor either, so only the general limits apply.
 */
export function checkGenericData(data: Record<string, unknown>) {
  if (JSON.stringify(data).length > 40000)
    throw Error("Component data exceeds 40 KB.");
  if (data.url && !safeUrl(data.url))
    throw Error("Resource URL must use HTTP(S).");
  if (data.sourceUrl && !safeUrl(data.sourceUrl))
    throw Error("Source URL must use HTTP(S).");
}


function schemaError(error: z.ZodError) {
  const first = error.issues[0];
  if (!first) return "组件包内容不合法。";
  const where = first.path.length ? first.path.join(".") : "清单";
  return `组件包的「${where}」不合法：${first.message}`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Read a manifest. Throws with a message meant for the person holding the
 * pack; returns the normalised manifest plus the warnings for the fields that
 * were dropped.
 */
export function parsePackManifest(text: string): {
  manifest: PackManifest;
  warnings: string[];
} {
  if (typeof text !== "string" || !text.trim())
    throw Error("组件包内容为空。");
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_MANIFEST_BYTES)
    throw Error(
      `组件包有 ${Math.ceil(bytes / 1024)} KB，超过 ${MAX_MANIFEST_BYTES / 1024} KB 上限。`,
    );
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw Error("组件包不是合法的 JSON。");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw Error("组件包必须是一个 JSON 对象。");
  const source = raw as Record<string, unknown>;
  if (source.protocol !== PACK_PROTOCOL)
    throw Error(
      `这不是组件包：protocol 必须是 "${PACK_PROTOCOL}"，收到 ${JSON.stringify(source.protocol ?? null)}。`,
    );
  if (source.version !== PACK_VERSION)
    throw Error(
      `组件包版本 ${JSON.stringify(source.version ?? null)} 不受支持；当前只接受 version ${PACK_VERSION}。`,
    );
  const parsed = manifestSchema.safeParse(source);
  if (!parsed.success) throw Error(schemaError(parsed.error));

  const warnings: string[] = [];
  const known = new Set(Object.keys(manifestSchema.shape));
  const extra = Object.keys(source).filter(
    (key) => !known.has(key) && key !== "protocol" && key !== "version",
  );
  if (extra.length)
    warnings.push(`清单里这些字段不认，已忽略：${extra.join("、")}。`);

  if (parsed.data.homepage !== undefined && !safeUrl(parsed.data.homepage))
    throw Error("homepage 必须是 http(s) 链接。");

  const seen = new Set<string>();
  const components: PackComponent[] = [];
  for (const c of parsed.data.components) {
    if (seen.has(c.key))
      throw Error(`包里有重复的组件 key「${c.key}」。`);
    seen.add(c.key);
    /* A type this version does not know is still imported: the data is kept
       and the canvas shows the placeholder the renderer already shows for an
       unknown type (DEVELOPMENT_PLAN §5.4: 未知组件显示可理解的占位与说明，
       不静默丢弃). It can never become a renderer. */
    const knownType = componentTypes.some((t) => t.type === c.type);
    if (!knownType)
      warnings.push(
        `未知组件类型「${c.type}」，数据已保留，画布上以占位展示。`,
      );
    /* An icon this version does not know is dropped, not refused: the icon is
       a matter of looks, and a pack written for a newer version should still
       be usable. The component falls back to its type's own icon. */
    let icon = c.icon;
    if (icon !== undefined && !componentIcons.includes(icon)) {
      warnings.push(
        `组件「${c.title}」的图标「${icon}」不是已有图标名，已忽略，改用 ${c.type} 自己的图标。`,
      );
      icon = undefined;
    }

    let width = c.width,
      height = c.height;
    if (width !== undefined) {
      const clamped = clamp(width, MIN_WIDTH, MAX_WIDTH);
      if (clamped !== width) {
        warnings.push(
          `组件「${c.title}」的宽度 ${width} 超出范围，已收进 ${MIN_WIDTH}–${MAX_WIDTH}。`,
        );
        width = clamped;
      }
    }
    if (height !== undefined) {
      const clamped = clamp(height, MIN_HEIGHT, MAX_HEIGHT);
      if (clamped !== height) {
        warnings.push(
          `组件「${c.title}」的高度 ${height} 超出范围，已收进 ${MIN_HEIGHT}–${MAX_HEIGHT}。`,
        );
        height = clamped;
      }
    }

    let data = c.data;
    if (data !== undefined) {
      /* The data is checked as it was handed over, before anything is
         dropped: a pack cannot smuggle past the editor's check. */
      try {
        if (knownType) checkComponentData(c.type, data);
        else checkGenericData(data);
      } catch (e) {
        throw Error(
          `组件「${c.title}」的预填数据没有通过校验：${e instanceof Error ? e.message : String(e)}`,
        );
      }
      if (knownType) {
        const understood = knownDataKeys(c.type);
        const kept: Record<string, unknown> = {};
        const dropped: string[] = [];
        for (const [key, value] of Object.entries(data)) {
          if (understood.has(key)) kept[key] = value;
          else dropped.push(key);
        }
        if (dropped.length)
          warnings.push(
            `组件「${c.title}」里这些键不是 ${c.type} 组件认识的，已丢弃：${dropped.join("、")}。`,
          );
        data = kept;
      }
      /* An unknown type keeps every key it was given: the placeholder shows
         the data as it is, so nothing is dropped (DEVELOPMENT_PLAN §5.4). */
    } else {
      /* 省略即默认：the default data goes through the same check, so a pack
         can never ship a preset the editor would refuse. */
      try {
        checkComponentData(c.type, defaultData(c.type));
      } catch (e) {
        throw Error(
          `组件「${c.title}」的默认数据没有通过校验：${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    components.push({
      key: c.key,
      type: c.type,
      title: c.title,
      ...(icon !== undefined ? { icon } : {}),
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
      ...(data !== undefined ? { data } : {}),
    });
  }

  return {
    manifest: {
      protocol: PACK_PROTOCOL,
      version: PACK_VERSION,
      id: parsed.data.id,
      name: parsed.data.name,
      ...(parsed.data.description !== undefined
        ? { description: parsed.data.description }
        : {}),
      ...(parsed.data.author !== undefined
        ? { author: parsed.data.author }
        : {}),
      ...(parsed.data.homepage !== undefined
        ? { homepage: parsed.data.homepage }
        : {}),
      components,
    },
    warnings,
  };
}

/** The pack as the board stores it. */
export function toComponentPack(
  manifest: PackManifest,
  options: { source: string; importedAt: number; importedBy: string },
): ComponentPack {
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    ...(manifest.description !== undefined
      ? { description: manifest.description }
      : {}),
    ...(manifest.author !== undefined ? { author: manifest.author } : {}),
    ...(manifest.homepage !== undefined ? { homepage: manifest.homepage } : {}),
    source: options.source,
    importedAt: options.importedAt,
    importedBy: options.importedBy,
    components: manifest.components.map((c) => ({
      ...c,
      ...(c.data !== undefined ? { data: structuredClone(c.data) } : {}),
    })),
  };
}

/** The manifest of a stored pack: importing this again gives the same pack. */
export function packManifestOf(pack: ComponentPack): PackManifest {
  return {
    protocol: PACK_PROTOCOL,
    version: pack.version,
    id: pack.id,
    name: pack.name,
    ...(pack.description !== undefined ? { description: pack.description } : {}),
    ...(pack.author !== undefined ? { author: pack.author } : {}),
    ...(pack.homepage !== undefined ? { homepage: pack.homepage } : {}),
    components: pack.components.map((c) => ({
      ...c,
      ...(c.data !== undefined ? { data: structuredClone(c.data) } : {}),
    })),
  };
}
