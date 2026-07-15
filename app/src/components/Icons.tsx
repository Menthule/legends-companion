// Tiny inline icon set — 16px, stroke = currentColor. No emoji in chrome.

interface IconProps {
  size?: number;
}

function svgProps(size: number) {
  return {
    width: size,
    height: size,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
}

export function IconLive({ size = 16 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M1.5 8.5h3L6.5 4l3 8.5L11 8.5h3.5" />
    </svg>
  );
}

export function IconMeters({ size = 16 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M2.5 3.5h11M2.5 3.5v10" opacity="0" />
      <rect x="2.5" y="3" width="11" height="2.6" rx="1" />
      <rect x="2.5" y="6.7" width="7.5" height="2.6" rx="1" />
      <rect x="2.5" y="10.4" width="4.5" height="2.6" rx="1" />
    </svg>
  );
}

/** Fight history: a clock — the tab is about looking back at past pulls. */
export function IconFights({ size = 16 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.8V8l2.4 1.6" />
    </svg>
  );
}

/** Timers: a stopwatch — crown button + hand, distinct from the Fights clock. */
export function IconTimers({ size = 16 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <circle cx="8" cy="9" r="5" />
      <path d="M8 9V6M6.4 2.2h3.2M8 2.2v1.8M12.4 5.2l1-1" />
    </svg>
  );
}

/** Session insights: compass needle over a small dial. */
export function IconInsights({ size = 16 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <circle cx="8" cy="8" r="6" />
      <path d="M9.9 4.5 8.6 8.6 4.5 9.9 7.4 7.4z" />
      <path d="M8 2.8v1M8 12.2v1M2.8 8h1M12.2 8h1" />
    </svg>
  );
}

export function IconTriggers({ size = 16 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M8.7 1.5 3.6 9h3.5l-1 5.5L11.9 7H8.4l1.1-5.5Z" />
    </svg>
  );
}

/** Diagnostics: small bug with probe legs. */
export function IconDiagnostics({ size = 16 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <rect x="5" y="5" width="6" height="7" rx="2" />
      <path d="M6.2 5 5 3.5M9.8 5 11 3.5" />
      <path d="M3 7h2M11 7h2M3.5 10h1.7M10.8 10h1.7" />
      <path d="M8 5v7" />
      <circle cx="6.8" cy="7.2" r=".2" />
      <circle cx="9.2" cy="7.2" r=".2" />
    </svg>
  );
}

export function IconSettings({ size = 16 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <circle cx="8" cy="8" r="2.4" />
      <path d="M8 1.7v1.9M8 12.4v1.9M1.7 8h1.9M12.4 8h1.9M3.5 3.5l1.4 1.4M11.1 11.1l1.4 1.4M12.5 3.5l-1.4 1.4M4.9 11.1l-1.4 1.4" />
    </svg>
  );
}

/** Drops research: a cut gem — loot. */
export function IconDrops({ size = 16 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M5 2.5h6l3 4L8 13.5 2 6.5z" />
      <path d="M2 6.5h12M5.5 2.5 8 13.5 10.5 2.5" />
    </svg>
  );
}

/** Spells database: a sparkle — arcane. */
export function IconSpells({ size = 16 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M6.5 2 7.7 5.8 11.5 7 7.7 8.2 6.5 12 5.3 8.2 1.5 7 5.3 5.8Z" />
      <path d="M12.2 10l.6 1.9 1.9.6-1.9.6-.6 1.9-.6-1.9-1.9-.6 1.9-.6Z" />
    </svg>
  );
}

/** Mobs database: a paw print — the bestiary. */
export function IconMobs({ size = 16 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M8 13.7c-2.1 0-3.6-1-3.6-2.5C4.4 9.4 6 7.9 8 7.9s3.6 1.5 3.6 3.3c0 1.5-1.5 2.5-3.6 2.5z" />
      <circle cx="3.8" cy="6.4" r="1.2" />
      <circle cx="8" cy="4.6" r="1.2" />
      <circle cx="12.2" cy="6.4" r="1.2" />
    </svg>
  );
}

/** Recipes database: mortar & pestle — tradeskill combines. */
export function IconRecipes({ size = 16 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M2.8 7h10.4v1a5.2 5.2 0 0 1-10.4 0z" />
      <path d="M9.3 7 13.4 2.4" />
    </svg>
  );
}

/** Quest database: an open journal with a center binding. */
export function IconQuests({ size = 16 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M2.2 3.2c2.1-.5 3.8 0 5.8 1.2v9c-2-1.2-3.7-1.7-5.8-1.2z" />
      <path d="M13.8 3.2c-2.1-.5-3.8 0-5.8 1.2v9c2-1.2 3.7-1.7 5.8-1.2z" />
    </svg>
  );
}

/** Inventory database: a compact pack with lid and front pocket. */
export function IconInventory({ size = 16 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M4 5V4a4 4 0 0 1 8 0v1M2.5 5.5h11v8h-11z" />
      <path d="M5 9.5h6v4H5zM5.2 5.5v2M10.8 5.5v2" />
    </svg>
  );
}

/** Macros: a hotbutton square with command lines. */
export function IconMacros({ size = 16 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
      <path d="M5.5 6h5M5.5 8.5h5M5.5 11h3" />
    </svg>
  );
}

export function IconLock({ size = 14 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
      <path d="M5.5 7V4.9a2.5 2.5 0 0 1 5 0V7" />
    </svg>
  );
}

export function IconUnlock({ size = 14 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
      <path d="M5.5 7V4.9a2.5 2.5 0 0 1 4.8-1" />
    </svg>
  );
}

export function IconPlay({ size = 13 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M5 3.2v9.6l7.4-4.8L5 3.2Z" />
    </svg>
  );
}

export function IconStop({ size = 13 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <rect x="4" y="4" width="8" height="8" rx="1.2" />
    </svg>
  );
}

export function IconWarn({ size = 12 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M8 2 1.8 13h12.4L8 2Z" />
      <path d="M8 6.5v3M8 11.4v.2" />
    </svg>
  );
}

/** Speaker with an X: the audio kill switch (silence queued alerts). */
export function IconSpeakerOff({ size = 14 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M2 6.2v3.6h2.4l3.4 3V3.2l-3.4 3H2Z" />
      <path d="M10.6 6.4l3.2 3.2M13.8 6.4l-3.2 3.2" />
    </svg>
  );
}

export function IconEye({ size = 16 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M1.5 8s2.4-4.2 6.5-4.2S14.5 8 14.5 8 12.1 12.2 8 12.2 1.5 8 1.5 8Z" />
      <circle cx="8" cy="8" r="2" />
    </svg>
  );
}

export function IconEyeOff({ size = 16 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M3.2 4.6C2 5.9 1.5 8 1.5 8s2.4 4.2 6.5 4.2c1.2 0 2.3-.4 3.2-.9M6.6 4C7 3.9 7.5 3.8 8 3.8c4.1 0 6.5 4.2 6.5 4.2s-.7 1.2-1.9 2.4" />
      <path d="M2 2l12 12" />
    </svg>
  );
}

export function IconChevronDown({ size = 16 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="m3.5 6 4.5 4 4.5-4" />
    </svg>
  );
}

export function IconArrowUp({ size = 16 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M8 13V3M4.5 6.5 8 3l3.5 3.5" />
    </svg>
  );
}

export function IconArrowDown({ size = 16 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M8 3v10M4.5 9.5 8 13l3.5-3.5" />
    </svg>
  );
}

export function IconCopy({ size = 16 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.5" />
      <path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" />
    </svg>
  );
}

export function IconTrash({ size = 16 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M3 4.5h10M6 4.5V2.8h4v1.7M4.5 4.5l.7 9h5.6l.7-9M6.8 7v4M9.2 7v4" />
    </svg>
  );
}
