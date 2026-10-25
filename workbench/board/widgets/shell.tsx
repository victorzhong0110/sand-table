import type { ReactNode } from "react";

export function WidgetShell({
  label,
  readOnly,
  onClear,
  children,
}: {
  label: string;
  readOnly: boolean;
  onClear: () => void;
  children: ReactNode;
}) {
  return (
    <span className="widget">
      {children}
      {!readOnly && (
        <button
          type="button"
          className="widget-clear"
          aria-label={`清空${label}`}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onClear();
          }}
        >
          清空
        </button>
      )}
    </span>
  );
}
