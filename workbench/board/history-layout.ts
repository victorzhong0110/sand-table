// The history panel is a fixed-width column: the indent of a record must not
// grow with the length of the chain. A record's parentId says what it
// happened on top of, so 37 consecutive edits are 37 levels deep — indenting
// by that depth pushed the last record out of the panel.
//
// Only a record that a later edit branched away from needs to stand out.
// Those sit one step to the right; everything else stays on one left edge.
export function indentOf(record: { branch?: boolean }): 0 | 1 {
  return record.branch ? 1 : 0;
}
