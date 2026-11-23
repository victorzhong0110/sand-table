export type Dimension = {
  kind: "number" | "date";
  field: string;
  endField?: string;
  label: string;
};
export type TimelineItem = {
  id: string;
  type: string;
  title: string;
  data: Record<string, unknown>;
  unavailable?: string;
  migrationError?: string;
};
export type Placement = { item: TimelineItem; start: number; end?: number };
const day = 86_400_000;

export function axisValue(
  value: unknown,
  kind: Dimension["kind"],
): number | undefined {
  if (kind === "number")
    return typeof value === "number" && Number.isFinite(value)
      ? value
      : undefined;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return undefined;
  const timestamp = Date.parse(value);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString().slice(0, 10) !== value
  )
    return undefined;
  return timestamp / day;
}

export function axisLabel(value: number, kind: Dimension["kind"]) {
  return kind === "date"
    ? new Date(value * day).toISOString().slice(0, 10)
    : String(Number(value.toPrecision(12)));
}

export function layoutTimeline(items: TimelineItem[], dimension: Dimension) {
  const placed: Placement[] = [];
  const unsorted: { item: TimelineItem; reason: string }[] = [];
  for (const item of items) {
    if (item.unavailable || item.migrationError) {
      unsorted.push({ item, reason: item.unavailable ?? item.migrationError! });
      continue;
    }
    const value = item.data[dimension.field];
    const start = axisValue(value, dimension.kind);
    const endValue = dimension.endField
      ? item.data[dimension.endField]
      : undefined;
    const end = axisValue(endValue, dimension.kind);
    if (start === undefined)
      unsorted.push({
        item,
        reason:
          value == null || value === "" ? "未填写时间" : "时间值与所选维度不符",
      });
    else if (endValue != null && endValue !== "" && end === undefined)
      unsorted.push({ item, reason: "结束值与所选维度不符" });
    else if (end !== undefined && end < start)
      unsorted.push({ item, reason: "结束值早于开始值" });
    else placed.push({ item, start, end });
  }
  placed.sort((a, b) =>
    a.start < b.start
      ? -1
      : a.start > b.start
        ? 1
        : a.item.id.localeCompare(b.item.id),
  );
  if (!placed.length) return { placed, unsorted, low: 0, high: 0 };
  return {
    placed,
    unsorted,
    low: placed[0].start,
    high: Math.max(...placed.map(({ start, end }) => end ?? start)),
  };
}

export function axisPosition(value: number, low: number, high: number) {
  if (high === low) return 0.5;
  const span = high - low;
  return Number.isFinite(span)
    ? (value - low) / span
    : (value / 2 - low / 2) / (high / 2 - low / 2);
}

export function timelineTicks(
  low: number,
  high: number,
  kind: Dimension["kind"],
): number[] {
  if (low === high) return [low];
  const span = high - low;
  if (!Number.isFinite(span) || span / 5 === 0) return [low, high];
  const exponent = 10 ** Math.floor(Math.log10(span / 5));
  if (!exponent) return [low, high];
  const normalized = span / 5 / exponent;
  const step = Math.max(
    kind === "date" ? 1 : Number.MIN_VALUE,
    exponent * ([1, 2, 5, 10].find((factor) => factor >= normalized) ?? 10),
  );
  const start = Math.ceil(low / step) * step;
  const values = Array.from(
    { length: 7 },
    (_, index) => start + index * step,
  ).filter((value) => Number.isFinite(value) && value >= low && value <= high);
  return values.length ? [...new Set(values)] : [low, high];
}
