import { formatValue, packIdOf } from "./format.ts";

export function UnknownType({
  title,
  typeName,
  packTitle,
  data,
  readOnly,
  onOpenSettings,
}: {
  title: string;
  typeName: string;
  packTitle: string;
  data: Record<string, unknown>;
  readOnly: boolean;
  onOpenSettings?: () => void;
}) {
  const pack = packTitle || packIdOf(typeName);
  return (
    <div className="unknown-type">
      <strong>{title || "未命名"}</strong>
      <p>{typeName}</p>
      <p>此类型来自未启用的包「{pack}」</p>
      {Object.entries(data).map(([key, value]) => (
        <p key={key}>
          {key}{" "}
          {value && typeof value === "object"
            ? formatValue(value, {
                type: Array.isArray(value) ? "array" : "object",
              })
            : String(value ?? "")}
        </p>
      ))}
      {readOnly && <p>数据只读</p>}
      {onOpenSettings && (
        <button type="button" onClick={onOpenSettings}>
          去设置里启用
        </button>
      )}
    </div>
  );
}
