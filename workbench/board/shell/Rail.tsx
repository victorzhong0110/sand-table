import { Icon } from "../Icon.tsx";
import { NAV_ITEMS, type NavId } from "./nav.ts";

function Glyph({ name }: { name: string }) {
  if (name === "help") {
    return (
      <svg
        width="20"
        height="20"
        viewBox="0 0 20 20"
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      >
        <circle cx="10" cy="10" r="7" />
        <path d="M8 8a2 2 0 1 1 2.4 2c-.7.3-1.4.7-1.4 1.6V12" />
        <circle cx="10" cy="14.6" r="0.7" fill="currentColor" stroke="none" />
      </svg>
    );
  }
  return <Icon name={name} />;
}

export function Rail({
  open,
  connected,
  onToggle,
  onCollapse,
  buttonRef,
}: {
  open: NavId | null;
  connected: boolean;
  onToggle: (id: NavId) => void;
  onCollapse: () => void;
  buttonRef: (id: NavId, node: HTMLButtonElement | null) => void;
}) {
  return (
    <nav className="app-rail" aria-label="主导航">
      <span className="rail-brand" title="Sand Table">
        S
      </span>
      {NAV_ITEMS.map((item) => (
        <button
          key={item.id}
          type="button"
          ref={(node) => buttonRef(item.id, node)}
          aria-label={item.label}
          title={item.label}
          aria-pressed={open === item.id}
          data-connection={
            item.id === "help" ? (connected ? "on" : "off") : undefined
          }
          onClick={() => onToggle(item.id)}
        >
          <Glyph name={item.icon} />
          {item.id === "help" && (
            <span
              className={"help-dot " + (connected ? "is-on" : "is-off")}
              aria-hidden="true"
            />
          )}
        </button>
      ))}
      <button
        type="button"
        className="rail-focus"
        aria-label="专注画布"
        title="专注画布（F）"
        onClick={onCollapse}
      >
        F
      </button>
    </nav>
  );
}
