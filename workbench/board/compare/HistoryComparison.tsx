import { useEffect, useRef, useState } from "react";
import type { ComparisonSource } from "./commands.ts";

type Versions = {
  current: number;
  truncated: boolean;
  versions: { version: number; at: number }[];
};

export function HistoryComparison({
  source,
  workspaceId,
  call,
  create,
  close,
}: {
  source: ComparisonSource;
  workspaceId: string;
  call: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  create: (
    source: ComparisonSource,
    pins: { left?: number; right?: number },
  ) => Promise<unknown>;
  close: () => void;
}) {
  const invoke = useRef(call);
  invoke.current = call;
  const [versions, setVersions] = useState<Versions>();
  const [left, setLeft] = useState("");
  const [right, setRight] = useState("current");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void invoke
      .current("app_history", {
        action: "object-versions",
        workspaceId,
        objectId: source.id,
      })
      .then((result) => {
        if (!active) return;
        const received = result as Versions;
        setVersions(received);
        setLeft(
          received.versions.length ? String(received.versions[0].version) : "",
        );
      })
      .catch((reason: unknown) => {
        if (active)
          setError(
            reason instanceof Error ? reason.message : "无法读取对象历史。",
          );
      });
    return () => {
      active = false;
    };
  }, [source.id, workspaceId]);
  const option = (
    label: string,
    value: string,
    set: (next: string) => void,
  ) => (
    <label>
      {label}
      <select
        aria-label={label}
        value={value}
        disabled={pending}
        onChange={(event) => set(event.target.value)}
      >
        <option value="">选择一个版本</option>
        <option value="current">当前版本 {versions?.current}</option>
        {(versions?.versions ?? []).map(({ version, at }) => (
          <option key={version} value={version}>
            版本 {version} · {new Date(at).toLocaleString()}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <aside
      className="comparison-history"
      role="dialog"
      aria-label="比较历史版本"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          close();
        }
      }}
    >
      <header>
        <strong>比较历史版本 · {source.title || "未命名对象"}</strong>
        <button type="button" autoFocus onClick={close}>
          关闭
        </button>
      </header>
      {error && <p role="alert">{error}</p>}
      {!versions && !error && <p role="status">正在读取对象历史…</p>}
      {versions &&
        (versions.versions.length === 0 ? (
          <p>这个对象暂时没有可比较的旧版本。</p>
        ) : (
          <>
            {option("左侧版本", left, setLeft)}
            {option("右侧版本", right, setRight)}
            {versions.truncated && <p>这里只提供最近的 100 个可用版本。</p>}
            <button
              type="button"
              disabled={pending || !left || !right || left === right}
              onClick={async () => {
                setPending(true);
                setError("");
                try {
                  await create(
                    { ...source, version: versions.current },
                    {
                      ...(left !== "current" ? { left: Number(left) } : {}),
                      ...(right !== "current" ? { right: Number(right) } : {}),
                    },
                  );
                  close();
                } catch (reason) {
                  setError(
                    reason instanceof Error
                      ? reason.message
                      : "无法创建版本比较。",
                  );
                } finally {
                  setPending(false);
                }
              }}
            >
              创建比较
            </button>
          </>
        ))}
    </aside>
  );
}
