import { diffLines, diffWordsWithSpace } from "diff";
import { migrateTable } from "../../packs/base/migrations.ts";
import { cellValue, tableOf, type TableData } from "../data/table-model.ts";

const maxText = 20_000;
const maxLines = 2000;

type Piece = { text: string; changed: boolean };
type Line = { number: number; text: string; pieces?: Piece[] };
export type LinePair = {
  left?: Line;
  right?: Line;
  changed: boolean;
};

function lines(text: string) {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

export function compareText(left: string, right: string, words: boolean) {
  if (
    left.length > maxText ||
    right.length > maxText ||
    lines(left).length > maxLines ||
    lines(right).length > maxLines
  )
    return { unsupported: "内容超过差异视图上限。", rows: [] as LinePair[] };
  const changes = diffLines(left, right, {
    timeout: 100,
    maxEditLength: maxLines * 2,
  });
  if (!changes)
    return {
      unsupported: "差异过多，无法在限定时间内生成。",
      rows: [] as LinePair[],
    };
  const rows: LinePair[] = [];
  const removed: Line[] = [];
  const added: Line[] = [];
  const wordDeadline = performance.now() + 80;
  let leftLine = 0;
  let rightLine = 0;
  const flush = () => {
    for (
      let index = 0;
      index < Math.max(removed.length, added.length);
      index++
    ) {
      const from = removed[index];
      const to = added[index];
      const remaining = wordDeadline - performance.now();
      if (
        words &&
        from &&
        to &&
        remaining > 0 &&
        from.text.length + to.text.length <= 1000
      ) {
        const parts = diffWordsWithSpace(from.text, to.text, {
          timeout: Math.min(25, remaining),
          maxEditLength: 250,
        });
        if (parts) {
          from.pieces = parts
            .filter((part) => !part.added)
            .map((part) => ({ text: part.value, changed: part.removed }));
          to.pieces = parts
            .filter((part) => !part.removed)
            .map((part) => ({ text: part.value, changed: part.added }));
        }
      }
      rows.push({ left: from, right: to, changed: true });
    }
    added.length = 0;
    removed.length = 0;
  };
  for (const change of changes) {
    const segment = lines(change.value);
    if (change.removed) {
      removed.push(...segment.map((text) => ({ number: ++leftLine, text })));
    } else if (change.added) {
      added.push(...segment.map((text) => ({ number: ++rightLine, text })));
    } else {
      flush();
      rows.push(
        ...segment.map((text) => ({
          left: { number: ++leftLine, text },
          right: { number: ++rightLine, text },
          changed: false,
        })),
      );
    }
  }
  flush();
  return { rows };
}

export function compareTables(left: TableData, right: TableData) {
  const byColumn = ({ columns }: TableData) =>
    new Map(columns.map((column) => [column.key, column]));
  const byRow = ({ rows }: TableData) =>
    new Map(rows.map((row) => [row.key, row]));
  const leftColumns = byColumn(left);
  const rightColumns = byColumn(right);
  const leftRows = byRow(left);
  const rightRows = byRow(right);
  const columns = [
    ...new Set([...leftColumns.keys(), ...rightColumns.keys()]),
  ].map((key) => {
    const from = leftColumns.get(key);
    const to = rightColumns.get(key);
    return {
      key,
      left: from,
      right: to,
      changed:
        !from ||
        !to ||
        from.label !== to.label ||
        from.type !== to.type ||
        from.unit !== to.unit,
    };
  });
  const rows = [...new Set([...leftRows.keys(), ...rightRows.keys()])].map(
    (key) => {
      const from = leftRows.get(key);
      const to = rightRows.get(key);
      const presence = !from ? "added" : !to ? "removed" : "both";
      return {
        key,
        presence,
        cells: columns.map((column) => {
          const a =
            from && column.left ? cellValue(from, column.key) : undefined;
          const b = to && column.right ? cellValue(to, column.key) : undefined;
          return {
            key: column.key,
            left: a,
            right: b,
            changed: !Object.is(a, b),
          };
        }),
      };
    },
  );
  return { columns, rows };
}

type BoundTable = { data: Record<string, unknown>; typeVersion: number };

export function compareBoundTables(left: BoundTable, right: BoundTable) {
  const read = ({ data, typeVersion }: BoundTable) =>
    tableOf(typeVersion === 1 ? migrateTable(data) : data);
  return compareTables(read(left), read(right));
}
