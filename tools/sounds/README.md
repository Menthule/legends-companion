# EQLogs alert sound generator

Synthesizes the app's bundled alert-sound set into `assets/sounds/`. Pure
Python 3 standard library (`wave`, `math`, `struct`) — no numpy, no external
audio tools.

## Regenerating

From the repo root:

```sh
python3 tools/sounds/generate_sounds.py
```

This rewrites all eleven WAVs plus `assets/sounds/manifest.json`, then
re-reads every file and prints a verification table (sample rate, duration,
peak dBFS, first-sample value). It exits non-zero if any file fails
verification. To re-verify existing files without regenerating:

```sh
python3 tools/sounds/generate_sounds.py --verify
```

## Format

- 44.1 kHz, 16-bit, mono WAV
- Peak-normalized to **-3 dBFS** (headroom for OS mixers; no clipping)
- 150-600 ms per sound (`tick.wav` is a deliberate 40 ms outlier)

## Design rationale

These are alert sounds for a log-watching overlay: they must be instantly
recognizable, non-fatiguing when they fire hundreds of times per session, and
distinguishable from each other by ear alone.

**Synthesis.** Every sound is a stack of 2-6 sine partials (fundamental plus
octave/twelfth at lower gain, or deliberately inharmonic ratios for the glass
and gong timbres). No square/saw waves — layered sines give body without
harshness. Each partial gets a 5 ms linear fade-in (kills onset clicks) and an
exponential decay; higher partials decay faster than the fundamental, which is
what makes the tones read as "struck bell/chime" rather than bare test tones.
A 10 ms fade-out at the end of each file prevents truncation clicks.

**Pitch language.** Emotional valence is carried by interval choice:

| Sound | Pitches | Interval logic |
|---|---|---|
| `alert.wav` | E5 → A5 | Ascending perfect fourth: neutral, attention without alarm |
| `chime2.wav` | G5 → C6 | Same gesture transposed up — distinguishable trigger variant |
| `chime3.wav` | C5 → F5 | Same gesture transposed down — distinguishable trigger variant |
| `warning.wav` | F#5 ×3 | Repetition = urgency; single pitch = "clock ticking" |
| `danger.wav` | A3+Eb4, then A4+Eb5+E5 | Tritone dyad struck twice, second hit adds a minor-2nd rub: maximal dissonance for death touch / gate |
| `tell.wav` | E6, inharmonic partials (×2.32, ×4.25) | Soft glass ding — high, quiet, socially "polite" |
| `timer-end.wav` | B5 → E5 | Descending perfect fifth (dominant→tonic): resolved, "done" |
| `success.wav` | C5-E5-G5-C6 | Ascending major arpeggio: unambiguously positive |
| `death.wav` | C4 → A3 | Low descending minor third, slow decay: somber |
| `tick.wav` | 2 kHz, 40 ms | Minimal transient; tolerable at 1 Hz repetition |
| `gong.wav` | A2 + inharmonic partials (×1.48, ×2.09, ×2.76, ×3.51, ×4.72) | Deep struck metal for raid-scale events; inharmonicity is what makes it a gong and not an organ note |

**Editing.** Each sound is one small `s_*()` builder in
`generate_sounds.py`; pitches use note names via `note("A4")`. The `SOUNDS`
table at the bottom of the file maps filenames to builders and carries the
manifest metadata (label, description, intended use). Add a sound by writing
a builder and appending a row there — normalization, fades, manifest, and
verification are automatic.
