# Legends Companion visual design spec

Professional, dark-first desktop tool. Think "modern dev tool that happens to be
for a game" (Linear/Grafana energy), NOT fantasy-themed — no parchment, no
medieval display fonts. Polish comes from spacing, alignment, restrained color,
and motion; identity comes from one accent hue and good numbers.

Dark is the default theme; a light theme ships too (toggle in Settings,
`data-theme` on the root, both themes fully specified below).

## Tokens (CSS custom properties on `:root`)

| Role                | Dark (default) | Light      |
|---------------------|----------------|------------|
| `--page`            | `#0d0d0d`      | `#f9f9f7`  |
| `--surface`         | `#1a1a19`      | `#fcfcfb`  |
| `--surface-raised`  | `#232322`      | `#ffffff`  |
| `--ink`             | `#ffffff`      | `#0b0b0b`  |
| `--ink-2`           | `#c3c2b7`      | `#52514e`  |
| `--ink-muted`       | `#898781`      | `#898781`  |
| `--hairline`        | `#2c2c2a`      | `#e1e0d9`  |
| `--border`          | `rgba(255,255,255,.10)` | `rgba(11,11,11,.10)` |
| `--accent`          | `#3987e5`      | `#2a78d6`  |
| `--accent-ink`      | `#ffffff`      | `#ffffff`  |

`--accent-ink` is the ink on accent-filled controls (primary buttons, selected
options) — never hardcode white/dark ink on an accent fill.

Overlay-only tokens, theme-independent (overlays always sit over game footage,
never over the app page): `--pill-bg: rgba(13,13,13,.72)` for pill/backdrop
surfaces and `--ov-text-shadow: 0 1px 2px rgba(0,0,0,.8)` for on-footage text
readability.

Series colors (damage meters — categorical, **assigned to a combatant on first
appearance and never repainted** when the roster changes; slot order is fixed):

| Slot | Dark      | Light     |
|------|-----------|-----------|
| 1    | `#3987e5` | `#2a78d6` |
| 2    | `#199e70` | `#1baf7a` |
| 3    | `#c98500` | `#eda100` |
| 4    | `#008300` | `#008300` |
| 5    | `#9085e9` | `#4a3aa7` |
| 6    | `#e66767` | `#e34948` |
| 7    | `#d55181` | `#e87ba4` |
| 8    | `#d95926` | `#d95926` |

Status (timers/alerts only — never reused as series colors): good `#0ca30c`,
warning `#fab219`, serious `#ec835a`, critical `#d03b3b`. Status is never
conveyed by color alone — pair with an icon or label.

## Typography

`system-ui, -apple-system, "Segoe UI", sans-serif` everywhere. No display face.
- Base 13px / 1.45; section titles 11px uppercase tracking `.08em` in `--ink-muted`.
- ALL numeric columns (damage, DPS, %, timers): `font-variant-numeric: tabular-nums`.
- Big stat-tile values: 24–28px semibold, proportional figures, label under in
  `--ink-2`.

## Layout

- Left icon+label sidebar nav (Live, Meters, Triggers, Settings), 200px, `--page`
  background; content area on `--surface` cards with 8px radius, `--border`
  hairline ring, 16px padding, 12px gaps. No heavy shadows — depth via the
  raised-surface step and hairlines.
- Top bar: current character + log-file connection status (pulsing dot: good
  green = tailing, muted = idle), overlay lock/unlock toggle.

## Damage meter (dashboard + overlay)

Horizontal bars, one per combatant, sorted by damage desc:
- Bar height 22px, 2px gap between bars, 4px radius on the value end only
  (baseline end square), track in `--surface-raised`. Light theme only: tracks
  (meter and timer bars, dashboard) add a 1px inset `--hairline` ring so bar
  length reads against the near-white card surface.
- Bar length ∝ damage relative to top combatant. Fill = the combatant's series
  color at 100%; never gradients.
- Label layout: name left INSIDE the row in `--ink` (not on the bar fill —
  text never wears the series color), values right-aligned: `total  dps  %`
  in tabular-nums, `--ink-2`.
- Pets fold into owner; show a small `+pet` suffix in `--ink-muted`.
- Row hover: ghost wash + tooltip with hit/miss/crit/max-hit breakdown.
- Stat tiles above the table: Fight duration, Total damage, Your DPS, Deaths —
  value + label, no chart junk.

## Timer bars (dashboard + alerts overlay)

- 18px bars counting DOWN (width shrinks), label left, remaining seconds right
  (tabular-nums, `ss` or `m:ss`).
- Fill: `--accent` normally; switches to warning color AND gains a ⚠ prefix when
  past the warn threshold; brief pulse animation on expiry, then row fades out
  over 300ms. The warn glyph + label carry ink, never the warning hue itself
  (glyph would vanish on the amber fill): dark ink where they overlap the fill,
  `--ink` over the track.

## Alerts overlay (over the game)

Readability over arbitrary game footage, without a solid box:
- Each alert line sits on a pill of `rgba(13,13,13,.72)` + 8px radius +
  `backdrop-filter: blur(4px)`; text `#ffffff` 15px semibold with
  `text-shadow: 0 1px 2px rgba(0,0,0,.8)`.
- Alerts stack newest-top, auto-fade after 4s (200ms ease-out slide+fade in,
  300ms fade out). Max 5 visible.
- Meter overlay: same pill treatment, compact top-5 bars, 16px bar height.
- "Unlock to arrange" mode: dashed accent border + move cursor + dim scrim on
  each overlay; locked mode has zero chrome.

## Motion

150–200ms ease-out on everything (tab switches, bar width changes, row
enter/leave). Meter bars animate width via CSS transition — no JS animation
loops. Respect `prefers-reduced-motion`.

## Live feed

Monospace-adjacent it is NOT — keep the system sans. Color the event-kind badge
(small 10px uppercase chip using the kind's hue at low alpha background), keep
message text in `--ink-2`, timestamps `--ink-muted` tabular-nums. Damage you
deal: `--ink`; damage you take: serious status color chip.

## Don'ts

- No dual-axis charts, no rainbow palettes, no color-cycling.
- No pure-white-on-black body text blocks (use `--ink-2` for prose).
- No emoji in the UI chrome. No skeuomorphic fantasy borders.
- Numbers never in series colors; marks carry color, text carries ink.
