import type { CSSProperties } from "react";
import type { ImpactPayload } from "../types";

/** Inline slab medal for badge/medal styles. */
function Medal({ glyph }: { glyph: string }) {
  return (
    <div className="ov-medal" aria-hidden="true">
      <svg viewBox="0 0 48 48" width="100%" height="100%">
        <polygon className="ov-medal-ribbon" points="17,4 24,20 31,4" />
        <circle className="ov-medal-disc" cx="24" cy="30" r="13" />
        <circle className="ov-medal-ring" cx="24" cy="30" r="13" />
      </svg>
      <span className="ov-medal-glyph">{glyph}</span>
    </div>
  );
}

/** Treasure chest used by trigger-owned loot moments. The optional glyph is
 * presentation data from the action, never an item parsed by the overlay. */
export function LootChest({ glyph }: { glyph?: string }) {
  return (
    <div className="ov-loot-chest" aria-hidden="true">
      <svg viewBox="0 0 160 136" width="100%" height="100%">
        <g className="ov-chest-glow">
          <circle cx="80" cy="72" r="43" />
          <path d="M80 8v22M25 28l18 17M135 28l-18 17M12 78h25M148 78h-25" />
        </g>
        <g className="ov-chest-lid">
          <path
            className="ov-chest-lid-fill"
            d="M30 62c2-25 18-39 50-39s48 14 50 39l-8 17H38Z"
          />
          <path className="ov-chest-trim" d="M31 61h98l-7 18H38Z" />
          <path className="ov-chest-band" d="M71 24h18v55H71Z" />
        </g>
        <path className="ov-chest-body" d="M25 74h110l-10 53H35Z" />
        <path className="ov-chest-trim" d="M25 74h110v15H25Z" />
        <path className="ov-chest-band" d="M70 74h20v53H70Z" />
        <path className="ov-chest-lock" d="M69 82h22v25H69Z" />
      </svg>
      <span className="ov-chest-glyph">{glyph ?? "*"}</span>
    </div>
  );
}

interface ImpactPresentationProps {
  payload: ImpactPayload;
  leaving?: boolean;
}

/** Pure visual renderer kept separate from event/window concerns so every
 * trigger-selected style can be exercised in focused component tests. */
export function ImpactPresentation({
  payload: p,
  leaving = false,
}: ImpactPresentationProps) {
  const accent = p.color
    ? ({ "--impact-accent": p.color } as CSSProperties)
    : undefined;
  const style = p.style || "badge";

  return (
    <div
      className={`ov-impact impact-${style}${leaving ? " leaving" : ""}`}
      style={accent}
    >
      {p.headline && <div className="ovi-headline">{p.headline}</div>}

      {style === "slash" && p.big != null && (
        <div className="ovf-strike">
          <span className="ovf-num whole">{p.big}</span>
          <span className="ovf-num top" aria-hidden="true">
            {p.big}
          </span>
          <span className="ovf-num bottom" aria-hidden="true">
            {p.big}
          </span>
          <span className="ovf-blade" aria-hidden="true" />
        </div>
      )}

      {(style === "big-number" || style === "level") && p.big != null && (
        <div className="ovi-big">{p.big}</div>
      )}

      {(style === "badge" || style === "medal") && (
        <>
          <Medal glyph={p.glyph ?? "✦"} />
          {p.big && <div className="ovi-name">{p.big}</div>}
        </>
      )}

      {style === "loot-chest" && (
        <>
          <LootChest glyph={p.glyph} />
          {p.big && <div className="ovi-name">{p.big}</div>}
        </>
      )}

      {/* Fallback for any unknown style: at least show the focal text. */}
      {style !== "slash" &&
        style !== "big-number" &&
        style !== "level" &&
        style !== "badge" &&
        style !== "medal" &&
        style !== "loot-chest" &&
        p.big && <div className="ovi-big">{p.big}</div>}

      {p.sub && <div className="ovi-sub">{p.sub}</div>}
    </div>
  );
}
