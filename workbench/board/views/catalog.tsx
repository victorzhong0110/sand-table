import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { TypeSpecView } from "./format.ts";

export type PackInfo = { id: string; title: string; enabled: boolean };

export type TypeCatalog = {
  ready: boolean;
  specs: Map<string, TypeSpecView>;
  packs: PackInfo[];
};

const empty: TypeCatalog = { ready: false, specs: new Map(), packs: [] };

const TypeCatalogContext = createContext<TypeCatalog>(empty);

export function useTypeCatalog(): TypeCatalog {
  return useContext(TypeCatalogContext);
}

export function TypeCatalogProvider({
  call,
  revision,
  children,
}: {
  call: (name: string, args?: Record<string, unknown>) => Promise<any>;
  revision: number;
  children: ReactNode;
}) {
  const [catalog, setCatalog] = useState<TypeCatalog>(empty);
  const callRef = useRef(call);
  callRef.current = call;
  useEffect(() => {
    let cancelled = false;
    const run = callRef.current;
    void (async () => {
      try {
        const status = await run("sand_status");
        const packs = Array.isArray(status?.packs)
          ? (status.packs as PackInfo[])
          : [];
        const specs = new Map<string, TypeSpecView>();
        for (const pack of packs) {
          if (!pack?.enabled || !pack.id) continue;
          const listed = await run("sand_types", { pack: pack.id });
          for (const spec of listed?.types ?? []) {
            if (spec && typeof spec.type === "string")
              specs.set(spec.type, spec as TypeSpecView);
          }
        }
        if (!cancelled) setCatalog({ ready: true, specs, packs });
      } catch {
        if (!cancelled)
          setCatalog({ ready: true, specs: new Map(), packs: [] });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [revision]);
  return (
    <TypeCatalogContext.Provider value={catalog}>
      {children}
    </TypeCatalogContext.Provider>
  );
}
