import type { CSSProperties } from "react";
import type { ImpactPayload } from "../types";
import chestClosed from "../assets/loot-chest-closed.webp";
import chestOpen from "../assets/loot-chest-open.webp";
import sealDormant from "../assets/achievement-seal-dormant.webp";
import sealAwakened from "../assets/achievement-seal-awakened.webp";
import slayDivine from "../assets/slay-undead-divine.webp";

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

const ACHIEVEMENT_PARTICLES = [
  { x: -88, y: -72, delay: 0, size: 4 },
  { x: -58, y: -116, delay: 90, size: 6 },
  { x: -18, y: -132, delay: 180, size: 4 },
  { x: 26, y: -126, delay: 40, size: 5 },
  { x: 68, y: -104, delay: 140, size: 7 },
  { x: 94, y: -62, delay: 220, size: 4 },
  { x: -104, y: -28, delay: 260, size: 5 },
  { x: 110, y: -20, delay: 300, size: 5 },
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

/** Generated dormant/awakened seal selected by achievement triggers. */
export function AchievementSeal({ glyph }: { glyph?: string }) {
  return (
    <div className="ov-achievement-seal" aria-hidden="true">
      <span className="ov-achievement-aura" />
      <span className="ov-achievement-ring ring-one" />
      <span className="ov-achievement-ring ring-two" />
      <img
        className="ov-achievement-image seal-dormant"
        src={sealDormant}
        alt=""
        draggable={false}
      />
      <img
        className="ov-achievement-image seal-awakened"
        src={sealAwakened}
        alt=""
        draggable={false}
      />
      <span className="ov-achievement-flash" />
      <span className="ov-achievement-particles">
        {ACHIEVEMENT_PARTICLES.map((particle, index) => (
          <i
            key={index}
            style={{
              "--achievement-x": `${particle.x}px`,
              "--achievement-y": `${particle.y}px`,
              "--achievement-delay": `${particle.delay}ms`,
              "--achievement-size": `${particle.size}px`,
            } as CSSProperties}
          />
        ))}
      </span>
      {glyph && <span className="ov-achievement-glyph">{glyph}</span>}
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

/** Generated divine-strike artwork. Trigger data supplies all copy; this
 * component only owns the reusable visual treatment. */
export function SlayUndead() {
  return (
    <div className="ov-slay-undead" aria-hidden="true">
      <span className="ov-slay-skywash" />
      <img
        className="ov-slay-divine"
        src={slayDivine}
        alt=""
        draggable={false}
      />
      <span className="ov-slay-descent" />
      <span className="ov-slay-impact-flash" />
      <span className="ov-slay-shockwave" />
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

      {style === "achievement-seal" && (
        <>
          <AchievementSeal glyph={p.glyph} />
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

      {style === "slay-undead" && (
        <>
          <SlayUndead />
          {p.big && (
            <div className="ov-slay-damage">
              <strong>{p.big}</strong>
              <span>DAMAGE</span>
            </div>
          )}
        </>
      )}

      {/* Fallback for any unknown style: at least show the focal text. */}
      {style !== "slash" &&
        style !== "big-number" &&
        style !== "level" &&
        style !== "badge" &&
        style !== "medal" &&
        style !== "achievement-seal" &&
        style !== "loot-chest" &&
        style !== "monster-rip" &&
        style !== "slay-undead" &&
        p.big && <div className="ovi-big">{p.big}</div>}

      {p.sub && <div className="ovi-sub">{p.sub}</div>}
    </div>
  );
}
