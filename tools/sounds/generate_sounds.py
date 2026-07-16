#!/usr/bin/env python3
"""Generate the EQLogs bundled alert-sound set.

Synthesizes clean UI alert sounds (44.1 kHz, 16-bit, mono WAV) using only the
Python standard library (wave + math + struct). Each sound is built from
layered sine partials with a fast attack and exponential decay, then the whole
mix is normalized to -3 dBFS peak.

Usage:
    python3 tools/sounds/generate_sounds.py            # generate + verify
    python3 tools/sounds/generate_sounds.py --verify   # verify existing files only

Outputs go to assets/sounds/ (relative to the repo root, which is inferred
from this file's location). Also writes assets/sounds/manifest.json.
"""

import json
import math
import os
import struct
import sys
import wave

SAMPLE_RATE = 44100
PEAK_DBFS = -3.0                      # default normalization target
PEAK_OVERRIDES_DBFS = {
    # Slay Undead can fire repeatedly in combat. Keep its sustained harmonic
    # cue comfortably below short UI transients so it feels expansive, not loud.
    "holy-strike.wav": -16.0,
}
ATTACK_S = 0.005                      # 5 ms fade-in on every event (anti-click)
TAIL_FADE_S = 0.010                   # 10 ms fade-out at end of file (anti-click)

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT_DIR = os.path.join(REPO_ROOT, "assets", "sounds")

# ---------------------------------------------------------------------------
# Note frequencies (equal temperament, A4 = 440 Hz)
# ---------------------------------------------------------------------------

def note(name: str) -> float:
    """Frequency of a note like 'A4', 'E5', 'F#3', 'Eb4'."""
    semitones = {"C": -9, "C#": -8, "Db": -8, "D": -7, "D#": -6, "Eb": -6,
                 "E": -5, "F": -4, "F#": -3, "Gb": -3, "G": -2, "G#": -1,
                 "Ab": -1, "A": 0, "A#": 1, "Bb": 1, "B": 2}
    pitch, octave = name[:-1], int(name[-1])
    n = semitones[pitch] + (octave - 4) * 12
    return 440.0 * (2.0 ** (n / 12.0))

# ---------------------------------------------------------------------------
# Synthesis primitives
# ---------------------------------------------------------------------------

# Default partial stack: fundamental + octave + twelfth (3rd harmonic) at
# decreasing gain. Enough body that tones don't sound like bare test tones.
CHIME_PARTIALS = [(1.0, 1.00), (2.0, 0.35), (3.0, 0.15)]
GLASS_PARTIALS = [(1.0, 1.00), (2.32, 0.30), (4.25, 0.12)]   # slightly inharmonic
SOFT_PARTIALS = [(1.0, 1.00), (2.0, 0.25)]

def add_tone(buf, start_s, freq, dur_s, decay_s, gain=1.0,
             partials=CHIME_PARTIALS, attack_s=ATTACK_S):
    """Mix one enveloped multi-partial tone into buf (list of floats).

    Envelope: linear attack over attack_s, then exponential decay with time
    constant decay_s. Each partial decays a bit faster than the fundamental
    (higher partials die first, as in struck/plucked instruments).
    """
    start = int(start_s * SAMPLE_RATE)
    n = int(dur_s * SAMPLE_RATE)
    need = start + n
    if need > len(buf):
        buf.extend([0.0] * (need - len(buf)))
    two_pi = 2.0 * math.pi
    for k, (mult, pgain) in enumerate(partials):
        f = freq * mult
        if f >= SAMPLE_RATE / 2.0:
            continue
        tau = decay_s / (1.0 + 0.6 * k)   # upper partials decay faster
        w = two_pi * f / SAMPLE_RATE
        for i in range(n):
            t = i / SAMPLE_RATE
            env = (t / attack_s) if t < attack_s else 1.0
            env *= math.exp(-t / tau)
            buf[start + i] += gain * pgain * env * math.sin(w * i)

def add_sweep(buf, start_s, hi_freq, lo_freq, dur_s, decay_s, gain=1.0):
    """Mix a glassy exponential pitch fall, used for descending spell light."""
    start = int(start_s * SAMPLE_RATE)
    n = int(dur_s * SAMPLE_RATE)
    need = start + n
    if need > len(buf):
        buf.extend([0.0] * (need - len(buf)))
    phase = 0.0
    ratio = lo_freq / hi_freq
    for i in range(n):
        t = i / SAMPLE_RATE
        progress = i / max(1, n - 1)
        freq = hi_freq * (ratio ** progress)
        phase += 2.0 * math.pi * freq / SAMPLE_RATE
        env = (t / ATTACK_S) if t < ATTACK_S else 1.0
        env *= math.exp(-t / decay_s)
        shimmer = math.sin(phase) + 0.28 * math.sin(phase * 2.01)
        buf[start + i] += gain * env * shimmer

def add_angelic_voice(buf, start_s, freq, dur_s, gain=1.0, phase_offset=0.0):
    """Mix one sparse, slowly swelling voice for the Slay Undead halo.

    Dense formant partials made the first choir attempt read as a horn. This
    voice is intentionally close to a sine wave: a soft fundamental, a trace
    of octave air, and independent low-rate movement.
    """
    start = int(start_s * SAMPLE_RATE)
    n = int(dur_s * SAMPLE_RATE)
    need = start + n
    if need > len(buf):
        buf.extend([0.0] * (need - len(buf)))

    phases = [phase_offset, phase_offset * 1.71]
    attack_s = 0.280
    release_s = 0.840
    release_start = max(attack_s, dur_s - release_s)
    two_pi = 2.0 * math.pi
    for i in range(n):
        t = i / SAMPLE_RATE
        if t < attack_s:
            env = 0.5 - 0.5 * math.cos(math.pi * t / attack_s)
        elif t < release_start:
            env = 1.0
        else:
            progress = (t - release_start) / max(0.001, release_s)
            env = 0.5 + 0.5 * math.cos(math.pi * min(1.0, progress))
        env *= 0.975 + 0.025 * math.sin(two_pi * 0.57 * t + phase_offset)

        vibrato = 1.0 + 0.00065 * math.sin(two_pi * 4.15 * t + phase_offset)
        phases[0] += two_pi * freq * vibrato / SAMPLE_RATE
        phases[1] += two_pi * freq * 2.0 * vibrato / SAMPLE_RATE
        sample = math.sin(phases[0]) + 0.035 * math.sin(phases[1])
        buf[start + i] += gain * env * sample

def add_breath(buf, start_s, dur_s, gain=0.012):
    """Add a deterministic, softly band-limited breath beneath the voices."""
    start = int(start_s * SAMPLE_RATE)
    n = int(dur_s * SAMPLE_RATE)
    need = start + n
    if need > len(buf):
        buf.extend([0.0] * (need - len(buf)))
    state = 0x51A7
    slow = 0.0
    fast = 0.0
    for i in range(n):
        state = (1664525 * state + 1013904223) & 0xFFFFFFFF
        white = ((state / 0xFFFFFFFF) * 2.0) - 1.0
        slow += 0.025 * (white - slow)
        fast += 0.110 * (white - fast)
        breath = fast - slow
        t = i / SAMPLE_RATE
        attack = min(1.0, t / 0.36)
        release = min(1.0, max(0.0, (dur_s - t) / 0.72))
        env = math.sin(math.pi * 0.5 * attack) * math.sin(math.pi * 0.5 * release)
        buf[start + i] += gain * env * breath

def add_halo(buf, delays=((0.117, 0.12), (0.231, 0.075), (0.373, 0.04))):
    """Add quiet, irregular reflections for a diffuse chapel-like tail."""
    dry = list(buf)
    for delay_s, gain in delays:
        delay = int(delay_s * SAMPLE_RATE)
        buf.extend([0.0] * max(0, len(dry) + delay - len(buf)))
        for i, sample in enumerate(dry):
            buf[i + delay] += sample * gain

def finalize(buf, peak_dbfs=PEAK_DBFS):
    """Tail fade-out, then normalize to the requested peak level."""
    nfade = int(TAIL_FADE_S * SAMPLE_RATE)
    total = len(buf)
    for i in range(max(0, total - nfade), total):
        buf[i] *= (total - 1 - i) / max(1, nfade - 1)
    peak = max(abs(s) for s in buf) or 1.0
    scale = (10.0 ** (peak_dbfs / 20.0)) / peak
    return [s * scale for s in buf]

def write_wav(path, samples):
    frames = b"".join(
        struct.pack("<h", max(-32767, min(32767, int(round(s * 32767.0)))))
        for s in samples
    )
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(frames)

# ---------------------------------------------------------------------------
# Sound definitions
# ---------------------------------------------------------------------------

def s_two_note_chime(lo, hi):
    """Ascending two-note chime a perfect fourth apart (alert / chime2 / chime3)."""
    buf = []
    add_tone(buf, 0.000, note(lo), 0.30, 0.10, gain=0.9)
    add_tone(buf, 0.120, note(hi), 0.32, 0.13, gain=1.0)
    return buf

def s_alert():
    return s_two_note_chime("E5", "A5")

def s_chime2():
    return s_two_note_chime("G5", "C6")

def s_chime3():
    return s_two_note_chime("C5", "F5")

def s_warning():
    """Three quick mid pips on F#5 — insistent but not harsh."""
    buf = []
    for i in range(3):
        add_tone(buf, i * 0.130, note("F#5"), 0.11, 0.045,
                 gain=1.0, partials=SOFT_PARTIALS, attack_s=0.003)
    return buf

def s_danger():
    """Urgent low-high dissonant double hit (tritone dyad A3+Eb4, struck twice)."""
    buf = []
    # Hit 1: low tritone dyad
    add_tone(buf, 0.000, note("A3"), 0.30, 0.12, gain=1.0)
    add_tone(buf, 0.000, note("Eb4"), 0.30, 0.10, gain=0.75)
    # Hit 2: same dyad an octave up with a minor-2nd rub, slightly longer ring
    add_tone(buf, 0.240, note("A4"), 0.36, 0.14, gain=1.0)
    add_tone(buf, 0.240, note("Eb5"), 0.36, 0.12, gain=0.70)
    add_tone(buf, 0.240, note("E5"), 0.36, 0.10, gain=0.35)  # minor 2nd vs Eb5
    return buf

def s_tell():
    """Soft single glass ding on E6, gentle inharmonic shimmer."""
    buf = []
    add_tone(buf, 0.0, note("E6"), 0.40, 0.15, gain=1.0, partials=GLASS_PARTIALS)
    return buf

def s_timer_end():
    """Resolved descending two-note: B5 -> E5 (perfect fifth down), a
    dominant-to-tonic fall that reads as 'finished'."""
    buf = []
    add_tone(buf, 0.000, note("B5"), 0.28, 0.10, gain=0.9)
    add_tone(buf, 0.140, note("E5"), 0.34, 0.15, gain=1.0)
    return buf

def s_success():
    """Bright ascending major triad arpeggio C5-E5-G5 topped with C6."""
    buf = []
    add_tone(buf, 0.000, note("C5"), 0.22, 0.09, gain=0.85)
    add_tone(buf, 0.095, note("E5"), 0.22, 0.09, gain=0.90)
    add_tone(buf, 0.190, note("G5"), 0.22, 0.10, gain=0.95)
    add_tone(buf, 0.285, note("C6"), 0.28, 0.14, gain=1.00)
    return buf

def s_death():
    """Low somber descending minor pair: C4 down a minor third to A3."""
    buf = []
    add_tone(buf, 0.000, note("C4"), 0.34, 0.16, gain=0.95, partials=SOFT_PARTIALS)
    add_tone(buf, 0.200, note("A3"), 0.40, 0.20, gain=1.00, partials=SOFT_PARTIALS)
    return buf

def s_tick():
    """Tiny 40 ms click for countdowns: high, dry, near-instant decay."""
    buf = []
    add_tone(buf, 0.0, 2000.0, 0.040, 0.010, gain=1.0,
             partials=[(1.0, 1.0), (2.0, 0.4)], attack_s=0.001)
    return buf

def s_gong():
    """Deep struck gong on A2 with inharmonic partials and a long-ish decay."""
    buf = []
    f0 = note("A2")   # 110 Hz
    gong_partials = [(1.0, 1.00), (1.48, 0.55), (2.09, 0.45),
                     (2.76, 0.30), (3.51, 0.18), (4.72, 0.10)]
    add_tone(buf, 0.0, f0, 0.60, 0.28, gain=1.0, partials=gong_partials)
    return buf

def s_holy_strike():
    """Very soft upper-register vocal halo with no percussive strike."""
    buf = []
    root = note("D5")
    # Open D6/9 voicing (D-A-B-E) avoids the declarative major third that made
    # the previous version sound brassy. The fifth carries the cue, while the
    # root remains deliberately understated.
    chord = ((1.00, 0.00, 0.20, 0.1),
             (1.50, 0.05, 0.34, 1.7),
             (5.0 / 3.0, 0.12, 0.27, 3.0),
             (2.25, 0.19, 0.12, 4.4))
    for ratio, start, gain, phase in chord:
        add_angelic_voice(buf, start, root * ratio, 1.46, gain, phase)
    add_breath(buf, 0.03, 1.52)
    add_halo(buf)
    return buf

SOUNDS = [
    # (filename, builder, label, description, intended_use)
    ("alert.wav", s_alert, "Alert",
     "Neutral two-note ascending chime (E5 to A5, perfect fourth).",
     "Default notification for generic triggers."),
    ("warning.wav", s_warning, "Warning",
     "Three quick mid pips on F#5.",
     "Timer approaching its end; pre-expiry warning."),
    ("danger.wav", s_danger, "Danger",
     "Urgent low-high dissonant double hit (tritone dyad with a minor-2nd rub).",
     "Urgent events: death touch, gate, emote warnings that demand action."),
    ("tell.wav", s_tell, "Tell",
     "Soft single glass ding on E6.",
     "Incoming tell / private message."),
    ("timer-end.wav", s_timer_end, "Timer end",
     "Resolved descending two-note (B5 to E5, perfect fifth down).",
     "A tracked timer or cooldown has completed."),
    ("success.wav", s_success, "Success",
     "Bright ascending C-major arpeggio (C5-E5-G5-C6).",
     "Positive events: level up, resurrection accepted, item looted."),
    ("death.wav", s_death, "Death",
     "Low somber descending minor pair (C4 to A3, minor third down).",
     "Player or group-member death."),
    ("tick.wav", s_tick, "Tick",
     "Tiny 40 ms countdown click.",
     "Per-second countdown ticks; designed to be unobtrusive when repeated."),
    ("gong.wav", s_gong, "Gong",
     "Deep struck gong on A2 with inharmonic partials and a long decay.",
     "Raid-scale events: enrage, boss spawn, raid-wide calls."),
    ("holy-strike.wav", s_holy_strike, "Holy strike",
     "Very quiet upper-register D6/9 vocal halo with a breathy, diffuse tail.",
     "Divine damage moments such as Slay Undead."),
    ("chime2.wav", s_chime2, "Chime 2",
     "Alternate ascending chime, higher pitch (G5 to C6).",
     "Alternate alert pitch so users can tell triggers apart by ear."),
    ("chime3.wav", s_chime3, "Chime 3",
     "Alternate ascending chime, lower pitch (C5 to F5).",
     "Alternate alert pitch so users can tell triggers apart by ear."),
]

# ---------------------------------------------------------------------------
# Verification
# ---------------------------------------------------------------------------

def verify(paths):
    """Re-read each WAV and check format, peak level, and first-sample click."""
    rows = []
    ok_all = True
    for path in paths:
        name = os.path.basename(path)
        with wave.open(path, "rb") as w:
            assert w.getnchannels() == 1 and w.getsampwidth() == 2
            sr = w.getframerate()
            nframes = w.getnframes()
            raw = w.readframes(nframes)
        samples = struct.unpack("<%dh" % nframes, raw)
        dur_ms = 1000.0 * nframes / sr
        peak = max(abs(s) for s in samples)
        peak_db = 20.0 * math.log10(peak / 32767.0) if peak else float("-inf")
        first = abs(samples[0]) / 32767.0
        expected_peak_db = PEAK_OVERRIDES_DBFS.get(name, PEAK_DBFS)
        ok = (sr == SAMPLE_RATE
              and abs(peak_db - expected_peak_db) <= 1.0
              and first < 0.01)          # no first-sample discontinuity
        ok_all &= ok
        rows.append((name, sr, dur_ms, peak, peak_db, first, "OK" if ok else "FAIL"))
    hdr = f"{'file':<14} {'rate':>6} {'dur_ms':>8} {'peak':>6} {'peak_dBFS':>10} {'s[0]':>8}  status"
    print(hdr)
    print("-" * len(hdr))
    for name, sr, dur, peak, db, first, status in rows:
        print(f"{name:<14} {sr:>6} {dur:>8.1f} {peak:>6} {db:>10.2f} {first:>8.5f}  {status}")
    return ok_all, rows

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    verify_only = "--verify" in sys.argv
    os.makedirs(OUT_DIR, exist_ok=True)
    paths = [os.path.join(OUT_DIR, f) for f, *_ in SOUNDS]

    if not verify_only:
        manifest = []
        for fname, builder, label, desc, use in SOUNDS:
            samples = finalize(builder(), PEAK_OVERRIDES_DBFS.get(fname, PEAK_DBFS))
            path = os.path.join(OUT_DIR, fname)
            write_wav(path, samples)
            manifest.append({
                "file": fname,
                "label": label,
                "description": desc,
                "duration_ms": round(1000.0 * len(samples) / SAMPLE_RATE),
                "intended_use": use,
            })
        with open(os.path.join(OUT_DIR, "manifest.json"), "w") as f:
            json.dump(manifest, f, indent=2)
            f.write("\n")
        print(f"Wrote {len(manifest)} sounds + manifest.json to {OUT_DIR}\n")

    ok, _ = verify(paths)
    if not ok:
        print("\nVERIFICATION FAILED", file=sys.stderr)
        sys.exit(1)
    print("\nAll files verified.")

if __name__ == "__main__":
    main()
