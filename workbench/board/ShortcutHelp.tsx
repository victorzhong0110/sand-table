import { SHORTCUTS } from "./canvas/keymap.ts";

export function ShortcutHelp({ onClose }: { onClose: () => void }) {
  return (
    <div className="settings-backdrop" onClick={onClose}>
      <section
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="快捷键"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }}
      >
        <header
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <h2>快捷键</h2>
          <button aria-label="关闭快捷键说明" autoFocus onClick={onClose}>
            ×
          </button>
        </header>
        <div style={{ overflow: "auto", padding: 24 }}>
          <p style={{ marginTop: 0 }}>
            焦点在输入框、文本区域或正在编辑的内容里时，这些快捷键都不会触发。Windows
            上把 ⌘ 换成 Ctrl。
          </p>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left" }}>Mac</th>
                <th style={{ textAlign: "left" }}>Windows</th>
                <th style={{ textAlign: "left" }}>行为</th>
              </tr>
            </thead>
            <tbody>
              {SHORTCUTS.map((shortcut) => (
                <tr key={shortcut.id} data-shortcut-id={shortcut.id}>
                  <td
                    style={{ padding: "8px 12px 8px 0", whiteSpace: "nowrap" }}
                  >
                    {shortcut.macLabel}
                  </td>
                  <td
                    style={{ padding: "8px 12px 8px 0", whiteSpace: "nowrap" }}
                  >
                    {shortcut.windowsLabel}
                  </td>
                  <td style={{ padding: "8px 0" }}>{shortcut.behavior}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
