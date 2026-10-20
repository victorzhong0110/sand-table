export function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    text: (
      <>
        <path d="M4 2h12v13l-4 3H4Z" />
        <path d="M7 6h6M7 9h6M7 12h3m2 6v-3h4" />
      </>
    ),
    heading: <path d="M5 3v14M15 3v14M5 10h10" />,
    code: <path d="m6 5-4 5 4 5m8-10 4 5-4 5M12 3 8 17" />,
    metric: (
      <>
        <path d="M3 16V8m6 8V3m6 13v-5" />
        <path d="M2 18h16" />
      </>
    ),
    reasoning: (
      <>
        <circle cx="10" cy="9" r="6" />
        <path d="M8 16v2h4v-2M8 7a2 2 0 1 1 3 2l-1 1m0 2v.1" />
      </>
    ),
    intent: <path d="M3 17 17 3M8 3h9v9M3 10v7h7" />,
    proposal: (
      <>
        <rect x="3" y="2" width="14" height="16" rx="2" />
        <path d="M6 7h8m-4-3v6M6 14h8" />
      </>
    ),
    validation: (
      <>
        <path d="m10 2 7 3v5c0 4-7 8-7 8s-7-4-7-8V5Z" />
        <path d="m6 10 3 3 5-6" />
      </>
    ),
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
    copy: (
      <>
        <rect x="3" y="3" width="11" height="11" rx="2" />
        <path d="M7 14v1.5A2.5 2.5 0 0 0 9.5 18h6A2.5 2.5 0 0 0 18 15.5v-6A2.5 2.5 0 0 0 15.5 7H14" />
      </>
    ),
    pin: (
      <>
        <path d="M7 3h6l-1 5 2 2H6l2-2-1-5Z" />
        <path d="M10 10v7" />
      </>
    ),
    history: (
      <>
        <path d="M3 9a7 7 0 1 1 1.2 5.4" />
        <path d="M3 4v5h5" />
        <path d="M10 6v4l3 2" />
      </>
    ),
    undo: (
      <>
        <path d="M4 9h8a4 4 0 0 1 0 8H8" />
        <path d="m7 5-3 4 3 4" />
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
