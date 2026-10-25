import { createContext, useContext, type ReactNode } from "react";

export type AssetInfo = {
  sha256: string;
  name?: string;
  mime?: string;
  bytes?: number;
  dataUrl?: string;
};

export type WidgetHost = {
  openUrl(url: string): void;
  uploadAsset(file: File): Promise<AssetInfo>;
  readAsset(sha256: string): Promise<AssetInfo | undefined>;
};

const WidgetHostContext = createContext<WidgetHost | undefined>(undefined);

export function WidgetHostProvider({
  host,
  children,
}: {
  host: WidgetHost;
  children: ReactNode;
}) {
  return (
    <WidgetHostContext.Provider value={host}>
      {children}
    </WidgetHostContext.Provider>
  );
}

export function useWidgetHost(): WidgetHost | undefined {
  return useContext(WidgetHostContext);
}
