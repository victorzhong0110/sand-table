import type { TypeSpecView } from "./format.ts";
import { formatValue } from "./format.ts";

/** 数据里有、Schema 里没有的字段。只读，不丢掉。 */
export function OtherFields({
  data,
  spec,
}: {
  data: Record<string, unknown>;
  spec: TypeSpecView | undefined;
}) {
  const known = new Set(Object.keys(spec?.schema?.properties ?? {}));
  const keys = Object.keys(data)
    .filter((key) => !known.has(key) && data[key] !== undefined)
    .sort();
  if (!keys.length) return null;
  return (
    <section className="other-fields">
      <h4>其他字段</h4>
      {keys.map((key) => (
        <p key={key}>
          <span>{key}</span> {shown(data[key])}
        </p>
      ))}
    </section>
  );
}

function shown(value: unknown): string {
  if (value && typeof value === "object")
    return formatValue(value, {
      type: Array.isArray(value) ? "array" : "object",
    });
  return String(value);
}
