export function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    browse: <path d="m5 3 13 9-6 1-3 6Z" />,
    arrange: (
      <>
        <path d="M10 2v16M2 10h16M7 5l3-3 3 3M7 15l3 3 3-3M5 7l-3 3 3 3m10-6 3 3-3 3" />
      </>
    ),
    ai: (
      <>
        <path d="m10 2 2.2 5.8L18 10l-5.8 2.2L10 18l-2.2-5.8L2 10l5.8-2.2Z" />
      </>
    ),
    grip: (
      <>
        {[6, 10, 14].flatMap((y) =>
          [7, 13].map((x) => (
            <circle
              key={x + "-" + y}
              cx={x}
              cy={y}
              r=".7"
              fill="currentColor"
            />
          )),
        )}
      </>
    ),
    board: (
      <>
        <rect x="2" y="3" width="16" height="14" rx="2" />
        <path d="M6 7h8M6 11h4" />
      </>
    ),
    resource: (
      <>
        <rect x="2" y="3" width="16" height="14" rx="2" />
        <circle cx="7" cy="7" r="1" />
        <path d="m3 15 5-5 3 3 3-4 4 6" />
      </>
    ),
    chart: (
      <>
        <path d="M3 3v14h15M7 14V9m4 5V5m4 9V7" />
      </>
    ),
    table: (
      <>
        <rect x="2" y="3" width="16" height="14" rx="2" />
        <path d="M2 8h16M8 8v9M2 12h16" />
      </>
    ),
    task: (
      <>
        <rect x="3" y="3" width="14" height="14" rx="2" />
        <path d="m6 10 3 3 5-6" />
      </>
    ),
    comparison: (
      <>
        <path d="M2 7h15l-3-3m4 9H3l3 3M10 2v16" />
      </>
    ),
    events: (
      <>
        <path d="M7 5h10M7 10h10M7 15h10" />
        <circle cx="3" cy="5" r=".5" />
        <circle cx="3" cy="10" r=".5" />
        <circle cx="3" cy="15" r=".5" />
      </>
    ),
    status: (
      <>
        <circle cx="10" cy="10" r="6" />
        <circle cx="10" cy="10" r="2" fill="currentColor" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      {paths[name] || paths.board}
    </svg>
  );
}
