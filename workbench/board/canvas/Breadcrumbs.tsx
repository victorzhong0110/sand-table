export function Breadcrumbs({
  items,
  canReturn,
  detail,
  onOpen,
  onReturn,
}: {
  items: readonly { id: string; title: string }[];
  canReturn: boolean;
  detail: string;
  onOpen: (id: string) => void;
  onReturn: () => void;
}) {
  return (
    <nav className="breadcrumbs" aria-label="白板路径">
      {canReturn && (
        <button type="button" onClick={onReturn}>
          返回
        </button>
      )}
      {items.map((item, index) => {
        const current = index === items.length - 1;
        return (
          <button
            key={`${item.id}:${index}`}
            type="button"
            aria-current={current ? "page" : undefined}
            onClick={() => onOpen(item.id)}
          >
            {item.title || "未命名白板"}
          </button>
        );
      })}
      <span>{detail}</span>
    </nav>
  );
}
