import type { CSSProperties } from "react";
import type { ImpactPayload } from "../types";
import chestClosed from "../assets/loot-chest-closed.webp";
import chestOpen from "../assets/loot-chest-open.webp";

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

const LOOT_PARTICLES = [
  { x: -72, y: -90, delay: 0, size: 5 },
  { x: -42, y: -118, delay: 70, size: 7 },
  { x: -12, y: -82, delay: 130, size: 4 },
  { x: 18, y: -126, delay: 40, size: 6 },
  { x: 48, y: -94, delay: 160, size: 5 },
  { x: 76, y: -70, delay: 90, size: 7 },
  { x: -88, y: -52, delay: 190, size: 4 },
  { x: 92, y: -46, delay: 220, size: 4 },
] as const;

/** Generated chest artwork used by trigger-owned loot moments. The optional
 * glyph is presentation data from the action, never parsed by the overlay. */
export function LootChest({ glyph }: { glyph?: string }) {
  return (
    <div className="ov-loot-chest" aria-hidden="true">
      <span className="ov-chest-aura" />
      <span className="ov-chest-rays" />
      <img className="ov-chest-image ov-chest-closed" src={chestClosed} alt="" draggable={false} />
      <img className="ov-chest-image ov-chest-open" src={chestOpen} alt="" draggable={false} />
      <span className="ov-chest-flash" />
      <span className="ov-chest-particles">
        {LOOT_PARTICLES.map((particle, index) => (
          <i
            key={index}
            style={{
              "--loot-x": `${particle.x}px`,
              "--loot-y": `${particle.y}px`,
              "--loot-delay": `${particle.delay}ms`,
              "--loot-size": `${particle.size}px`,
            } as CSSProperties}
          />
        ))}
      </span>
      {glyph && <span className="ov-chest-glyph">{glyph}</span>}
    </div>
  );
}

/** Tombstone presentation selected by a trigger for watched-kill moments. */
export function MonsterRip({ glyph }: { glyph?: string }) {
  return (
    <div className="ov-monster-rip" aria-hidden="true">
      <svg viewBox="0 0 150 150" width="100%" height="100%">
        <ellipse className="ov-rip-shadow" cx="75" cy="137" rx="58" ry="9" />
        <path className="ov-rip-stone" d="M34 132V62c0-29 17-47 41-47s41 18 41 47v70Z" />
        <path className="ov-rip-edge" d="M45 132V65c0-23 12-37 30-37s30 14 30 37v67" />
        <path className="ov-rip-crack" d="M102 50 88 65l9 9-17 17" />
      </svg>
      <span className="ov-rip-glyph">{glyph ?? "RIP"}</span>
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
  const intensity = p.intensity ?? "high";

  return (
    <div
      className={`ov-impact impact-${style} impact-intensity-${intensity}${leaving ? " leaving" : ""}`}
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

      {style === "monster-rip" && (
        <>
          <MonsterRip glyph={p.glyph} />
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
        style !== "monster-rip" &&
        p.big && <div className="ovi-big">{p.big}</div>}

      {p.sub && <div className="ovi-sub">{p.sub}</div>}
    </div>
  );
}
