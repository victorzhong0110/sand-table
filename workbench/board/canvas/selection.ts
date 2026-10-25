/**
 * 快捷键该动哪些展示。
 *
 * 人刚清掉选区时，界面记下的是空数组。那就是当前选区，
 * 不能再去用服务器上还没写回的旧选区，否则方向键会挪已经取消的卡片。
 */
export function selectionForShortcut(
  override: readonly string[] | null,
  server: readonly string[],
  visual: readonly string[],
): string[] {
  if (override !== null) return [...override];
  if (server.length) return [...server];
  return [...visual];
}
