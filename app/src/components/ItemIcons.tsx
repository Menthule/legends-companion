// Item-type icon set: tiny inline-SVG silhouettes in the app's icon
// language (16px viewBox, stroke = currentColor, strokeWidth 1.5, round
// caps, no fills — see Icons.tsx). One icon per broad item family:
// weapons/consumables resolve by itemtype, armor by slot bits, and
// anything unknown falls back to a generic bag. Distinct silhouettes at
// 14px matter more than detail, so every icon is at most ~3 strokes.

interface IconDef {
  label: string;
  paths: JSX.Element;
}

// ---- shared path fragments (reused across labels) -------------------------

const ARROW_PATHS = (
  <>
    <path d="M3 13 12.6 3.4" />
    <path d="M12.9 3.1l-3.4.2M12.9 3.1l-.2 3.4" />
    <path d="M3 13l.4-2.6M3 13l2.6-.4" />
  </>
);

const INSTRUMENT_PATHS = (
  <>
    <path d="M6 12.3V4.2l6-1.7v8.1" />
    <circle cx="4.5" cy="12.4" r="1.5" />
    <circle cx="10.5" cy="10.6" r="1.5" />
  </>
);

const GEM_PATHS = (
  <>
    <path d="M5.5 3h5L13 6.3 8 13 3 6.3z" />
    <path d="M3 6.3h10" />
  </>
);

const GAUNTLET_PATHS = (
  <>
    <rect x="4.2" y="5.5" width="7.6" height="8" rx="2.4" />
    <path d="M6.8 5.5v3.2M9.2 5.5v3.2" />
  </>
);

const GENERIC: IconDef = {
  label: "Item",
  paths: (
    <>
      <path d="M5.2 6V5a2.8 2.8 0 0 1 5.6 0v1" />
      <path d="M3.5 6h9l-.9 7.5H4.4z" />
    </>
  ),
};

// ---- weapons + consumables by itemtype -------------------------------------

const TYPE_ICONS: Record<number, IconDef> = {
  0: {
    label: "1H Slashing",
    paths: (
      <>
        <path d="M12.8 3.2 6.8 9.2" />
        <path d="M5 7.6l3.4 3.4" />
        <path d="M6.3 9.7 3.4 12.6" />
      </>
    ),
  },
  1: {
    label: "2H Slashing",
    paths: (
      <>
        <path d="M8 1.5v9" />
        <path d="M4.8 10.5h6.4" />
        <path d="M8 10.5v4" />
      </>
    ),
  },
  2: {
    label: "Piercing",
    paths: (
      <>
        <path d="M8 1.5 9.4 6.8 8 9.6 6.6 6.8z" />
        <path d="M5.8 11h4.4" />
        <path d="M8 9.6v4.9" />
      </>
    ),
  },
  3: {
    label: "1H Blunt",
    paths: (
      <>
        <circle cx="8" cy="4.8" r="2.8" />
        <path d="M8 7.6v6.9" />
      </>
    ),
  },
  4: {
    label: "2H Blunt",
    paths: (
      <>
        <path d="M4.5 14 10.6 4.9" />
        <circle cx="11.5" cy="3.5" r="2" />
      </>
    ),
  },
  5: {
    label: "Bow",
    paths: (
      <>
        <path d="M5 1.8c4.2 2.7 4.2 9.7 0 12.4" />
        <path d="M5 1.8v12.4" />
      </>
    ),
  },
  7: {
    label: "Throwing",
    paths: <path d="M8 2 9.6 6.4 14 8 9.6 9.6 8 14 6.4 9.6 2 8 6.4 6.4Z" />,
  },
  8: {
    label: "Shield",
    paths: (
      <>
        <path d="M8 1.5 13 3.3v4.2c0 3.3-2.1 5.6-5 6.9-2.9-1.3-5-3.6-5-6.9V3.3z" />
        <path d="M8 1.5v13" />
      </>
    ),
  },
  14: {
    label: "Food",
    paths: (
      <>
        <circle cx="8" cy="9.2" r="4.6" />
        <path d="M8 4.6c.2-1.4 1.1-2.2 2.4-2.4" />
      </>
    ),
  },
  15: {
    label: "Drink",
    paths: (
      <>
        <path d="M4 3.5h6.5v8.5a1.8 1.8 0 0 1-1.8 1.8H5.8A1.8 1.8 0 0 1 4 12z" />
        <path d="M10.5 5.5h1.3a1.7 1.7 0 0 1 0 3.4h-1.3" />
      </>
    ),
  },
  17: {
    label: "Light",
    paths: (
      <>
        <path d="M8 1.8c1.8 1.7 2.7 3.2 2.7 4.6a2.7 2.7 0 0 1-5.4 0C5.3 5 6.2 3.5 8 1.8z" />
        <path d="M8 9.1v5.4" />
      </>
    ),
  },
  20: {
    label: "Scroll",
    paths: (
      <>
        <path d="M5 2.5h6.5V11a2.4 2.4 0 0 1-2.4 2.5H5z" />
        <path d="M7 5.5h2.5M7 8h2.5" />
      </>
    ),
  },
  21: {
    label: "Potion",
    paths: (
      <>
        <path d="M7 2.5v3.3l-2.9 5.1a2 2 0 0 0 1.7 3h4.4a2 2 0 0 0 1.7-3L9 5.8V2.5" />
        <path d="M6.2 2.5h3.6" />
      </>
    ),
  },
  23: { label: "Wind Instrument", paths: INSTRUMENT_PATHS },
  24: { label: "Stringed Instrument", paths: INSTRUMENT_PATHS },
  25: { label: "Brass Instrument", paths: INSTRUMENT_PATHS },
  26: { label: "Percussion Instrument", paths: INSTRUMENT_PATHS },
  27: { label: "Arrow", paths: ARROW_PATHS },
  29: { label: "Jewelry", paths: GEM_PATHS },
  35: {
    label: "Note",
    paths: (
      <>
        <rect x="2.5" y="4" width="11" height="8" rx="1" />
        <path d="M2.8 5 8 9l5.2-4" />
      </>
    ),
  },
};

// ---- armor by slot bits, checked in order -----------------------------------

const SLOT_ICONS: [number, IconDef][] = [
  [
    4, // head
    {
      label: "Head",
      paths: (
        <>
          <path d="M3.5 13.5V8.2a4.5 4.5 0 0 1 9 0v5.3" />
          <path d="M3.5 10.5h9" />
        </>
      ),
    },
  ],
  [
    8, // face
    {
      label: "Face",
      paths: (
        <>
          <path d="M3 4.7c3.3-1.2 6.7-1.2 10 0v4.1c0 2.7-2.2 4.7-5 4.7s-5-2-5-4.7z" />
          <path d="M5.3 8.2h2M8.7 8.2h2" />
        </>
      ),
    },
  ],
  [
    2 | 16 | 32 | 32768 | 65536, // ear / neck / fingers
    { label: "Jewelry", paths: GEM_PATHS },
  ],
  [
    131072, // chest
    {
      label: "Chest",
      paths: (
        <>
          <path d="M4.5 2.5c2.3 1 4.7 1 7 0L13 5.5l-1.5 1.5v6.5h-7V7L3 5.5z" />
          <path d="M8 7.5v6" />
        </>
      ),
    },
  ],
  [128, { label: "Arms", paths: GAUNTLET_PATHS }],
  [512 | 1024, { label: "Wrist", paths: GAUNTLET_PATHS }],
  [4096, { label: "Hands", paths: GAUNTLET_PATHS }],
  [
    262144, // legs
    {
      label: "Legs",
      paths: (
        <path d="M4.5 2.5h7l-.6 11H8.6L8 7.9 7.4 13.5H5.1z" />
      ),
    },
  ],
  [
    524288, // feet
    {
      label: "Feet",
      paths: (
        <path d="M5.5 2.5h3.2v6.3c2.3.3 3.8 1.6 3.8 3.2v1.5H5.5z" />
      ),
    },
  ],
  [
    256, // back
    {
      label: "Back",
      paths: (
        <>
          <path d="M5.3 2.5 3.5 13.5 8 11.6l4.5 1.9-1.8-11" />
          <path d="M5.3 2.5a2.7 2.7 0 0 0 5.4 0" />
        </>
      ),
    },
  ],
  [
    64, // shoulders
    {
      label: "Shoulders",
      paths: (
        <>
          <path d="M2.5 11.2c0-3.9 2.4-6.7 5.5-6.7s5.5 2.8 5.5 6.7" />
          <path d="M5.2 11.2c0-2.3 1.2-3.9 2.8-3.9s2.8 1.6 2.8 3.9" />
        </>
      ),
    },
  ],
  [
    1048576, // waist
    {
      label: "Waist",
      paths: (
        <>
          <path d="M2 8.2h3.8M10.2 8.2H14" />
          <rect x="5.8" y="6.4" width="4.4" height="3.6" rx="0.9" />
        </>
      ),
    },
  ],
  [
    1, // charm
    {
      label: "Charm",
      paths: (
        <path d="M8 2.2l1.7 3.6 3.8.5-2.8 2.7.7 3.9L8 11l-3.4 1.9.7-3.9-2.8-2.7 3.8-.5z" />
      ),
    },
  ],
  [
    2048, // range
    {
      label: "Range",
      paths: (
        <>
          <circle cx="8" cy="8" r="4.2" />
          <path d="M8 1.8v2.4M8 11.8v2.4M1.8 8h2.4M11.8 8h2.4" />
        </>
      ),
    },
  ],
  [2097152, { label: "Ammo", paths: ARROW_PATHS }],
];

function pickIcon(itemtype: number, slots: number): IconDef {
  const byType = TYPE_ICONS[itemtype];
  if (byType) return byType;
  for (const [mask, def] of SLOT_ICONS) {
    if (slots & mask) return def;
  }
  return GENERIC;
}

/**
 * Item-family glyph for result rows and loot lists. Pass the item's
 * `itemtype` and `slots`; omit both (or pass null) for the generic icon.
 * The <title> element names the type as a native tooltip.
 */
export function ItemTypeIcon({
  itemtype,
  slots,
  size = 14,
}: {
  itemtype?: number | null;
  slots?: number | null;
  size?: number;
}) {
  const def = pickIcon(itemtype ?? -1, slots ?? 0);
  return (
    <svg
      className="item-type-icon"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label={def.label}
    >
      <title>{def.label}</title>
      {def.paths}
    </svg>
  );
}
