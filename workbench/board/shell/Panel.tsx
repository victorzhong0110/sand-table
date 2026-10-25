import {
  useRef,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

export function PanelResize({
  onResizeStart,
}: {
  onResizeStart: (event: ReactPointerEvent<HTMLElement>) => void;
}) {
  return (
    <div
      className="shell-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="调整面板宽度"
      onPointerDown={onResizeStart}
    />
  );
}

export function Panel({
  title,
  dialog,
  width,
  panelRef,
  onClose,
  onResizeStart,
  children,
}: {
  title: string;
  dialog?: boolean;
  width: number;
  panelRef?: (node: HTMLElement | null) => void;
  onClose: () => void;
  onResizeStart: (event: ReactPointerEvent<HTMLElement>) => void;
  children: ReactNode;
}) {
  const root = useRef<HTMLElement | null>(null);
  const setRef = (node: HTMLElement | null) => {
    root.current = node;
    panelRef?.(node);
  };
  return (
    <section
      ref={setRef}
      className="shell-float shell-card shell-panel"
      style={{ width }}
      tabIndex={-1}
      role={dialog ? "dialog" : "region"}
      aria-modal={dialog ? true : undefined}
      aria-label={title}
      onKeyDown={(event) => {
        if (!dialog) return;
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          event.stopPropagation();
          onClose();
          return;
        }
        if (event.key !== "Tab") return;
        const items = [
          ...event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex="0"]',
          ),
        ];
        const first = items[0];
        const last = items.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
    >
      <header className="shell-card-head">
        <h2>{title}</h2>
        <button
          type="button"
          aria-label={dialog ? "关闭设置" : "收起面板"}
          autoFocus={dialog}
          onClick={onClose}
        >
          ×
        </button>
      </header>
      <div
        className={dialog ? "settings-body shell-card-body" : "shell-card-body"}
      >
        {children}
      </div>
      <PanelResize onResizeStart={onResizeStart} />
    </section>
  );
}
