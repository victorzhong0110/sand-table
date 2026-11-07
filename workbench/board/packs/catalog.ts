import { useEffect, useRef, useState } from "react";

type Tool = (name: string, args?: Record<string, unknown>) => Promise<any>;

export type PackEntry = {
  id: string;
  title: string;
  kind: string;
  version: number;
  enabled: boolean;
};
export type PaletteEntry = {
  type: string;
  title: string;
  description: string;
  icon: string;
  pack: string;
  presets: {
    key: string;
    title: string;
    data?: Record<string, unknown>;
    width?: number;
    height?: number;
  }[];
  size?: { width: number; height: number };
  defaults: Record<string, unknown>;
};
export type TemplateEntry = { id: string; title: string; pack: string };

type Catalog = {
  scope: string;
  loading: boolean;
  error: string;
  packs: PackEntry[];
  types: PaletteEntry[];
  templates: TemplateEntry[];
};
const initial: Catalog = {
  scope: "",
  loading: true,
  error: "",
  packs: [],
  types: [],
  templates: [],
};

export function usePackCatalog(
  call: Tool | undefined,
  boardId: string,
  workspaceId: string | undefined,
  revision: number,
): Catalog {
  const [catalog, setCatalog] = useState<Catalog>(initial);
  const scope = JSON.stringify([workspaceId, boardId]);
  const callRef = useRef(call);
  callRef.current = call;
  useEffect(() => {
    let cancelled = false;
    const run = callRef.current;
    if (!run) {
      setCatalog({
        ...initial,
        scope,
        loading: false,
        error: "尚未连接工作空间。",
      });
      return;
    }
    void (async () => {
      try {
        const [status, listed, board] = await Promise.all([
          run("sand_status"),
          run("sand_types"),
          run("app_board", {
            boardId,
            ...(workspaceId ? { workspaceId } : {}),
          }),
        ]);
        if (workspaceId && board.workspaceId !== workspaceId)
          throw Error("工作空间已切换，请重新打开工具箱。");
        const metadata = new Map<string, any>(
          (board.packs ?? []).map((pack: any) => [pack.id, pack]),
        );
        const packs: PackEntry[] = (status.packs ?? []).map((pack: any) => ({
          id: pack.id,
          title: pack.title,
          enabled: pack.enabled,
          kind: String(metadata.get(pack.id)?.kind ?? ""),
          version: Number(metadata.get(pack.id)?.version ?? 0),
        }));
        packs.sort((a, b) => (a.id === "base" ? -1 : b.id === "base" ? 1 : 0));
        const details = await Promise.all(
          packs
            .filter((pack) => pack.enabled)
            .map(async (pack) => {
              const result = await run("sand_types", { pack: pack.id });
              return result.types ?? [];
            }),
        );
        const detailsByType = new Map<
          string,
          { size: PaletteEntry["size"]; defaults: Record<string, unknown> }
        >();
        for (const types of details)
          for (const type of types) {
            if (!type?.type) continue;
            const defaults: Record<string, unknown> = {};
            for (const [key, schema] of Object.entries(
              type.schema?.properties ?? {},
            )) {
              if (
                schema &&
                typeof schema === "object" &&
                Object.prototype.hasOwnProperty.call(schema, "x-sand-default")
              )
                defaults[key] = (schema as Record<string, unknown>)[
                  "x-sand-default"
                ];
            }
            detailsByType.set(type.type, {
              size: type.display?.defaultSize,
              defaults,
            });
          }
        const types: PaletteEntry[] = (listed.types ?? []).map((type: any) => ({
          ...type,
          presets: type.presets ?? [],
          size: detailsByType.get(type.type)?.size,
          defaults: detailsByType.get(type.type)?.defaults ?? {},
        }));
        if (!cancelled)
          setCatalog({
            scope,
            loading: false,
            error: "",
            packs,
            types,
            templates: listed.templates ?? [],
          });
      } catch (error) {
        if (!cancelled)
          setCatalog({
            ...initial,
            scope,
            loading: false,
            error: error instanceof Error ? error.message : String(error),
          });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [boardId, workspaceId, revision]);
  return catalog.scope === scope ? catalog : initial;
}
