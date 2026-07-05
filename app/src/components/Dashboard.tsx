import { useCallback, useEffect, useRef, useState } from "react";
import {
  checkUpdate,
  installUpdate,
  type UpdateInfo,
  discoverLogs,
  getConfig,
  getProfile,
  isTailing,
  onTriggersChanged,
  overlayHide,
  overlaySetClickThrough,
  overlayShow,
  setActiveCharacter,
  silenceAudio,
  startTailing,
  stopTailing,
  switchLoadout,
} from "../api";
import { IS_MOCK } from "../mock";
import { useTauriEvent } from "../hooks";
import { activeLoadout } from "../resolution";
import {
  OVERLAY_LABELS,
  type AppConfig,
  type CatchUpPayload,
  type CharacterProfile,
  type DiscoveredLog,
  type SessionEndedPayload,
  type TailStatsPayload,
} from "../types";
import {
  loadOverlayVisibility,
  saveOverlayArrange,
  saveOverlayVisibility,
} from "../overlayState";
import LiveTab from "./LiveTab";
import MetersTab from "./MetersTab";
import DropsTab from "./DropsTab";
import MobsTab from "./MobsTab";
import RecipesTab from "./RecipesTab";
import SpellsTab from "./SpellsTab";
import FightsTab from "./FightsTab";
import MacrosTab from "./MacrosTab";
import TriggersTab from "./TriggersTab";
import SettingsTab from "./SettingsTab";
import WelcomeCard from "./WelcomeCard";
import {
  IconAbilities,
  IconEye,
  IconEyeOff,
  IconFights,
  IconLive,
  IconLock,
  IconMacros,
  IconMeters,
  IconMobs,
  IconPlay,
  IconRecipes,
  IconSettings,
  IconSpeakerOff,
  IconSpells,
  IconStop,
  IconTriggers,
  IconDrops,
  IconUnlock,
  IconWarn,
} from "./Icons";

const OVERLAYS = OVERLAY_LABELS;

type TabId =
  | "live"
  | "meters"
  | "fights"
  | "drops"
  | "mobs"
  | "recipes"
  | "spells"
  | "abilities"
  | "macros"
  | "triggers"
  | "settings";

interface NavTab {
  id: TabId;
  label: string;
  icon: (props: { size?: number }) => JSX.Element;
}

/** Sidebar sections: live-log tooling, reference databases, then Settings
 *  standalone (no group label). */
const NAV_GROUPS: { label: string | null; tabs: NavTab[] }[] = [
  {
    label: "Log",
    tabs: [
      { id: "live", label: "Live", icon: IconLive },
      { id: "meters", label: "Meters", icon: IconMeters },
      { id: "fights", label: "Fights", icon: IconFights },
      { id: "triggers", label: "Triggers", icon: IconTriggers },
    ],
  },
  {
    label: "Database",
    tabs: [
      { id: "drops", label: "Drops", icon: IconDrops },
      { id: "mobs", label: "Mobs", icon: IconMobs },
      { id: "recipes", label: "Recipes", icon: IconRecipes },
      { id: "spells", label: "Spells", icon: IconSpells },
      { id: "abilities", label: "Abilities", icon: IconAbilities },
      { id: "macros", label: "Macros", icon: IconMacros },
    ],
  },
  {
    label: null,
    tabs: [{ id: "settings", label: "Settings", icon: IconSettings }],
  },
];

const TAB_IDS: readonly string[] = NAV_GROUPS.flatMap((g) =>
  g.tabs.map((t) => t.id),
);

function initialTab(): TabId {
  const t = new URLSearchParams(window.location.search).get("tab");
  return t && TAB_IDS.includes(t) ? (t as TabId) : "live";
}

/** Patch-day canary threshold: % of recent lines the parser can't classify. */
const CANARY_PCT = 3;

/** Shipped app version (mirror of app/package.json "version"); shown in the
 *  sidebar and compared against the latest GitHub release. */
const APP_VERSION = "0.2.0";

/** localStorage key remembering the update version the user dismissed. */
const UPDATE_DISMISSED_KEY = "eqlogs.updateDismissed";

export default function Dashboard() {
  const [tab, setTab] = useState<TabId>(initialTab);
  // Deep-link from the session loot log: open Drops pre-searched for an item.
  const [dropsRequest, setDropsRequest] = useState<{
    query: string;
    seq: number;
  } | null>(null);
  useEffect(() => {
    const onOpenDrops = (e: Event) => {
      const query = String((e as CustomEvent).detail ?? "").trim();
      if (!query) return;
      setDropsRequest((prev) => ({ query, seq: (prev?.seq ?? 0) + 1 }));
      setTab("drops");
    };
    window.addEventListener("eqlogs-open-drops", onOpenDrops);
    return () => window.removeEventListener("eqlogs-open-drops", onOpenDrops);
  }, []);
  // Deep-link from the Drops crafting chips: open Recipes pre-searched.
  const [recipesRequest, setRecipesRequest] = useState<{
    query: string;
    seq: number;
  } | null>(null);
  const [mobsRequest, setMobsRequest] = useState<{
    query: string;
    seq: number;
  } | null>(null);
  useEffect(() => {
    const onOpenMobs = (e: Event) => {
      const query = String((e as CustomEvent).detail ?? "").trim();
      if (!query) return;
      setMobsRequest((prev) => ({ query, seq: (prev?.seq ?? 0) + 1 }));
      setTab("mobs");
    };
    window.addEventListener("eqlogs-open-mobs", onOpenMobs);
    return () => window.removeEventListener("eqlogs-open-mobs", onOpenMobs);
  }, []);
  useEffect(() => {
    const onOpenRecipes = (e: Event) => {
      const query = String((e as CustomEvent).detail ?? "").trim();
      if (!query) return;
      setRecipesRequest((prev) => ({ query, seq: (prev?.seq ?? 0) + 1 }));
      setTab("recipes");
    };
    window.addEventListener("eqlogs-open-recipes", onOpenRecipes);
    return () =>
      window.removeEventListener("eqlogs-open-recipes", onOpenRecipes);
  }, []);
  const [tailing, setTailing] = useState(false);
  const [character, setCharacter] = useState("");
  /** Discovered eqlog_* characters for the quiet top-bar switcher. */
  const [characters, setCharacters] = useState<DiscoveredLog[]>([]);
  const [overlaysLocked, setOverlaysLocked] = useState(true);
  const [overlaysOn, setOverlaysOn] = useState(() => {
    const v = loadOverlayVisibility();
    return OVERLAYS.some((label) => v[label]);
  });
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<CharacterProfile | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);
  /** Reason the tail session died unexpectedly (red banner + Restart). */
  const [sessionEnd, setSessionEnd] = useState<string | null>(null);
  /** Rolling unclassified-line rate from tail-stats (patch-day canary). */
  const [unclassifiedPct, setUnclassifiedPct] = useState(0);
  /** Replay catch-up in progress (item 13): alerts are suppressed. */
  const [catchingUp, setCatchingUp] = useState(false);
  /** First run: no saved config yet — show the welcome card. */
  const [needsSetup, setNeedsSetup] = useState(false);
  /** Newer release found on GitHub (slim banner); null = up to date/unknown. */
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [installing, setInstalling] = useState(false);

  function showToast(message: string) {
    setToast(message);
    if (toastTimer.current != null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2500);
  }

  useEffect(() => {
    isTailing()
      .then(setTailing)
      .catch(() => setTailing(false));
    getConfig()
      .then((c) => {
        setCharacter(c.characterName);
        // Empty log path = fresh install (defaults are blank now); walk the
        // user through picking a discovered log instead of a dead end.
        setNeedsSetup(c.logPath.trim().length === 0);
      })
      .catch(() => setCharacter(""));
    const refreshProfile = () =>
      getProfile()
        .then(setProfile)
        .catch(() => setProfile(null));
    refreshProfile();
    // Loadout create/rename/delete in Settings (and class edits on the
    // Triggers tab) go through setProfile, which notifies this listener.
    const offTriggers = onTriggersChanged(refreshProfile);
    // Apply persisted overlay visibility (windows default to visible;
    // hide any the user previously turned off) and start click-through.
    const v = loadOverlayVisibility();
    for (const label of OVERLAYS) {
      (v[label] ? overlayShow(label) : overlayHide(label)).catch(() => {});
      overlaySetClickThrough(label, true).catch(() => {});
    }
    return () => {
      offTriggers();
      if (toastTimer.current != null) window.clearTimeout(toastTimer.current);
    };
  }, []);

  // Backend pushes the full profile after set_profile/switch_loadout/
  // set_override — keeps the switcher in sync with edits made anywhere.
  useTauriEvent<CharacterProfile>("profile-changed", setProfile);
  // Boot auto-resume can start tailing after our initial is_tailing sample;
  // the backend pushes the truth on every state change.
  useTauriEvent<{ tailing: boolean }>("tailing-changed", (p) => setTailing(p.tailing));
  // Setup pushes the persisted config after boot — our initial get_config
  // may have sampled the blank default (spurious welcome card otherwise).
  useTauriEvent<AppConfig>("config-changed", (c) => {
    setCharacter(c.characterName);
    setNeedsSetup(c.logPath.trim().length === 0);
  });

  // The tail thread died unexpectedly: the green dot must not lie.
  useTauriEvent<SessionEndedPayload>("session-ended", (p) => {
    setSessionEnd(p.reason || "The log session ended unexpectedly.");
    setTailing(false);
  });

  // Patch-day canary: periodic unclassified-line rate from the tailer.
  useTauriEvent<TailStatsPayload>("tail-stats", (p) => {
    if (typeof p.unclassifiedPct === "number") {
      setUnclassifiedPct(p.unclassifiedPct);
    }
  });

  // Catch-up guard (item 13): topbar note while replayed lines stream
  // through with alerts suppressed; a toast sums it up on exit.
  useTauriEvent<CatchUpPayload>("catch-up", (p) => {
    setCatchingUp(p.active);
    if (!p.active) {
      showToast(
        `Caught up — skipped alerts for ${p.lines} replayed line${
          p.lines === 1 ? "" : "s"
        }`,
      );
    }
  });

  const doSilence = useCallback(async () => {
    try {
      await silenceAudio();
      showToast("Audio silenced — queued alerts dropped");
    } catch (e) {
      setError(String(e));
    }
  }, []);

  // Esc-Esc double-tap = silence (item 14): the incident kill switch must
  // work without hunting for a button mid-raid.
  useEffect(() => {
    let lastEsc = 0;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const now = Date.now();
      if (now - lastEsc < 450) {
        lastEsc = 0;
        void doSilence();
      } else {
        lastEsc = now;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [doSilence]);

  // Update check (APP_REVIEW N1): one silent GitHub call on mount. Skipped
  // entirely in mock mode; any failure resolves to null and shows nothing.
  // A per-version dismissal in localStorage keeps a declined update quiet.
  useEffect(() => {
    if (IS_MOCK) return;
    let cancelled = false;
    checkUpdate()
      .then((u) => {
        if (cancelled || !u) return;
        let dismissed: string | null = null;
        try {
          dismissed = window.localStorage.getItem(UPDATE_DISMISSED_KEY);
        } catch {
          dismissed = null;
        }
        if (dismissed !== u.version) setUpdate(u);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Install the pending update in place and relaunch. The backend restarts the
  // app on success, so this promise typically never resolves; on failure we
  // surface a toast and let the user retry or dismiss.
  const doInstallUpdate = useCallback(async () => {
    setInstalling(true);
    try {
      await installUpdate();
    } catch (e) {
      setInstalling(false);
      showToast(`Update failed: ${String(e)}`);
    }
  }, []);

  const dismissUpdate = useCallback(() => {
    if (update) {
      try {
        window.localStorage.setItem(UPDATE_DISMISSED_KEY, update.version);
      } catch {
        // storage unavailable — dismissal just won't persist across restarts
      }
    }
    setUpdate(null);
  }, [update]);

  const restartTailing = useCallback(async () => {
    setError(null);
    try {
      await startTailing();
      setSessionEnd(null);
      setTailing(true);
      showToast("Tailing restarted");
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const changeLoadout = useCallback(async (name: string) => {
    setError(null);
    try {
      setProfile(await switchLoadout(name));
      showToast("Loadout applied to live session");
    } catch (e) {
      setError(String(e));
    }
  }, []);

  // Populate the character switcher from discovered logs (each eqlog_* file
  // is one character). Refreshed on mount + whenever config changes (a newly
  // configured log dir may surface more characters).
  useEffect(() => {
    discoverLogs()
      .then(setCharacters)
      .catch(() => setCharacters([]));
  }, []);

  const changeCharacter = useCallback(async (log: DiscoveredLog) => {
    setError(null);
    try {
      await setActiveCharacter(log.server, log.character);
      // Real backend re-emits config-changed/profile-changed (top bar + profile
      // sync via those listeners); mock has no events, so refresh directly.
      setCharacter(log.character);
      if (IS_MOCK) setProfile(await getProfile());
      showToast(`Switched to ${log.character}`);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const toggleTailing = useCallback(async () => {
    setError(null);
    try {
      if (tailing) {
        await stopTailing();
        setTailing(false);
      } else {
        await startTailing();
        setTailing(true);
      }
    } catch (e) {
      const msg = String(e);
      if (msg.includes("already tailing")) {
        // Not an error — the UI was stale (boot auto-resume). Adopt reality.
        setTailing(true);
      } else if (msg.includes("not tailing")) {
        setTailing(false);
      } else {
        setError(msg);
      }
    }
  }, [tailing]);

  const toggleOverlays = useCallback(async () => {
    const next = !overlaysOn;
    setOverlaysOn(next);
    setError(null);
    try {
      for (const label of OVERLAYS) {
        if (next) {
          await overlayShow(label);
          await overlaySetClickThrough(label, overlaysLocked);
        } else {
          await overlayHide(label);
        }
      }
      if (!next && !overlaysLocked) {
        setOverlaysLocked(true);
      }
      saveOverlayVisibility(
        Object.fromEntries(OVERLAYS.map((label) => [label, next])),
      );
    } catch (e) {
      setError(String(e));
    }
  }, [overlaysOn, overlaysLocked]);

  const toggleOverlayLock = useCallback(async () => {
    const nextLocked = !overlaysLocked;
    setOverlaysLocked(nextLocked);
    saveOverlayArrange(!nextLocked);
    setError(null);
    try {
      if (!nextLocked) {
        // Arranging implies the overlays must be visible.
        setOverlaysOn(true);
        for (const label of OVERLAYS) {
          await overlayShow(label);
        }
        saveOverlayVisibility(
          Object.fromEntries(OVERLAYS.map((label) => [label, true])),
        );
      }
      // Locked = click-through.
      for (const label of OVERLAYS) {
        await overlaySetClickThrough(label, nextLocked);
      }
    } catch (e) {
      setError(String(e));
    }
  }, [overlaysLocked]);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          Legends Companion
          <span className="brand-sub">for EverQuest Legends</span>
        </div>
        <nav className="nav" aria-label="Main">
          {NAV_GROUPS.map((g, gi) => (
            <div className="nav-group" key={g.label ?? `group-${gi}`}>
              {g.label && <div className="nav-group-label">{g.label}</div>}
              {g.tabs.map((t) => (
                <button
                  key={t.id}
                  className={tab === t.id ? "active" : ""}
                  onClick={() => setTab(t.id)}
                >
                  <t.icon />
                  {t.label}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">v{APP_VERSION}</div>
      </aside>

      <div className="main">
        <header className="topbar">
          {characters.length > 1 ? (
            <label
              className="char-switch"
              title="Active character — switching points the app at that character's log and profile"
            >
              <select
                value={
                  characters.find(
                    (l) => l.character.toLowerCase() === character.toLowerCase(),
                  )?.path ?? ""
                }
                onChange={(e) => {
                  const log = characters.find((l) => l.path === e.target.value);
                  if (log) void changeCharacter(log);
                }}
                aria-label="Character"
              >
                {characters.map((l) => (
                  <option key={l.path} value={l.path}>
                    {l.character}
                    {l.server ? ` · ${l.server}` : ""}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <span className="char-name">{character || "No character"}</span>
          )}
          {profile && profile.loadouts.length > 0 && (
            <label className="loadout-switch" title="Trigger loadout — switching applies it to the live session">
              <span className="loadout-label">Loadout</span>
              <select
                value={activeLoadout(profile).name}
                onChange={(e) => void changeLoadout(e.target.value)}
                aria-label="Loadout"
              >
                {profile.loadouts.map((l) => (
                  <option key={l.name} value={l.name}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <span className="conn">
            <span className={`status-dot${tailing ? " live" : ""}`} />
            {tailing ? "Tailing log" : "Idle"}
          </span>
          {catchingUp && (
            <span
              className="catchup-badge"
              title="The log jumped backwards (replayed content). Speech, sounds, timers and fight-history writes are paused until the session is back at the live edge; meters keep counting."
            >
              Catching up — alerts paused
            </span>
          )}
          {unclassifiedPct > CANARY_PCT && (
            <span
              className="canary-badge"
              title={`${unclassifiedPct.toFixed(1)}% of recent log lines were not recognized — a game update may have changed log formats. Check for an app update.`}
            >
              <IconWarn />
              {unclassifiedPct.toFixed(1)}% unrecognized
            </span>
          )}
          <button className="ghost small" onClick={toggleTailing}>
            {tailing ? <IconStop /> : <IconPlay />}
            {tailing ? "Stop" : "Start"}
          </button>
          <button
            className="ghost small"
            onClick={() => void doSilence()}
            title="Silence — stop the current speech and drop queued alerts (Esc Esc)"
          >
            <IconSpeakerOff />
            Silence
          </button>
          <span className="spacer" />
          <button
            className="ghost small"
            onClick={toggleOverlays}
            title={
              overlaysOn
                ? "Overlays are shown over the game. Click to hide them."
                : "Overlays are hidden. Click to show them."
            }
          >
            {overlaysOn ? <IconEye /> : <IconEyeOff />}
            Overlays {overlaysOn ? "on" : "off"}
          </button>
          <button
            className="ghost small"
            onClick={toggleOverlayLock}
            disabled={!overlaysOn && overlaysLocked}
            title={
              overlaysLocked
                ? "Overlays are click-through. Arrange to drag them into place."
                : "Overlays accept the mouse. Lock before playing."
            }
          >
            {overlaysLocked ? <IconLock /> : <IconUnlock />}
            {overlaysLocked ? "Arrange" : "Done arranging"}
          </button>
        </header>

        <div className="content">
          {update && (
            <div className="update-banner" role="status">
              <span className="update-banner-text">
                Update available: v{update.version}
              </span>
              <button
                className="update-banner-link"
                onClick={() => void doInstallUpdate()}
                disabled={installing}
              >
                {installing ? "Installing…" : "Install & restart"}
              </button>
              <button
                className="ghost small"
                onClick={dismissUpdate}
                disabled={installing}
                aria-label="Dismiss update notice"
              >
                Dismiss
              </button>
            </div>
          )}
          {sessionEnd && (
            <div className="session-banner" role="alert">
              <span className="session-banner-text">
                <strong>Log session ended</strong> — {sessionEnd}
              </span>
              <button className="primary small" onClick={() => void restartTailing()}>
                Restart
              </button>
              <button
                className="ghost small"
                onClick={() => setSessionEnd(null)}
                aria-label="Dismiss"
              >
                Dismiss
              </button>
            </div>
          )}
          {error && <div className="error-banner">{error}</div>}
          {needsSetup && tab !== "settings" && (
            <WelcomeCard
              onChosen={(name) => {
                setCharacter(name);
                setNeedsSetup(false);
                showToast(`Log selected — press Start to follow ${name}'s log`);
              }}
              onOpenSettings={() => setTab("settings")}
            />
          )}
          <section className={`page page-live${tab === "live" ? "" : " hidden"}`}>
            <LiveTab character={character} />
          </section>
          <section className={`page${tab === "meters" ? "" : " hidden"}`}>
            <MetersTab character={character} />
          </section>
          <section className={`page${tab === "fights" ? "" : " hidden"}`}>
            <FightsTab character={character} />
          </section>
          <section className={`page${tab === "drops" ? "" : " hidden"}`}>
            <DropsTab searchRequest={dropsRequest} />
          </section>
          <section className={`page${tab === "mobs" ? "" : " hidden"}`}>
            <MobsTab searchRequest={mobsRequest} />
          </section>
          <section className={`page${tab === "recipes" ? "" : " hidden"}`}>
            <RecipesTab searchRequest={recipesRequest} />
          </section>
          <section className={`page${tab === "spells" ? "" : " hidden"}`}>
            <SpellsTab kind="spells" />
          </section>
          <section className={`page${tab === "abilities" ? "" : " hidden"}`}>
            <SpellsTab kind="abilities" />
          </section>
          <section className={`page${tab === "macros" ? "" : " hidden"}`}>
            <MacrosTab />
          </section>
          <section className={`page${tab === "triggers" ? "" : " hidden"}`}>
            <TriggersTab character={character} />
          </section>
          <section className={`page${tab === "settings" ? "" : " hidden"}`}>
            <SettingsTab onCharacterChange={setCharacter} />
          </section>
        </div>
      </div>
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
