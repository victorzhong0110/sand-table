import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { MenuEntry } from "./arrange.ts";

type MenuProps = {
  x: number;
  y: number;
  label: string;
  items: readonly MenuEntry[];
  onSelect: (id: MenuEntry["id"]) => void;
  onClose: () => void;
};

function nextEnabled(
  items: readonly MenuEntry[],
  index: number,
  step: 1 | -1,
): number {
  if (!items.length) return -1;
  for (let offset = 1; offset <= items.length; offset += 1) {
    const next = (index + step * offset + items.length) % items.length;
    if (!items[next]?.disabled) return next;
  }
  return index;
}

export function ContextMenu({
  x,
  y,
  label,
  items,
  onSelect,
  onClose,
}: MenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(() =>
    items.findIndex((item) => !item.disabled),
  );
  const [point, setPoint] = useState({ x, y });

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    const maxX = Math.max(8, window.innerWidth - rect.width - 8);
    const maxY = Math.max(8, window.innerHeight - rect.height - 8);
    setPoint({
      x: Math.min(Math.max(8, x), maxX),
      y: Math.min(Math.max(8, y), maxY),
    });
  }, [x, y, items]);

  useEffect(() => {
    const button =
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[
        index
      ];
    button?.focus({ preventScroll: true });
  }, [index]);

  useEffect(() => {
    const onPointer = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      onClose();
    };
    document.addEventListener("mousedown", onPointer);
    return () => document.removeEventListener("mousedown", onPointer);
  }, [onClose]);

  const move = (step: 1 | -1) => {
    setIndex((current) => nextEnabled(items, current, step));
  };

  const choose = (item: MenuEntry | undefined) => {
    if (!item || item.disabled) return;
    onSelect(item.id);
  };

  return createPortal(
    <div
      ref={menuRef}
      className="arrange-menu"
      role="menu"
      aria-label={label}
      style={{ left: point.x, top: point.y }}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          event.stopPropagation();
          move(1);
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          event.stopPropagation();
          move(-1);
          return;
        }
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          event.stopPropagation();
          choose(items[index]);
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      {items.map((item, itemIndex) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          className="nodrag nopan"
          aria-disabled={item.disabled ? true : undefined}
          data-active={itemIndex === index ? "true" : undefined}
          title={item.hint}
          onMouseEnter={() => {
            if (!item.disabled) setIndex(itemIndex);
          }}
          onClick={() => choose(item)}
        >
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}

export function DeleteObjectDialog({
  count,
  onConfirm,
  onCancel,
}: {
  count: number;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus({ preventScroll: true });
  }, []);
  return createPortal(
    <div
      className="arrange-confirm"
      role="dialog"
      aria-modal="true"
      aria-label="彻底删除对象"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }}
    >
      <p>这个对象还出现在 {count} 块白板上，删除后都会消失；可以撤销</p>
      <div className="row">
        <button type="button" onClick={onCancel} ref={cancelRef}>
          取消
        </button>
        <button type="button" className="danger" onClick={onConfirm}>
          彻底删除
        </button>
      </div>
    </div>,
    document.body,
  );
}
