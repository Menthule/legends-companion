# Career database + log-history backfill — design (eqlogs-6yo)

Implementation contract for the per-character career persistence layer and
the "Import log history" backfill. Companion to `docs/architecture-0.2.md`;
implementation agents follow this doc exactly. Terminology: "log-domain
timestamp" = epoch seconds parsed from the log's naive-local bracketed time,
exactly as `eqlog_core::parser` produces today and exactly as
`fights.start_ts` already stores.

## Problem

Everything progression-related evaporates: loot is in-memory
(`lib/sessionLog.ts`, reset per app run), session history is 40 localStorage
rows in CoachTab, and `eqlog-store` holds only a `fights` table. Meanwhile
the user's log files hold months of replayable history — `catchup.rs`
already proved whole-log replay is safe and fast. This round adds durable
career tables to the ONE store DB (`fights.db`), an idempotent importer that
folds existing logs into them, and career views in the Session tab.

## Grounding measurements (fixtures/local/eqlog_full.txt)

84,672 lines spanning 17.2 h of wall time across two calendar days. Gap
distribution: exactly 3 gaps > 5 min — 6.2 h and 4.2 h (sleep/work) and one
27.4 min (a break mid-play). Event volumes over those 17.2 h: 441 XpGain,
8 LevelUp, 324 Loot, 524 Slain, 20 ZoneEnter. Extrapolated to 1,000 played
hours: ~26 k XP events, ~20 k loot rows, ~30 k kills — all trivial for
SQLite, but see §2 for why raw XP events still don't earn a table.

---

## 1. Schema — user_version 2 in the existing store DB

All career tables live in the same SQLite file as `fights`
(`data_root.fights_db()` → `fights.db`; any path via CLI `--db`). One
database = one migration history = one backup artifact. `SCHEMA_VERSION`
bumps 1 → 2; the new step is an `if found < 2 { … }` block in the existing
`migrate()` (which moves to a shared `schema.rs` module inside eqlog-store —
see §4 — so `FightStore` and `CareerStore` run the identical migration
regardless of which opens the file first). The `fights` table is untouched.

**Character scoping**: every career row carries `character TEXT NOT NULL`
and `server TEXT NOT NULL` (canonical case as parsed from the
`eqlog_<Character>_<server>.txt` filename or supplied explicitly; matching
is done with `COLLATE NOCASE` indexes, never by lowercasing stored values).
No characters lookup table — the house style is flat denormalized columns
with `(?N = '' OR col = ?N)` filter guards, not joins.

**All timestamps are log-domain** (naive-local-as-epoch-seconds, the
`fights.start_ts` convention). See §2 for the DST caveat.

```sql
-- One contiguous play block (see §3 for segmentation).
CREATE TABLE sessions (
    id              INTEGER PRIMARY KEY,
    character       TEXT    NOT NULL,
    server          TEXT    NOT NULL,
    start_ts        INTEGER NOT NULL,   -- log-domain
    end_ts          INTEGER NOT NULL,   -- log-domain
    duration_secs   INTEGER NOT NULL,   -- end_ts - start_ts (see DST caveat)
    zones_json      TEXT    NOT NULL,   -- JSON array, unique zones in entry order
    kills           INTEGER NOT NULL,   -- NPC Slain credited (victim != You, not player-shaped)
    deaths          INTEGER NOT NULL,   -- Slain victim == You
    xp_percent      REAL    NOT NULL,   -- sum of XpGain.percent (incl. party)
    party_xp_percent REAL   NOT NULL,   -- the party==true subset of the above
    level_ups       INTEGER NOT NULL,
    end_level       INTEGER,            -- highest LevelUp.level seen; NULL if none
    aa_points       INTEGER NOT NULL,
    coin_copper     INTEGER NOT NULL,   -- Money events + Loot.sold_for, in copper
    coin_json       TEXT    NOT NULL,   -- {"corpse":n,"vendor":n,"item":n,"soldLoot":n} copper
    skill_ups       INTEGER NOT NULL,
    loot_count      INTEGER NOT NULL,   -- rows in loot with this session_id
    source_file     TEXT    NOT NULL    -- path the import read (provenance)
);
CREATE INDEX sessions_char_start
    ON sessions (character COLLATE NOCASE, server COLLATE NOCASE, start_ts DESC);

-- Raw: rare (8 per 17 h) and each row is individually meaningful.
CREATE TABLE level_ups (
    id         INTEGER PRIMARY KEY,
    character  TEXT    NOT NULL,
    server     TEXT    NOT NULL,
    ts         INTEGER NOT NULL,        -- log-domain
    level      INTEGER NOT NULL,
    session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL
);
CREATE INDEX level_ups_char_ts
    ON level_ups (character COLLATE NOCASE, server COLLATE NOCASE, ts ASC);

-- Raw: the loot ledger and observed-drop counts need item + corpse per event.
CREATE TABLE loot (
    id              INTEGER PRIMARY KEY,
    character       TEXT    NOT NULL,
    server          TEXT    NOT NULL,
    ts              INTEGER NOT NULL,   -- log-domain
    item            TEXT    NOT NULL,
    quantity        INTEGER NOT NULL,
    corpse          TEXT,               -- mob name; NULL when the line had none
    looter          TEXT    NOT NULL,   -- character's name for You; raw name otherwise
    sold_for_copper INTEGER,            -- NULL = kept; 0 = "sold it for free"
    session_id      INTEGER REFERENCES sessions(id) ON DELETE SET NULL
);
CREATE INDEX loot_char_ts
    ON loot (character COLLATE NOCASE, server COLLATE NOCASE, ts DESC);
CREATE INDEX loot_char_item
    ON loot (character COLLATE NOCASE, server COLLATE NOCASE, item COLLATE NOCASE);

-- Per-session per-mob kill aggregates. Career per-mob counts = SUM(...) GROUP
-- BY mob; the session_id link keeps zone/time context for later features.
CREATE TABLE session_mob_kills (
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    character  TEXT    NOT NULL,
    server     TEXT    NOT NULL,
    mob        TEXT    NOT NULL,        -- raw victim name from the Slain line
    kills      INTEGER NOT NULL,
    PRIMARY KEY (session_id, mob)
);
CREATE INDEX smk_char_mob
    ON session_mob_kills (character COLLATE NOCASE, server COLLATE NOCASE,
                          mob COLLATE NOCASE);

-- Per-file resume state (§2). path is the absolute path as given.
CREATE TABLE import_files (
    id              INTEGER PRIMARY KEY,
    character       TEXT    NOT NULL,
    server          TEXT    NOT NULL,
    path            TEXT    NOT NULL,
    prefix_sha256   TEXT    NOT NULL,   -- hash of the first prefix_len bytes
    prefix_len      INTEGER NOT NULL,   -- min(65536, byte_offset)
    byte_offset     INTEGER NOT NULL,   -- offset AFTER the last fully-parsed line
    line_count      INTEGER NOT NULL,
    last_ts         INTEGER NOT NULL,   -- log-domain ts of the last parsed line
    last_session_id INTEGER,            -- trailing session, reopenable on resume
    imported_at     INTEGER NOT NULL,   -- true-UTC epoch (bookkeeping only)
    UNIQUE (character, server, path)
);

-- Per-character monotonic time floor (§2): cross-file double-count guard.
CREATE TABLE career_watermarks (
    character TEXT NOT NULL,
    server    TEXT NOT NULL,
    max_ts    INTEGER NOT NULL,         -- log-domain
    PRIMARY KEY (character, server)
);
```

### Why NO raw `xp_events` table

Enumerate the consumers: **level timeline** reads `level_ups` (raw, rare).
**Career trends** (`lib/trends.ts`) consumes per-session rates — sessions
aggregates. **Observed drop rates** = `loot` grouped by corpse ÷
`session_mob_kills` summed by mob. **Loot ledger** reads `loot`.
**Per-mob kill counts** read `session_mob_kills`. **Live XP/hour** stays in
the in-memory session store (`lib/sessionLog.ts`) — the career DB is not a
live surface. No consumer needs an individual historical XP gain, so per
YAGNI it gets no table; `sessions.xp_percent`/`party_xp_percent` carry the
sums. If a within-session XP curve is ever wanted, a raw table is an
additive `user_version` 3 migration plus a re-import — the watermark design
(§2) makes "wipe career tables and re-import" a supported, cheap operation.

Deaths likewise stay an aggregate (`sessions.deaths`): death *recaps* need
the surrounding line window, which is a live-only feature by design.

---

## 2. Idempotent import: watermarks, truncation, timestamps

**Invariant: no career row is ever written twice for the same log content,
no matter how many times import runs or how the file has grown.** Two
mechanisms, layered:

### Layer 1 — per-file byte watermark (`import_files`)

The only entry point into career writes is the importer, and the importer
always starts from the watermark:

1. Look up `(character, server, path)` in `import_files`.
2. **No row** → fresh import from byte 0.
3. **Row exists** → verify identity: file length ≥ `byte_offset` AND
   sha256 of the file's first `prefix_len` bytes equals `prefix_sha256`.
   - **Match** → seek to `byte_offset`, parse only the new bytes. Byte-exact
     resume means no line is ever parsed twice → no row-level dedupe needed.
   - **Mismatch** (file shrank, or prefix differs — truncation, rotation, or
     replacement) → this is a *different stream*: reset to byte 0 and fall
     through to Layer 2.
4. On completion, write rows + updated watermark (`byte_offset` = offset
   after the last complete line — a trailing partial line is NOT consumed;
   it re-parses next run once complete) in **one transaction per file**. A
   crashed or interrupted import leaves the previous watermark intact and
   the next run redoes only the uncommitted work.

**Trailing-session reopen**: `import_files.last_session_id` names the
session that was still "open" at EOF. On resume, if the first new event's
`ts − sessions.end_ts ≤ gap threshold`, the importer extends that row
(UPDATE aggregates, extend `end_ts`, upsert `session_mob_kills`) instead of
creating a phantom session split at the old EOF. Otherwise the trailing
session is final and a new one begins. This is what makes re-running import
weekly produce the same sessions as one run at the end of the month.

### Layer 2 — per-character time floor (`career_watermarks`)

`max_ts` is the newest log-domain timestamp ever folded for this
character+server, across all files. Whenever Layer 1 restarts from byte 0
(fresh path, or identity mismatch), every line with `ts ≤ max_ts` is
**parsed but not folded** (skipped, counted in the report as
`linesSkipped`). This makes these safe:

- User deleted the log; game created a fresh one → new timestamps are
  `> max_ts`, import proceeds.
- User points import at an archived copy (`eqlog_Nyasha_oggok_may.txt`)
  whose content overlaps the already-imported live file → the overlap is
  skipped; only genuinely-older-than-everything or newer content would fold.
  (Corollary: import archives **oldest first** — the report warns when a
  file was entirely skipped by the floor.)
- Restoring an old backup over the live log → all old content skipped.

Honest limitation: content strictly *older* than `max_ts` that was never
imported (an archive discovered late) is refused by the floor. The report
says so explicitly (`skipReason: "older than existing career data"`), and
the documented remedy is **Reset career data** (delete this character's
career rows + watermarks, re-import everything oldest-first). That reset is
a supported CLI/app operation, not a dev-only hack.

### Timestamp domain and the DST caveat

Career tables store **log-domain** timestamps: the log's naive-local time
interpreted as UTC epoch seconds, exactly like `fights.start_ts`
(`parser.rs` month-lookup + days-from-civil math). Frontend converts at
display time only (existing convention; do NOT "fix" to true UTC — mixing
domains is the app's known trap, see the timestamp-domain memory).

DST caveat, documented honestly: naive local time is discontinuous. On
fall-back the same hour repeats — a session spanning it computes up to 1 h
too *short* and the gap detector may see time stand still; on spring-forward
an hour vanishes — durations up to 1 h too *long*, and a >30 min apparent
gap can split one real session in two. This corrupts at most two sessions
per year by ±1 h and cannot double-count events (the byte watermark, not
time, is the dedupe authority; the Layer-2 floor uses `≤`, so a fall-back
replayed hour in a *new* stream would be skipped — acceptable, rare, and
logged). We accept this; no timezone database in the workspace.

---

## 3. Session segmentation

Rule (matches the measured gap distribution — 6.2 h / 4.2 h / 27 min):

- A session **starts** at the first parsed line (any event, including
  `Unclassified` — presence in the log is presence at the keyboard).
- A gap of **more than 30 minutes** (default; CLI `--gap-mins`, app
  `careerGapMins` in settings.json — 0/absent = default; no Settings UI
  yet, "everything configurable") between consecutive line timestamps **ends**
  the session at the pre-gap line and starts a new one at the post-gap
  line. 30 min keeps the observed 27.4 min mid-day break inside one session
  (it was one play block) while cleanly splitting the sleep/work gaps. Note
  CoachTab's live "smart session" default (15 min) is a different, live-UX
  concept and stays untouched.
- EOF ends the trailing session (reopenable on resume, §2).
- **Minimum session**: a segment with `duration_secs < 60` AND zero
  kills/deaths/xp/level-ups/loot/coin/skill-ups is discarded (login-check
  blips). Anything with real activity is kept regardless of length;
  `lib/trends.ts` already drops sub-minute rows from charts.

Per-session aggregates: exactly the `sessions` columns in §1 — duration,
ordered-unique zone list (`ZoneEnter`), kills (NPC `Slain` with a named
victim that is not player-shaped — reuse `sessionLog.ts`'s
`/^[A-Z][a-z]+$/` groupmate heuristic, and count kills regardless of
killer so camp counts survive group play), deaths (`Slain` victim You),
xp%/party-xp% (`XpGain`), level-ups + end_level (`LevelUp`), AA points
(`AaPointGain`), coin in copper with a per-`MoneyKind`+sold-loot breakdown
(`Money` + `Loot.sold_for`), skill-up count (`SkillUp`), loot count.

---

## 4. Module placement: `career` inside eqlog-store

The replay→career fold lives in **`eqlog-store`** as a `career` module, so
the CLI and the Tauri app share ONE writer implementation:

```
crates/eqlog-store/src/
  lib.rs      — FightStore (unchanged API), re-exports `pub mod career`
  schema.rs   — SCHEMA_VERSION=2 + migrate() (moved out of lib.rs; both
                stores call it; behavior for v-future/v0/v1 unchanged)
  career.rs   — CareerStore: open()/open_in_memory(), query API (§6 shapes)
  import.rs   — the importer: file IO, Parser replay, segmentation fold,
                watermark protocol, progress callback
```

Dependency direction is already correct: eqlog-store depends on eqlog-core
(it uses `FightSummary` today; the importer adds `eqlog_core::parser::Parser`
and `eqlog_core::events::{Event, ParsedLine}`). No new crate edges; the app
and CLI both already depend on eqlog-store. `CareerStore` wraps its own
`Connection` (same WAL/NORMAL pragmas, same `FutureSchema` hard-error), and
opening either store on the same file runs the same `schema::migrate`.

Core API (exact signatures for implementers):

```rust
pub struct CareerStore { /* Connection */ }

pub struct ImportOptions {
    pub character: Option<String>, // None => parse from filename; error if neither
    pub server: Option<String>,    // None => parse from filename; "" allowed
    pub gap_secs: i64,             // default 1800
    pub dry_run: bool,
}

pub struct ImportProgress {
    pub file: String,
    pub bytes_read: u64,
    pub bytes_total: u64,
    pub lines_read: u64,
    pub sessions_found: u64,
}

pub struct ImportReport {
    pub file: String,
    pub character: String,
    pub server: String,
    pub lines_read: u64,
    pub lines_skipped: u64,        // Layer-2 floor skips
    pub sessions_added: u64,
    pub sessions_updated: u64,     // trailing-session reopen
    pub level_ups_added: u64,
    pub loot_added: u64,
    pub kills_added: u64,
    pub skipped: bool,             // whole file was a no-op
    pub skip_reason: Option<String>,
}

impl CareerStore {
    pub fn open(path: impl AsRef<Path>) -> Result<CareerStore, StoreError>;
    pub fn open_in_memory() -> Result<CareerStore, StoreError>;

    /// Import one log file (watermark-resumed, transactional). `progress`
    /// is called at most ~every 64 KiB read. Not cancellable in v1.
    pub fn import_file(
        &mut self,
        path: &Path,
        opts: &ImportOptions,
        progress: &mut dyn FnMut(&ImportProgress),
    ) -> Result<ImportReport, StoreError>;

    /// Delete every career row + watermark for one character (Reset).
    pub fn reset_character(&mut self, character: &str, server: &str)
        -> Result<u64, StoreError>;

    // Queries — shapes mirror §6 exactly; all filters use the
    // (?N = '' OR col = ?N COLLATE NOCASE) guard style from refdb.rs.
    pub fn summary(&self, character: &str, server: &str)
        -> Result<Option<CareerSummary>, StoreError>;
    pub fn sessions(&self, character: &str, server: &str, limit: u32, offset: u32)
        -> Result<(u64, Vec<CareerSession>), StoreError>;
    pub fn level_timeline(&self, character: &str, server: &str)
        -> Result<Vec<CareerLevelUp>, StoreError>;
    pub fn loot(&self, character: &str, server: &str, search: &str,
                limit: u32, offset: u32)
        -> Result<(u64, Vec<CareerLootRow>), StoreError>;
    pub fn mob_kills(&self, character: &str, server: &str, search: &str,
                     limit: u32, offset: u32)
        -> Result<(u64, Vec<CareerMobKills>), StoreError>;
    pub fn mob_drops(&self, character: &str, server: &str, mob: &str)
        -> Result<Vec<CareerMobDrop>, StoreError>;
}
```

`loot`/`mob_kills` `search` matches with `LIKE '%'||?N||'%' COLLATE NOCASE`;
empty string = no filter (guarded, fixed-parameter discipline).
`mob_kills.lootDrops`/`distinctItems` come from a LEFT JOIN of `loot` on
`corpse = mob COLLATE NOCASE`; `mob_drops` is the same join grouped by item.
These are **observed drop counts** (per-mob loot events seen ÷ kills is the
UI's business to present as "N drops in M kills" — never a percentage
implying a true rate; the character only sees loot they were present for).

---

## 5. CLI (WSL-testable end to end)

New `career` subcommand family in eqlog-cli (`cmd_career.rs`, registered in
`main.rs` + USAGE):

```
eqlog career import <logfile>... [--db PATH] [--character NAME] [--server NAME]
                    [--gap-mins N] [--dry-run] [--json]
    Fold one or more EQ log files into the career database. Character and
    server default to the eqlog_<Character>_<server>.txt filename; --character/
    --server override (required for non-canonical filenames). Idempotent:
    re-running only imports bytes appended since the last run. Import
    multiple/archived files OLDEST FIRST. --dry-run parses and segments but
    writes nothing. --db defaults to ./fights.sqlite. Prints one ImportReport
    per file (--json: NDJSON).

eqlog career stats [--db PATH] [--character NAME] [--server NAME]
                   [--sessions N] [--json]
    Print the career summary and the last N sessions (default 10) for one
    character (default: the only character in the DB; error if ambiguous).

eqlog career reset --character NAME [--server NAME] [--db PATH] [--yes]
    Delete all career rows + import watermarks for one character. Prompts
    unless --yes.
```

Arg parsing follows the existing hand-rolled `cmd_fights.rs` style (no clap).
Validation loop for the implementers:
`cargo run -p eqlog-cli -- career import fixtures/local/eqlog_full.txt --db /tmp/career.sqlite`
must yield **3 sessions** (the 27.4 min gap merges; 6.2 h and 4.2 h split),
441 XP events summed into `xp_percent`, 8 level-ups, 324 loot rows, and a
second identical run must report `skipped: true` with zero rows added.

---

## 6. Wire contract — frontend `api.ts` (verbatim)

All career queries are implicitly scoped to the **active character/server
from AppConfig** (backend reads its own config; frontend never passes the
name — same trust boundary as `get_profile`). All `ts` fields are
**log-domain epoch seconds**: convert with the same helpers used for fight
history rows, never `Date.now()` arithmetic.

```ts
// ---- types.ts additions ----

export interface CareerSummary {
  character: string;
  server: string;
  sessions: number;
  totalDurationSecs: number;
  firstTs: number | null;      // log-domain; null when sessions == 0
  lastTs: number | null;
  kills: number;
  deaths: number;
  xpPercent: number;           // lifetime observed sum
  levelUps: number;
  endLevel: number | null;     // highest level ever observed
  coinCopper: number;
  lootCount: number;
  skillUps: number;
  aaPoints: number;
  lastImportAt: number | null; // TRUE-UTC epoch secs (bookkeeping), null = never
}

export interface CareerSession {
  id: number;
  startTs: number;             // log-domain
  endTs: number;
  durationSecs: number;
  zones: string[];
  kills: number;
  deaths: number;
  xpPercent: number;
  partyXpPercent: number;
  levelUps: number;
  endLevel: number | null;
  aaPoints: number;
  coinCopper: number;
  skillUps: number;
  lootCount: number;
  sourceFile: string;
}

export interface CareerLevelUp {
  id: number;
  ts: number;                  // log-domain
  level: number;
  sessionId: number | null;
}

export interface CareerLootRow {
  id: number;
  ts: number;                  // log-domain
  item: string;
  quantity: number;
  corpse: string | null;
  looter: string;
  soldForCopper: number | null; // null = kept, 0 = "sold for free"
  sessionId: number | null;
}

export interface CareerMobKills {
  mob: string;
  kills: number;
  lootDrops: number;           // loot events whose corpse == mob
  distinctItems: number;
  lastTs: number;              // log-domain, most recent kill session end
}

export interface CareerMobDrop {
  item: string;
  count: number;               // observed drops of this item off this mob
}

export interface CareerImportProgress {
  file: string;
  percent: number;             // 0..100 (bytes_read / bytes_total)
  linesRead: number;
  sessionsFound: number;
  done: boolean;               // true exactly once per file
  error: string | null;        // non-null => this file failed; run continues
}

export interface CareerImportReport {
  file: string;
  character: string;
  server: string;
  linesRead: number;
  linesSkipped: number;
  sessionsAdded: number;
  sessionsUpdated: number;
  levelUpsAdded: number;
  lootAdded: number;
  killsAdded: number;
  skipped: boolean;
  skipReason: string | null;
}

// ---- api.ts additions (IS_MOCK: return the canned shapes from mock.ts) ----

/** Import log history into the career DB. Empty/omitted paths = the active
 *  configured log file. Emits "career-import-progress" events while running;
 *  resolves with one report per file. Rejects only on DB-open failure. */
export async function careerImport(paths?: string[]): Promise<CareerImportReport[]> {
  return invoke<CareerImportReport[]>("career_import", { paths: paths ?? [] });
}

/** Career summary for the active character; null = no career data yet. */
export async function careerSummary(): Promise<CareerSummary | null> {
  return invoke<CareerSummary | null>("career_summary").catch(() => null);
}

export async function careerSessions(
  limit: number,
  offset: number,
): Promise<{ total: number; rows: CareerSession[] }> {
  return invoke("career_sessions", { limit, offset });
}

/** Every level-up, ascending ts (level timeline chart). */
export async function careerLevelTimeline(): Promise<CareerLevelUp[]> {
  return invoke<CareerLevelUp[]>("career_level_timeline").catch(() => []);
}

/** Paged loot ledger; search filters item substring, "" = all. */
export async function careerLoot(
  search: string,
  limit: number,
  offset: number,
): Promise<{ total: number; rows: CareerLootRow[] }> {
  return invoke("career_loot", { search, limit, offset });
}

/** Paged per-mob kill counts + observed drop counts; search "" = all. */
export async function careerMobKills(
  search: string,
  limit: number,
  offset: number,
): Promise<{ total: number; rows: CareerMobKills[] }> {
  return invoke("career_mob_kills", { search, limit, offset });
}

/** Observed drops off one mob, most-seen first. */
export async function careerMobDrops(mob: string): Promise<CareerMobDrop[]> {
  return invoke<CareerMobDrop[]>("career_mob_drops", { mob }).catch(() => []);
}

/** Delete all career data + import watermarks for the active character.
 *  Destructive; caller confirms first (confirmDiscard pattern). */
export async function careerReset(): Promise<void> {
  return invoke("career_reset");
}
```

Event: **`career-import-progress`** with `CareerImportProgress` payloads,
kebab-case like `log-line`/`catch-up`. Mock mode replays a short canned
progress sequence then resolves canned reports.

As built, `api.ts` additionally exposes `onCareerChanged(cb)`: a same-window
notifier fired after `careerImport`/`careerReset` resolve, so career views
(Session-tab panels, CoachTab pill counts) refresh without polling.
Cross-window refresh rides the final `done` progress event. A file that
fails mid-run still yields one report (`skipped: true`, `skipReason` =
the error) plus one `done: true, error != null` progress event.

---

## 7. Tauri surface + UI placement

**Commands** (async, registered in `lib.rs`; new `career.rs` module in
`app/src-tauri/src` following `store.rs`'s wiring style):

| Command | Args | Returns |
| --- | --- | --- |
| `career_import` | `paths: Vec<String>` (empty = configured log) | `Vec<CareerImportReport>` |
| `career_summary` | — | `Option<CareerSummary>` |
| `career_sessions` | `limit: u32, offset: u32` | `{ total, rows }` |
| `career_level_timeline` | — | `Vec<CareerLevelUp>` |
| `career_loot` | `search: String, limit: u32, offset: u32` | `{ total, rows }` |
| `career_mob_kills` | `search: String, limit: u32, offset: u32` | `{ total, rows }` |
| `career_mob_drops` | `mob: String` | `Vec<CareerMobDrop>` |
| `career_reset` | — | `()` |

`career_import` runs the blocking import on `spawn_blocking` (or a plain
thread), forwards `ImportProgress` callbacks as `career-import-progress`
emissions (throttled to ≥100 ms apart), and resolves with the reports. A
concurrent second `career_import` call returns an error ("import already
running") — one importer at a time, guarded by an `AtomicBool` in AppState.
The import holds the store mutex for its whole run, so the other seven
commands are declared `#[tauri::command(async)]`: they wait for the lock on
a worker thread, never on the main thread (a plain sync command would
freeze the webview for the duration of a first full-history import).
`CareerStore` lives in AppState as `Arc<Mutex<Option<CareerStore>>>`, opened
against `data_root.fights_db()` exactly like `store::open` — `None` on
failure disables career features without blocking anything else.

**Automatic freshness**: when a tail session starts (`start_tailing`), the
backend kicks the same `career_import` path for the configured log file
(fire-and-forget thread, progress events suppressed unless the UI asked).
Because of the watermark this reads only bytes appended since the last
import — normally milliseconds. See §8 for why live-tail does NOT write
career tables.

**UI placement**:

- **Settings → General → "Fights & history"** section gains a "Career
  history" block: an "Import log history" button (runs `careerImport()`,
  renders a progress bar off `career-import-progress`, toasts the report
  totals), a "last imported" line from `CareerSummary.lastImportAt`, and a
  "Reset career data…" destructive action (confirm dialog) calling
  `careerReset()`.
- **Session tab (CoachTab, id "coach")**: two new entries in
  `SessionPanelId` / `SESSION_PANELS` (`components/SessionPanels.tsx`):
  - `{ id: "career", label: "Career" }` — summary stat tiles
    (tabular-nums, `StatTile`), the level timeline (inline SVG, accent hue,
    `sparklineLayout` conventions), and a paged career-sessions table
    (`Pager`). Empty state: `Empty` with an action that deep-links to the
    Settings import block.
  - `{ id: "ledger", label: "Loot ledger" }` — searchable paged loot ledger
    plus the per-mob kills table; clicking a mob expands its observed drops
    ("12× Rusty Warhammer in 87 kills" — counts, never rate percentages).
  Both are read-on-mount + refresh after an import completes (listen for the
  final `done` progress event); they do NOT poll.

---

## 8. Single writer principle + explicit non-goals

**Writer policy (v1): import-on-demand + import-at-tail-start. Live tailing
never writes career tables.** Rationale: a live writer needs
session-in-progress rows, catch-up-replay suppression, and would race the
importer — three hard problems for zero user-visible benefit, since the
in-memory session store already serves everything live and the tail-start
import makes career data fresh as of every session start. One code path,
one writer, idempotent by construction. Live career writing can be revisited
once the import path has soaked.

**Non-goals this round** (each is a later issue, not scope creep here):

- Wishlist ETA math ("~N hours to your drop") — needs drop-rate confidence
  modeling; this round only persists the observed counts it will consume.
- Zone/camp recommender over career data.
- Live-tail career writing (above).
- True drop-*rate* percentages vs refdb expected rates — observed counts
  only, honestly labeled.
- Career retention/pruning UI (fights retention stays fights-only; career
  data is small — see grounding numbers).
- Faction and skill *career* tables — both already persist per-character
  (localStorage all-time ledgers); migrating them into the store DB is a
  separate consolidation round.
- Backfilling the `fights` table from history (fights remain live-written;
  replaying months of fights would need its own dedupe design).
- Cross-character roster/comparison views; CSV export; import cancellation.
