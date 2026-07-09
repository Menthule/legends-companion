import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  checkUpdate,
  dataUpdateCheck,
  dataUpdateInstall,
  dataVersion,
  getConfig,
  getLogStats,
  installUpdate,
  listTtsVoices,
  speakText,
  getProfile,
  getTriggers,
  getTriggerTree,
  onTriggersChanged,
  overlayHide,
  overlaySetClickThrough,
  overlayShow,
  setConfig,
  setProfile,
  switchLoadout,
  type UpdateInfo,
} from "../api";
import {
  loadCampRaresOnly,
  saveCampRaresOnly,
} from "../lib/timers";
import { ShareDialog, type ShareRequest } from "./ShareDialogs";
import { useTauriEvent } from "../hooks";
import { IS_MOCK } from "../mock";
import {
  loadAlertSizePx,
  loadBuffThresholdMins,
  loadMeterOtherSources,
  loadMeterSources,
  loadOverlayVisibility,
  OVERLAY_VIS_EVENT,
  OVERLAY_VIS_KEY,
  saveAlertSizePx,
  saveBuffThresholdMins,
  saveMeterOtherSources,
  saveMeterSources,
  saveOverlayArrange,
  saveOverlayVisibility,
} from "../overlayState";
import { effectiveEnabledInLoadout } from "../resolution";
import { getTheme, setTheme, type Theme } from "../theme";
import {
  CLASS_NAMES,
  DEFAULT_LOG_DIR,
  OVERLAY_ALERTS,
  OVERLAY_BUFFS,
  OVERLAY_ONOTHERS,
  OVERLAY_LABELS,
  OVERLAY_METER,
  OVERLAY_RESPAWN,
  OVERLAY_STANCE,
  OVERLAY_TARGET,
  OVERLAY_XP,
  displayPath,
  type AppConfig,
  type CharacterProfile,
  type DataUpdateInfo,
  type Loadout,
  type Trigger,
  type TriggerTreeEntry,
} from "../types";

/** Warn above this size: EQ's own log writer slows as the file grows. */
const LARGE_LOG_BYTES = 500 * 1024 * 1024;

/** Shipped app version (mirror of app/package.json "version"; the same
 *  const lives in Dashboard.tsx for the sidebar footer). */
const APP_VERSION = __APP_VERSION__;

/** Human-readable byte size, e.g. "1.2 GB" / "512.0 MB" / "947 B". */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

export default function SettingsTab({
  onCharacterChange,
}: {
  onCharacterChange?: (name: string) => void;
}) {
  const [config, setConfigState] = useState<AppConfig | null>(null);
  const [logSize, setLogSize] = useState<number | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [theme, setThemeState] = useState<Theme>(getTheme());
  const [unlocked, setUnlocked] = useState(false);
  const [shown, setShown] = useState<Record<string, boolean>>(() =>
    loadOverlayVisibility()
  );
  const [meterSources, setMeterSources] = useState<boolean>(() =>
    loadMeterSources()
  );
  const [meterOtherSources, setMeterOtherSources] = useState<number>(() =>
    loadMeterOtherSources()
  );
  const [campRaresOnly, setCampRaresOnly] = useState<boolean>(() =>
    loadCampRaresOnly()
  );
  const [buffThreshold, setBuffThreshold] = useState<number>(() =>
    loadBuffThresholdMins()
  );
  const [alertSize, setAlertSize] = useState<number>(() => loadAlertSizePx());
  const [voices, setVoices] = useState<string[]>([]);
  useEffect(() => {
    listTtsVoices().then(setVoices).catch(() => {});
  }, []);
  const [profile, setProfileState] = useState<CharacterProfile | null>(null);
  const [entries, setEntries] = useState<TriggerTreeEntry[] | null>(null);
  const [userTriggers, setUserTriggers] = useState<Trigger[]>([]);
  const [share, setShare] = useState<ShareRequest | null>(null);
  // Settings grew past one screen: sectioned sub-tabs, last one remembered.
  const [section, setSectionState] = useState<string>(() => {
    try {
      return localStorage.getItem("eqlogs.settings.section") ?? "general";
    } catch {
      return "general";
    }
  });
  function setSection(id: string) {
    setSectionState(id);
    try {
      localStorage.setItem("eqlogs.settings.section", id);
    } catch {
      // localStorage unavailable — selection just won't persist.
    }
  }
  const [renaming, setRenaming] = useState<{ from: string; text: string } | null>(
    null,
  );

  // ---- Updates section state (app channel + reference-data channel) ----
  const [appUpdate, setAppUpdate] = useState<UpdateInfo | null>(null);
  const [appUpdateStatus, setAppUpdateStatus] = useState<string | null>(null);
  const [appUpdateBusy, setAppUpdateBusy] = useState(false);
  const [dataCurrent, setDataCurrent] = useState<string | null>(null);
  const [dataInfo, setDataInfo] = useState<DataUpdateInfo | null>(null);
  const [dataStatus, setDataStatus] = useState<string | null>(null);
  const [dataBusy, setDataBusy] = useState(false);
  useEffect(() => {
    dataVersion().then(setDataCurrent).catch(() => {});
  }, []);

  /** App channel: checkUpdate() never rejects (errors resolve null), so a
   *  quiet "up to date" doubles as the offline/dev-build answer. */
  async function checkAppUpdate() {
    setAppUpdateBusy(true);
    setAppUpdateStatus(null);
    const u = await checkUpdate();
    setAppUpdate(u);
    setAppUpdateBusy(false);
    setAppUpdateStatus(
      u
        ? `Version ${u.version} is available.`
        : `You're up to date (v${APP_VERSION}).`,
    );
  }

  /** The backend relaunches the app on success, so this promise typically
   *  never resolves; a failure re-enables the buttons with the error. */
  async function installAppUpdate() {
    setAppUpdateBusy(true);
    setAppUpdateStatus("Downloading and installing…");
    try {
      await installUpdate();
    } catch (e) {
      setAppUpdateBusy(false);
      setAppUpdateStatus(`Update failed: ${String(e)}`);
    }
  }

  async function checkDataUpdate() {
    setDataBusy(true);
    setDataStatus(null);
    setDataInfo(null);
    try {
      const info = await dataUpdateCheck();
      setDataInfo(info);
      setDataCurrent(info.current);
      setDataStatus(
        info.updateAvailable
          ? `Data version ${info.latest} is available.`
          : `Reference data is up to date (${info.latest}).`,
      );
    } catch (e) {
      setDataStatus(`Check failed: ${String(e)}`);
    } finally {
      setDataBusy(false);
    }
  }

  async function installDataUpdate() {
    setDataBusy(true);
    setDataStatus("Downloading and installing data…");
    try {
      const v = await dataUpdateInstall();
      setDataCurrent(v);
      setDataInfo(null);
      setDataStatus(`Reference data updated to ${v}.`);
    } catch (e) {
      setDataStatus(`Data update failed: ${String(e)}`);
    } finally {
      setDataBusy(false);
    }
  }

  const refreshLogStats = () =>
    getLogStats().then((s) => setLogSize(s.sizeBytes));

  useEffect(() => {
    getConfig()
      .then(setConfigState)
      .catch((e) => setError(String(e)));
    void refreshLogStats();
    const refresh = () => {
      getProfile()
        .then(setProfileState)
        .catch(() => setProfileState(null));
      getTriggerTree()
        .then(setEntries)
        .catch(() => setEntries(null));
      getTriggers()
        .then(setUserTriggers)
        .catch(() => setUserTriggers([]));
    };
    refresh();
    // Trigger/profile saves elsewhere (Triggers tab, topbar switcher) keep
    // the loadout list and its on-counts current.
    return onTriggersChanged(refresh);
  }, []);

  useTauriEvent<CharacterProfile>("profile-changed", setProfileState);

  // Keep the overlay checkboxes in sync when an overlay is toggled from its
  // own edit chrome (in-arrange). Cross-window via "storage", same-window via
  // OVERLAY_VIS_EVENT.
  useEffect(() => {
    const sync = () => setShown(loadOverlayVisibility());
    const onStorage = (e: StorageEvent) => {
      if (e.key === OVERLAY_VIS_KEY) sync();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener(OVERLAY_VIS_EVENT, sync);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(OVERLAY_VIS_EVENT, sync);
    };
  }, []);

  async function save(next: AppConfig) {
    setConfigState(next);
    setError(null);
    try {
      await setConfig(next);
      void refreshLogStats(); // a new log path changes the reported size
      onCharacterChange?.(next.characterName);
      setStatus(
        "Settings saved. Log-file changes apply the next time tailing starts.",
      );
    } catch (e) {
      setError(String(e));
    }
  }

  // ---- loadouts ----

  async function saveProfile(next: CharacterProfile, note: string) {
    setProfileState(next); // optimistic; refresh follows via the listener
    setError(null);
    try {
      await setProfile(next);
      setStatus(note);
    } catch (e) {
      setError(String(e));
    }
  }

  /** Case-insensitive name uniqueness within the profile's loadouts. */
  function nameTaken(p: CharacterProfile, name: string, except?: string) {
    const n = name.toLowerCase();
    return p.loadouts.some(
      (l) => l.name.toLowerCase() === n && l.name !== except,
    );
  }

  function uniqueName(p: CharacterProfile, base: string): string {
    if (!nameTaken(p, base)) return base;
    for (let i = 2; ; i++) {
      const candidate = `${base} ${i}`;
      if (!nameTaken(p, candidate)) return candidate;
    }
  }

  function addLoadout() {
    if (!profile) return;
    const name = uniqueName(profile, `Loadout ${profile.loadouts.length + 1}`);
    const next: CharacterProfile = {
      ...profile,
      loadouts: [...profile.loadouts, { name, classes: [], overrides: {} }],
    };
    void saveProfile(next, `Created loadout “${name}”.`);
  }

  function duplicateLoadout(l: Loadout) {
    if (!profile) return;
    const name = uniqueName(profile, `${l.name} copy`);
    const copy: Loadout = {
      name,
      classes: [...l.classes],
      overrides: { ...l.overrides },
    };
    void saveProfile(
      { ...profile, loadouts: [...profile.loadouts, copy] },
      `Duplicated “${l.name}” as “${name}”.`,
    );
  }

  function commitRename() {
    if (!profile || !renaming) return;
    const name = renaming.text.trim();
    setRenaming(null);
    if (!name || name === renaming.from) return;
    if (nameTaken(profile, name, renaming.from)) {
      setError(`A loadout named “${name}” already exists.`);
      return;
    }
    const next: CharacterProfile = {
      ...profile,
      active_loadout:
        profile.active_loadout === renaming.from ? name : profile.active_loadout,
      loadouts: profile.loadouts.map((l) =>
        l.name === renaming.from ? { ...l, name } : l,
      ),
    };
    void saveProfile(next, `Renamed “${renaming.from}” to “${name}”.`);
  }

  function deleteLoadout(l: Loadout) {
    if (!profile) return;
    // Guards mirror the disabled state (last loadout / active loadout).
    if (profile.loadouts.length <= 1 || l.name === profile.active_loadout) {
      return;
    }
    const next: CharacterProfile = {
      ...profile,
      loadouts: profile.loadouts.filter((x) => x.name !== l.name),
    };
    void saveProfile(next, `Deleted loadout “${l.name}”.`);
  }

  async function activateLoadout(l: Loadout) {
    setError(null);
    try {
      setProfileState(await switchLoadout(l.name));
      setStatus(`“${l.name}” is now active — applied to the live session.`);
    } catch (e) {
      setError(String(e));
    }
  }

  function setLoadoutClass(l: Loadout, slot: number, value: string) {
    if (!profile) return;
    const slots = [0, 1, 2].map((i) => l.classes[i] ?? "");
    slots[slot] = value;
    const classes = slots
      .filter(Boolean)
      .filter(
        (c, i, all) =>
          all.findIndex((x) => x.toLowerCase() === c.toLowerCase()) === i,
      );
    const next: CharacterProfile = {
      ...profile,
      loadouts: profile.loadouts.map((x) =>
        x.name === l.name ? { ...x, classes } : x,
      ),
    };
    void saveProfile(next, `Saved classes for “${l.name}”.`);
  }

  function commitLevel(raw: string) {
    if (!profile) return;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return;
    // Legends' level cap is 50; level scales generated buff-timer durations.
    const level = Math.max(1, Math.min(50, n));
    if (level !== profile.level) {
      void saveProfile({ ...profile, level }, "Level saved.");
    }
  }

  function commitAlertSize(raw: string) {
    // Clamp on COMMIT (blur/Enter), never per keystroke — mid-typing "2"
    // of "24" must not snap to 10 and persist.
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return;
    const px = Math.max(10, Math.min(72, n));
    setAlertSize(px);
    saveAlertSizePx(px);
  }

  function commitBuffThreshold(raw: string) {
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return;
    const mins = Math.max(0, n);
    setBuffThreshold(mins);
    // Overlay windows hear the storage event; this window the custom event.
    saveBuffThresholdMins(mins);
  }

  /** Entries that would be ON under this loadout (pack switch included). */
  function onEntries(l: Loadout): TriggerTreeEntry[] {
    if (!entries) return [];
    return entries.filter(
      (e) =>
        e.enabled &&
        effectiveEnabledInLoadout(
          {
            id: e.id,
            category: e.category,
            classes: e.classes,
            defaultEnabled: e.defaultEnabled,
          },
          l,
        ),
    );
  }

  /** Triggers that would be ON under this loadout (pack switch included). */
  function onCount(l: Loadout): number | null {
    if (!entries) return null;
    return onEntries(l).length;
  }

  /** Share the loadout's enabled triggers as an LCS1 bundle (item 8). */
  function shareLoadout(l: Loadout) {
    const on = onEntries(l);
    if (on.length === 0) {
      setError(`Loadout “${l.name}” has no enabled triggers to share.`);
      return;
    }
    setShare({
      name: l.name,
      ids: on.map((e) => e.id),
      // Fallback triggers for the mock/local string builder — user triggers
      // in full, bundled entries synthesized (desktop exports them by id).
      triggers: on.map((e) => {
        if (e.userIndex !== null && userTriggers[e.userIndex]) {
          const t = userTriggers[e.userIndex];
          return { ...t, id: t.id ?? e.id };
        }
        return {
          name: e.name,
          pattern: e.pattern,
          enabled: true,
          category: e.category,
          classes: e.classes,
          default_enabled: e.defaultEnabled,
          id: e.id,
          source: e.source,
          actions: [{ Speak: { template: e.name.toLowerCase() } }],
        };
      }),
    });
  }

  function pickTheme(t: Theme) {
    setTheme(t);
    setThemeState(t);
  }

  async function pickLogFile() {
    if (!config) return;
    if (IS_MOCK) {
      setStatus("File picker needs the desktop app (mock mode).");
      return;
    }
    try {
      const picked = await open({
        multiple: false,
        defaultPath: DEFAULT_LOG_DIR,
        filters: [{ name: "EQ log file", extensions: ["txt"] }],
      });
      if (typeof picked === "string") {
        await save({ ...config, logPath: picked });
      }
    } catch (e) {
      setError(String(e));
    }
  }

  async function toggleOverlay(label: string, show: boolean) {
    setError(null);
    try {
      if (show) {
        await overlayShow(label);
        await overlaySetClickThrough(label, !unlocked);
      } else {
        await overlayHide(label);
      }
      setShown((s) => {
        const next = { ...s, [label]: show };
        saveOverlayVisibility(next);
        return next;
      });
    } catch (e) {
      setError(String(e));
    }
  }

  async function toggleUnlock(next: boolean) {
    setUnlocked(next);
    setError(null);
    saveOverlayArrange(next);
    try {
      if (next) {
        // Enter arrange: reveal EVERY overlay (even disabled ones) so all can
        // be positioned and toggled on/off in place, and make them draggable.
        for (const label of OVERLAY_LABELS) {
          await overlayShow(label);
          await overlaySetClickThrough(label, false);
        }
      } else {
        // Lock: realize each overlay's enabled flag (hide the disabled ones)
        // and restore click-through so the shown overlays ignore the mouse.
        const vis = loadOverlayVisibility();
        setShown(vis);
        for (const label of OVERLAY_LABELS) {
          if (vis[label] === false) {
            await overlayHide(label);
          } else {
            await overlayShow(label);
            await overlaySetClickThrough(label, true);
          }
        }
      }
    } catch (e) {
      setError(String(e));
    }
  }

  /** Parse the comma-separated pets field into exact trimmed names. */
  function parsePets(raw: string): string[] {
    return raw
      .split(",")
      .map((n) => n.trim())
      .filter((n) => n.length > 0);
  }

  function formatDictionary(config: AppConfig): string {
    return (config.ttsDictionary ?? [])
      .map((row) => `${row.from}\t${row.to}`)
      .join("\n");
  }

  function parseDictionary(raw: string): { from: string; to: string }[] {
    return raw
      .split(/\r?\n/)
      .map((line) => {
        const [from, ...rest] = line.split(/\t|=>/);
        return { from: from.trim(), to: rest.join(" ").trim() };
      })
      .filter((row) => row.from.length > 0 && row.to.length > 0);
  }

  if (!config) {
    return <div className="hint">{error ?? "Loading settings…"}</div>;
  }

  return (
    <div className="settings">
      {error && <div className="error-banner">{error}</div>}
      {status && !error && <div className="status-banner">{status}</div>}

      <nav className="settings-tabs" aria-label="Settings sections">
        {[
          ["general", "General"],
          ["loadouts", "Loadouts"],
          ["overlays", "Overlays"],
          ["appearance", "Appearance"],
          ["updates", "Updates"],
        ].map(([id, label]) => (
          <button
            key={id}
            className={`settings-tab${section === id ? " active" : ""}`}
            onClick={() => setSection(id)}
          >
            {label}
          </button>
        ))}
      </nav>

      <section className={`card${section === "general" ? "" : " hidden"}`}>
        <div className="card-head">
          <span className="section-title">Log</span>
        </div>
        <label className="field">
          <span>Log file (default folder: {displayPath(DEFAULT_LOG_DIR)})</span>
          <div className="path-row">
            <input
              type="text"
              value={displayPath(config.logPath)}
              onChange={(e) =>
                setConfigState({ ...config, logPath: e.target.value })
              }
              onBlur={() => void save(config)}
            />
            <button className="ghost" onClick={pickLogFile}>
              Browse…
            </button>
          </div>
        </label>
        {logSize !== null && (
          <p className="hint">Current size: {formatBytes(logSize)}</p>
        )}
        {logSize !== null && logSize > LARGE_LOG_BYTES && (
          <div className="ted-warn">
            Large log files slow the game’s own writer — consider archiving. (EQ
            never truncates logs itself.)
          </div>
        )}
        <label className="field">
          <span>Character name</span>
          <input
            type="text"
            value={config.characterName}
            onChange={(e) =>
              setConfigState({ ...config, characterName: e.target.value })
            }
            onBlur={() => void save(config)}
          />
        </label>
        <label className="field">
          <span>
            My pets (comma-separated names) — counted as friendly casters and
            folded into your damage on the meters
          </span>
          <input
            type="text"
            placeholder="e.g. Gobaner, Fluffy"
            defaultValue={config.pets.join(", ")}
            key={config.pets.join(", ")}
            onBlur={(e) => {
              const pets = parsePets(e.target.value);
              if (pets.join("\u0000") !== config.pets.join("\u0000")) {
                void save({ ...config, pets });
              }
            }}
          />
        </label>
        <label className="field">
          <span>
            Trigger pack file (blank = triggers.json in the app config folder)
          </span>
          <input
            type="text"
            value={displayPath(config.triggerPackPath)}
            onChange={(e) =>
              setConfigState({ ...config, triggerPackPath: e.target.value })
            }
            onBlur={() => void save(config)}
          />
        </label>
        <label className="field">
          <span>
            Fight history retention (days, 0 = keep forever) — pruned at startup
          </span>
          <input
            type="number"
            min={0}
            step={1}
            value={config.fightRetentionDays ?? 0}
            onChange={(e) =>
              setConfigState({
                ...config,
                fightRetentionDays: Math.max(0, Math.floor(Number(e.target.value) || 0)),
              })
            }
            onBlur={() => void save(config)}
          />
        </label>
        <label className="field">
          <span>Trigger voice (Windows text-to-speech)</span>
          <span className="settings-voice-row">
            <select
              value={config.ttsVoice ?? ""}
              onChange={(e) => void save({ ...config, ttsVoice: e.target.value })}
            >
              <option value="">System default</option>
              {voices.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="ghost small"
              onClick={() =>
                void speakText(
                  "A frenzied ghoul begins casting Gate. This is your trigger voice.",
                )
              }
            >
              ▶ Test voice
            </button>
          </span>
        </label>
        <label className="field">
          <span>TTS pronunciation dictionary (one from-to pair per line)</span>
          <textarea
            className="settings-textarea"
            placeholder={"Cazic\tKaz-ick\nVeeshan\tVee-shan"}
            defaultValue={formatDictionary(config)}
            key={formatDictionary(config)}
            onBlur={(e) => {
              const ttsDictionary = parseDictionary(e.target.value);
              if (
                JSON.stringify(ttsDictionary) !==
                JSON.stringify(config.ttsDictionary ?? [])
              ) {
                void save({ ...config, ttsDictionary });
              }
            }}
          />
        </label>
      </section>

      <section className={`card${section === "loadouts" ? "" : " hidden"}`}>
        <div className="card-head">
          <span className="section-title">Loadouts</span>
          <span className="hint">
            Named trigger set-ups (classes + per-trigger overrides). Switch
            from the loadout menu in the top bar.
          </span>
        </div>
        {profile ? (
          <>
            <label className="field lo-level">
              <span>
                Character level (1–50) — scales generated buff-timer durations
              </span>
              <input
                type="number"
                min={1}
                max={50}
                defaultValue={profile.level}
                key={profile.level}
                onBlur={(e) => commitLevel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter")
                    commitLevel((e.target as HTMLInputElement).value);
                }}
              />
            </label>
            <div className="lo-list">
              {profile.loadouts.map((l) => {
                const isActive = l.name === profile.active_loadout;
                const on = onCount(l);
                const lastOne = profile.loadouts.length <= 1;
                return (
                  <div className={`lo-row${isActive ? " active" : ""}`} key={l.name}>
                    <div className="lo-main">
                      {renaming?.from === l.name ? (
                        <input
                          type="text"
                          className="lo-rename"
                          value={renaming.text}
                          autoFocus
                          onChange={(e) =>
                            setRenaming({ from: l.name, text: e.target.value })
                          }
                          onBlur={commitRename}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitRename();
                            if (e.key === "Escape") setRenaming(null);
                          }}
                          aria-label={`Rename loadout ${l.name}`}
                        />
                      ) : (
                        <span className="lo-name">{l.name}</span>
                      )}
                      {isActive && <span className="lo-badge">Active</span>}
                      <span className="lo-meta num">
                        {on === null ? "…" : `${on} trigger${on === 1 ? "" : "s"} on`}
                      </span>
                    </div>
                    <div className="lo-classes">
                      {[0, 1, 2].map((slot) => (
                        <select
                          key={slot}
                          value={l.classes[slot] ?? ""}
                          onChange={(e) => setLoadoutClass(l, slot, e.target.value)}
                          aria-label={`${l.name} class ${slot + 1}`}
                        >
                          <option value="">— class {slot + 1} —</option>
                          {CLASS_NAMES.map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>
                      ))}
                    </div>
                    <div className="lo-actions">
                      {!isActive && (
                        <button
                          className="ghost small"
                          onClick={() => void activateLoadout(l)}
                          title="Make this the active loadout (applies to the live session)"
                        >
                          Activate
                        </button>
                      )}
                      <button
                        className="ghost small"
                        onClick={() => setRenaming({ from: l.name, text: l.name })}
                      >
                        Rename
                      </button>
                      <button
                        className="ghost small"
                        onClick={() => duplicateLoadout(l)}
                      >
                        Duplicate
                      </button>
                      <button
                        className="ghost small"
                        onClick={() => shareLoadout(l)}
                        title={`Share “${l.name}”'s enabled triggers as a paste string`}
                      >
                        Share
                      </button>
                      <button
                        className="danger small"
                        onClick={() => deleteLoadout(l)}
                        disabled={lastOne || isActive}
                        title={
                          lastOne
                            ? "You need at least one loadout."
                            : isActive
                              ? "Switch to another loadout before deleting this one."
                              : `Delete “${l.name}”`
                        }
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
            <div>
              <button className="ghost" onClick={addLoadout}>
                New loadout
              </button>
            </div>
            <p className="hint">
              Per-trigger and folder toggles on the Triggers tab are saved to
              whichever loadout is active.
            </p>
          </>
        ) : (
          <div className="hint">Loading loadouts…</div>
        )}
      </section>

      <section className={`card${section === "appearance" ? "" : " hidden"}`}>
        <div className="card-head">
          <span className="section-title">Appearance</span>
        </div>
        <div className="field">
          <span className="field-label">Theme</span>
          <div className="seg" role="group" aria-label="Theme">
            <button
              className={theme === "dark" ? "active" : ""}
              onClick={() => pickTheme("dark")}
            >
              Dark
            </button>
            <button
              className={theme === "light" ? "active" : ""}
              onClick={() => pickTheme("light")}
            >
              Light
            </button>
          </div>
          <p className="hint">
            Dark is the default. The choice persists across sessions.
          </p>
        </div>
      </section>

      <section className={`card${section === "overlays" ? "" : " hidden"}`}>
        <div className="card-head">
          <span className="section-title">Overlays</span>
        </div>
        <div className="check-row">
          <input
            id="ov-alerts"
            type="checkbox"
            className="switch"
            checked={shown[OVERLAY_ALERTS]}
            onChange={(e) => void toggleOverlay(OVERLAY_ALERTS, e.target.checked)}
          />
          <label htmlFor="ov-alerts">Alerts overlay (text alerts)</label>
        </div>
        <div className="check-row">
          <input
            id="ov-buffs"
            type="checkbox"
            className="switch"
            checked={shown[OVERLAY_BUFFS]}
            onChange={(e) => void toggleOverlay(OVERLAY_BUFFS, e.target.checked)}
          />
          <label htmlFor="ov-buffs">Buff timers overlay (your buffs)</label>
        </div>
        <div className="check-row">
          <input
            id="ov-onothers"
            type="checkbox"
            className="switch"
            checked={shown[OVERLAY_ONOTHERS]}
            onChange={(e) =>
              void toggleOverlay(OVERLAY_ONOTHERS, e.target.checked)
            }
          />
          <label htmlFor="ov-onothers">
            On-others overlay (buffs you cast on others)
          </label>
        </div>
        <div className="check-row">
          <input
            id="ov-target"
            type="checkbox"
            className="switch"
            checked={shown[OVERLAY_TARGET]}
            onChange={(e) => void toggleOverlay(OVERLAY_TARGET, e.target.checked)}
          />
          <label htmlFor="ov-target">
            Target overlay (your effects on enemies)
          </label>
        </div>
        <div className="check-row">
          <input
            id="ov-meter"
            type="checkbox"
            className="switch"
            checked={shown[OVERLAY_METER]}
            onChange={(e) => void toggleOverlay(OVERLAY_METER, e.target.checked)}
          />
          <label htmlFor="ov-meter">DPS meter overlay (top 5)</label>
        </div>
        <div className="check-row">
          <input
            id="ov-xp"
            type="checkbox"
            className="switch"
            checked={shown[OVERLAY_XP]}
            onChange={(e) => void toggleOverlay(OVERLAY_XP, e.target.checked)}
          />
          <label htmlFor="ov-xp">XP rate overlay</label>
        </div>
        <div className="check-row">
          <input
            id="ov-stance"
            type="checkbox"
            className="switch"
            checked={shown[OVERLAY_STANCE]}
            onChange={(e) => void toggleOverlay(OVERLAY_STANCE, e.target.checked)}
          />
          <label htmlFor="ov-stance">
            Stance & invocation overlay (current martial stance — known after
            your first change)
          </label>
        </div>
        <div className="check-row">
          <input
            id="ov-respawn"
            type="checkbox"
            className="switch"
            checked={shown[OVERLAY_RESPAWN]}
            onChange={(e) =>
              void toggleOverlay(OVERLAY_RESPAWN, e.target.checked)
            }
          />
          <label htmlFor="ov-respawn">
            Timer overlay (respawn + custom countdowns, soonest on top — hidden
            when no timers are running)
          </label>
        </div>
        <div className="check-row check-sub">
          <input
            id="ov-respawn-rares"
            type="checkbox"
            className="switch"
            checked={campRaresOnly}
            onChange={(e) => {
              setCampRaresOnly(e.target.checked);
              saveCampRaresOnly(e.target.checked);
            }}
          />
          <label htmlFor="ov-respawn-rares">
            Auto-track rare spawns only — off also auto-tracks any 5-minute-plus
            respawn (manual Track/Arm always work)
          </label>
        </div>
        <div className="check-row">
          <input
            id="ov-meter-sources"
            type="checkbox"
            className="switch"
            checked={meterSources}
            onChange={(e) => {
              // Locked overlays are click-through, so this lives here; the
              // overlay window picks it up via the storage event.
              setMeterSources(e.target.checked);
              saveMeterSources(e.target.checked);
            }}
          />
          <label htmlFor="ov-meter-sources">
            Show my top damage sources on the meter overlay (up to 4
            micro-rows under your bar)
          </label>
        </div>
        <label className="field">
          <span>
            Damage sources shown under other players' bars on the meter
            overlay
          </span>
          <select
            value={meterOtherSources}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              setMeterOtherSources(n);
              saveMeterOtherSources(n);
            }}
          >
            <option value={0}>Off (single row each)</option>
            <option value={1}>Top 1</option>
            <option value={2}>Top 2</option>
            <option value={3}>Top 3</option>
          </select>
        </label>
        <label className="field ov-buff-threshold">
          <span>
            Alert text size in pixels (the on-screen text alerts over the
            game)
          </span>
          <input
            type="number"
            min={10}
            max={72}
            defaultValue={alertSize}
            key={alertSize}
            onBlur={(e) => commitAlertSize(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter")
                commitAlertSize((e.target as HTMLInputElement).value);
            }}
          />
        </label>
        <label className="field ov-buff-threshold">
          <span>
            Overlay buff bars appear only in their last N minutes (your buffs
            and buffs on others; the dashboard buff list always shows
            everything; 0 = always show, the default)
          </span>
          <input
            type="number"
            min={0}
            defaultValue={buffThreshold}
            key={buffThreshold}
            onBlur={(e) => commitBuffThreshold(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter")
                commitBuffThreshold((e.target as HTMLInputElement).value);
            }}
          />
        </label>
        <div className="check-row">
          <input
            id="ov-unlock"
            type="checkbox"
            className="switch"
            checked={unlocked}
            onChange={(e) => void toggleUnlock(e.target.checked)}
          />
          <label htmlFor="ov-unlock">
            Unlock to arrange (disables click-through so overlays can be
            dragged)
          </label>
        </div>
        <p className="hint">
          Locked overlays ignore the mouse entirely. Unlock, drag them into
          position, then lock again before playing.
        </p>
      </section>

      <section className={`card${section === "updates" ? "" : " hidden"}`}>
        <div className="card-head">
          <span className="section-title">App</span>
          <span className="hint">Signed builds from GitHub releases</span>
        </div>
        <div className="field">
          <span>Current version: v{APP_VERSION}</span>
          <div className="path-row">
            <button
              className="ghost"
              onClick={() => void checkAppUpdate()}
              disabled={appUpdateBusy}
            >
              {appUpdateBusy ? "Working…" : "Check for app update"}
            </button>
            {appUpdate && (
              <button
                className="ghost"
                onClick={() => void installAppUpdate()}
                disabled={appUpdateBusy}
              >
                Install v{appUpdate.version} & restart
              </button>
            )}
          </div>
        </div>
        {appUpdateStatus && <p className="hint">{appUpdateStatus}</p>}
      </section>

      <section className={`card${section === "updates" ? "" : " hidden"}`}>
        <div className="card-head">
          <span className="section-title">Reference data</span>
          <span className="hint">
            Drops/spells database + bundled trigger packs
          </span>
        </div>
        <div className="field">
          <span>
            Installed data version:{" "}
            {dataCurrent ?? "bundled with the app (no update installed)"}
          </span>
          <div className="path-row">
            <button
              className="ghost"
              onClick={() => void checkDataUpdate()}
              disabled={dataBusy}
            >
              {dataBusy ? "Working…" : "Check for data update"}
            </button>
            {dataInfo?.updateAvailable && (
              <button
                className="ghost"
                onClick={() => void installDataUpdate()}
                disabled={dataBusy}
              >
                Update data ({formatBytes(dataInfo.totalBytes)})
              </button>
            )}
          </div>
        </div>
        {dataStatus && <p className="hint">{dataStatus}</p>}
        <p className="hint">
          The Drops and reference tabs use updated data immediately. A running
          tailing session picks up new triggers the next time you press Start
          (or when a loadout/trigger change rebuilds the engine).
        </p>
      </section>
      {share && <ShareDialog request={share} onClose={() => setShare(null)} />}
    </div>
  );
}
