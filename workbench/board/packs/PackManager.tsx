import { useEffect, useState } from "react";
import { usePackCatalog, type PackEntry } from "./catalog.ts";

type Tool = (name: string, args?: Record<string, unknown>) => Promise<any>;
type Manifest = {
  id?: string;
  types?: { type: string }[];
  [key: string]: unknown;
};

function messageOf(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed.message === "string" ? parsed.message : raw;
  } catch {
    return raw;
  }
}

export function PackManager({
  call,
  boardId,
  workspaceId,
  revision,
  download,
}: {
  call: Tool;
  boardId: string;
  workspaceId?: string;
  revision: number;
  download: (filename: string, text: string) => Promise<void>;
}) {
  const catalog = usePackCatalog(call, boardId, workspaceId, revision);
  const [manifests, setManifests] = useState<Record<string, Manifest>>({});
  const [pending, setPending] = useState<{
    pack: PackEntry;
    action: "disable" | "remove";
    count: number;
    workspaceId: string;
  }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      catalog.packs.map(
        async (pack) =>
          [
            pack.id,
            await call("app_pack", { action: "export", id: pack.id }),
          ] as const,
      ),
    )
      .then((entries) => {
        if (!cancelled) setManifests(Object.fromEntries(entries));
      })
      .catch((e) => {
        if (!cancelled) setError(messageOf(e));
      });
    return () => {
      cancelled = true;
    };
  }, [catalog.packs, workspaceId]);

  async function command(
    commands: Record<string, unknown>[],
    expectedWorkspaceId = workspaceId,
  ) {
    if (!expectedWorkspaceId)
      throw Error("工作空间尚未准备好，请重新打开设置后再试。");
    return call("app_edit", {
      workspaceId: expectedWorkspaceId,
      commands,
    });
  }
  async function importFile(file: File) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const manifest: unknown = JSON.parse(await file.text());
      if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
        throw Error("组件包必须是一份 JSON 对象。");
      await command([{ op: "pack.import", manifest }]);
      setNotice("组件包已导入。可以在工具箱中使用。");
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }
  async function countObjects(pack: PackEntry): Promise<number> {
    const types = (manifests[pack.id]?.types ?? []).map((type) => type.type);
    let total = 0;
    for (let i = 0; i < types.length; i += 20) {
      const result = await call("sand_query", {
        boardId: undefined,
        types: types.slice(i, i + 20),
        limit: 1,
      });
      total += Number(result.total ?? 0);
    }
    return total;
  }
  async function requestRemoval(pack: PackEntry, action: "disable" | "remove") {
    setBusy(true);
    setError("");
    try {
      if (!manifests[pack.id]) throw Error("组件包资料尚未加载，请稍后再试。");
      if (!workspaceId)
        throw Error("工作空间尚未准备好，请重新打开设置后再试。");
      setPending({
        pack,
        action,
        count: await countObjects(pack),
        workspaceId,
      });
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }
  async function perform(
    commands: Record<string, unknown>[],
    expectedWorkspaceId = workspaceId,
  ) {
    setBusy(true);
    setError("");
    try {
      await command(commands, expectedWorkspaceId);
      setPending(undefined);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="组件包管理" className="pack-manager">
      <h3>组件包</h3>
      <p className="settings-hint">组件包只包含类型和模板，不安装代码。</p>
      {catalog.loading && <p role="status">正在读取组件包…</p>}
      {(error || catalog.error) && <p role="alert">{error || catalog.error}</p>}
      {notice && <p role="status">{notice}</p>}
      {catalog.packs.map((pack) => (
        <div className="pack-group" key={pack.id}>
          <strong>{pack.title}</strong>{" "}
          <small>
            版本 {pack.version} · {pack.kind === "builtin" ? "内置" : "数据"} ·{" "}
            {manifests[pack.id]?.types?.length ?? "…"} 个类型
          </small>
          <div className="pack-actions">
            {pack.enabled ? (
              <button
                disabled={busy || pack.id === "base"}
                title={pack.id === "base" ? "基础包不能停用" : undefined}
                onClick={() => void requestRemoval(pack, "disable")}
              >
                停用
              </button>
            ) : (
              <button
                disabled={busy}
                onClick={() =>
                  void perform([{ op: "pack.enable", id: pack.id }])
                }
              >
                启用
              </button>
            )}
            {pack.kind === "data" && (
              <>
                <button
                  disabled={busy || !manifests[pack.id]}
                  onClick={() =>
                    void download(
                      `${pack.id}.json`,
                      JSON.stringify(manifests[pack.id], null, 2),
                    ).catch((e) => setError(messageOf(e)))
                  }
                >
                  导出
                </button>
                <button
                  disabled={busy}
                  onClick={() => void requestRemoval(pack, "remove")}
                >
                  移除
                </button>
              </>
            )}
          </div>
          {pack.id === "base" && <small>基础包不能停用。</small>}
        </div>
      ))}
      {pending && pending.workspaceId === workspaceId && (
        <div role="alertdialog" aria-label="确认组件包更改">
          <p>这个包的 {pending.count} 个对象会变成只读，数据不会丢失。</p>
          <button
            disabled={busy}
            onClick={() =>
              void perform(
                [{ op: `pack.${pending.action}`, id: pending.pack.id }],
                pending.workspaceId,
              )
            }
          >
            确认{pending.action === "disable" ? "停用" : "移除"}
          </button>
          <button disabled={busy} onClick={() => setPending(undefined)}>
            取消
          </button>
        </div>
      )}
      <label>
        导入组件包
        <input
          type="file"
          accept="application/json,.json"
          disabled={busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.currentTarget.value = "";
            if (file) void importFile(file);
          }}
        />
      </label>
    </section>
  );
}
