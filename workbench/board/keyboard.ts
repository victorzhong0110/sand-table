export function blocksCanvasShortcut(e: KeyboardEvent): boolean {
  const target = e.target instanceof HTMLElement ? e.target : null;
  return (
    e.defaultPrevented ||
    e.isComposing ||
    Boolean(
      document.querySelector('[role="dialog"][aria-modal="true"]') ||
      target?.closest(
        'input, textarea, select, [contenteditable="true"], [role="textbox"], video, audio, [role="dialog"], [role="menu"]',
      ),
    )
  );
}
