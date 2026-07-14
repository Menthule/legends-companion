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
  overlaySetArranging,
  overlaySetClickThrough,
  overlayShow,
  setActiveCharacter,
  silenceAudio,
  startTailing,
  stopTailing,
  switchLoadout,
} from "../api";
import { IS_MOCK } from "../mock";
import { useDismissOnOutsidePointer, useTauriEvent } from "../hooks";
import { activeLoadout } from "../resolution";
import {
  pushRecentLog,
  pushRecentLogLine,
  type GlobalSearchAction,
} from "../lib/globalSearch";
import {
  setLiveZoneName,
  useLiveZoneEnabled,
  useLiveZoneName,
} from "../lib/refFilters";
import { useDeepLink } from "../lib/deepLinks";
import { onSessionNotice, startSessionLog } from "../lib/sessionLog";
import {
  type AppConfig,
  type CatchUpPayload,
  type CharacterProfile,
  type DiscoveredLog,
  type EqEvent,
  type LogLinePayload,
  type SessionEndedPayload,
  type TailStatsPayload,
} from "../types";
import { overlayWindowLabels } from "../overlay/modules";
import {
  loadOverlayVisibility,
  OVERLAY_VIS_EVENT,
  OVERLAY_VIS_KEY,
  saveOverlayArrange,
  saveOverlayVisibility,
  useOverlayArrange,
} from "../overlayState";
import { useToast } from "./Toast";
import LiveTab from "./LiveTab";
import MetersTab from "./MetersTab";
import DropsTab from "./DropsTab";
import MobsTab from "./MobsTab";
import RecipesTab from "./RecipesTab";
import SpellsTab from "./SpellsTab";
import DingDigest from "./DingDigest";
import FightsTab from "./FightsTab";
import TimersTab from "./TimersTab";
import MacrosTab from "./MacrosTab";
import TriggersTab from "./TriggersTab";
import SettingsTab from "./SettingsTab";
import WelcomeCard from "./WelcomeCard";
import WelcomeBack from "./WelcomeBack";
import GlobalSearchModal from "./GlobalSearchModal";
import CoachTab from "./CoachTab";
import DiagnosticsTab from "./DiagnosticsTab";
import QuestsTab from "./QuestsTab";
import { loadQuestCatalog, questsForGiver, type QuestRecord } from "../lib/quests";
import {
  IconEye,
  IconEyeOff,
  IconFights,
  IconDiagnostics,
  IconInsights,
  IconQuests,
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
  IconTimers,
  IconTriggers,
  IconDrops,
  IconUnlock,
  IconWarn,
} from "./Icons";

const OVERLAYS = overlayWindowLabels();

type TabId =
  | "live"
  | "meters"
  | "fights"
  | "timers"
  | "coach"
  | "diagnostics"
  | "drops"
  | "mobs"
  | "quests"
  | "recipes"
  | "spells"
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
      { id: "timers", label: "Timers", icon: IconTimers },
      { id: "coach", label: "Session", icon: IconInsights },
      { id: "triggers", label: "Triggers", icon: IconTriggers },
    ],
  },
  {
    label: "Database",
    tabs: [
      { id: "drops", label: "Drops", icon: IconDrops },
      { id: "mobs", label: "Mobs", icon: IconMobs },
      { id: "quests", label: "Quests", icon: IconQuests },
      { id: "recipes", label: "Recipes", icon: IconRecipes },
      { id: "spells", label: "Spells", icon: IconSpells },
      { id: "macros", label: "Macros", icon: IconMacros },
    ],
  },
  {
    label: null,
    tabs: [
      { id: "diagnostics", label: "Diagnostics", icon: IconDiagnostics },
      { id: "settings", label: "Settings", icon: IconSettings },
    ],
  },
];

const TAB_IDS: readonly string[] = NAV_GROUPS.flatMap((g) =>
  g.tabs.map((t) => t.id),
);

function initialTab(): TabId {
  const t = new URLSearchParams(window.location.search).get("tab");
  // Retired tab ids from older builds keep working: Abilities is now the
  // second segment of the Spells tab (SpellsTab reads the same URL param),
  // and Patch notes lives under Settings → Updates.
  if (t === "abilities") return "spells";
  if (t === "patch-notes") return "settings";
  return t && TAB_IDS.includes(t) ? (t as TabId) : "live";
}

/** Patch-day canary threshold: % of recent lines the parser can't classify. */
const CANARY_PCT = 3;

/** Shipped app version (mirror of app/package.json "version"); shown in the
 *  sidebar and compared against the latest GitHub release. */
const APP_VERSION = __APP_VERSION__;

/** localStorage key remembering the update version the user dismissed. */
const UPDATE_DISMISSED_KEY = "eqlogs.updateDismissed";

function namedEntity(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "Named" in e) {
    return String((e as { Named: unknown }).Named);
  }
  return "";
}

function chatFields(event: EqEvent):
  | { channel: unknown; speaker: string; text: string }
  | null {
  if (typeof event !== "object" || event === null || !("Chat" in event)) {
    return null;
  }
  const chat = event.Chat;
  if (typeof chat !== "object" || chat === null) return null;
  const c = chat as Record<string, unknown>;
  return {
    channel: c.channel,
    speaker: namedEntity(c.speaker),
    text: typeof c.text === "string" ? c.text : "",
  };
}

function outgoingHailName(event: EqEvent): string | null | undefined {
  const chat = chatFields(event);
  if (chat?.channel !== "Say" || chat.speaker !== "You") return undefined;
  const m = /^Hail(?:,\s*(.+?))?[.!?]?$/i.exec(chat.text.trim());
  if (!m) return undefined;
  return m[1]?.trim() || null;
}

function hailResponseName(p: LogLinePayload): string | null {
  const chat = chatFields(p.event);
  if (chat?.channel === "Say" && chat.speaker && chat.speaker !== "You") {
    return chat.speaker;
  }
  const told = /^(.+?) told you, '.*'$/.exec(p.message);
  return told?.[1]?.trim() ?? null;
}

function zoneEnterName(event: EqEvent): string | null {
  if (typeof event !== "object" || event === null || !("ZoneEnter" in event)) {
    return null;
  }
  const zone = event.ZoneEnter;
  if (typeof zone !== "object" || zone === null) return null;
  const name = (zone as Record<string, unknown>).zone;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}

export default function Dashboard() {
  const [tab, setTab] = useState<TabId>(initialTab);
  // Lazy-mount the query-heavy Database tabs (P23): each fires its sqlite
  // queries on mount, so mounting all of them at boot did a pile of work no
  // one asked for. Render one only after it's first visited, then keep it
  // mounted so re-visits are instant. Live tabs (meters/coach/timers) stay
  // always-mounted — they accumulate per-run view state from log events
  // while hidden. Session data itself (loot/rolls/XP/kills/effects) is
  // accumulated by lib/sessionLog, started below, independent of any tab.
  const [visited, setVisited] = useState<Set<TabId>>(
    () => new Set([initialTab()]),
  );
  useEffect(() => {
    setVisited((prev) => (prev.has(tab) ? prev : new Set(prev).add(tab)));
  }, [tab]);
  // Deep-link from the session loot log: open Drops pre-searched for an item.
  const [dropsRequest, setDropsRequest] = useState<{
    query: string;
    seq: number;
    revealUnsourced?: boolean;
  } | null>(null);
  useDeepLink("drops", (detail) => {
    const query = String(detail ?? "").trim();
    if (!query) return;
    setDropsRequest((prev) => ({ query, seq: (prev?.seq ?? 0) + 1 }));
    setTab("drops");
  });
  // Deep-link from the Drops crafting chips: open Recipes pre-searched.
  const [recipesRequest, setRecipesRequest] = useState<{
    query: string;
    seq: number;
  } | null>(null);
  const [mobsRequest, setMobsRequest] = useState<{
    query: string;
    seq: number;
  } | null>(null);
  const [questsRequest, setQuestsRequest] = useState<{ query: string; seq: number } | null>(null);
  const [triggersRequest, setTriggersRequest] = useState<{
    query: string;
    seq: number;
  } | null>(null);
  const [liveRequest, setLiveRequest] = useState<{
    query: string;
    seq: number;
  } | null>(null);
  const [globalSearch, setGlobalSearch] = useState<{
    query: string;
    reason?: string;
    seq: number;
  } | null>(null);
  const [settingsSectionRequest, setSettingsSectionRequest] = useState<{
    section: string;
    seq: number;
  } | null>(null);
  useDeepLink("quests", (detail) => {
    const query = String(detail ?? "").trim();
    if (!query) return;
    setQuestsRequest((prev) => ({ query, seq: (prev?.seq ?? 0) + 1 }));
    setTab("quests");
  });
  // Deep-link from the Meters "N timers running" line: jump to Timers.
  useDeepLink("timers", () => setTab("timers"));
  const [currentZone, setCurrentZone] = useState<string | null>(null);
  const [liveZoneEnabled, setLiveZoneEnabled] = useLiveZoneEnabled();
  const [liveZoneName] = useLiveZoneName();
  const [activeLogPath, setActiveLogPath] = useState("");
  const [suggestedLog, setSuggestedLog] = useState<DiscoveredLog | null>(null);
  const [dismissedLogPath, setDismissedLogPath] = useState("");
  const [hailCard, setHailCard] = useState<{ name: string; ts: number } | null>(null);
  const [hailQuests, setHailQuests] = useState<QuestRecord[]>([]);
  const [liveMenuOpen, setLiveMenuOpen] = useState(false);
  const [overlayMenuOpen, setOverlayMenuOpen] = useState(false);
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const liveMenuRef = useRef<HTMLDivElement>(null);
  const sessionMenuRef = useRef<HTMLDivElement>(null);
  const overlayMenuRef = useRef<HTMLDivElement>(null);
  const closeTopbarPopovers = useCallback(() => {
    setLiveMenuOpen(false);
    setSessionMenuOpen(false);
    setOverlayMenuOpen(false);
  }, []);
  useDismissOnOutsidePointer(
    [liveMenuRef, sessionMenuRef, overlayMenuRef],
    liveMenuOpen || sessionMenuOpen || overlayMenuOpen,
    closeTopbarPopovers,
  );
  const pendingHailUntil = useRef(0);
  useEffect(() => {
    let stale = false;
    if (!hailCard) {
      setHailQuests([]);
      return;
    }
    void loadQuestCatalog().then((catalog) => {
      if (!stale) setHailQuests(questsForGiver(hailCard.name, currentZone ?? "", catalog.quests));
    });
    return () => {
      stale = true;
    };
  }, [hailCard?.name, currentZone]);
  useDeepLink("mobs", (detail) => {
    const query = String(detail ?? "").trim();
    if (!query) return;
    setMobsRequest((prev) => ({ query, seq: (prev?.seq ?? 0) + 1 }));
    setTab("mobs");
  });
  useDeepLink("recipes", (detail) => {
    const query = String(detail ?? "").trim();
    if (!query) return;
    setRecipesRequest((prev) => ({ query, seq: (prev?.seq ?? 0) + 1 }));
    setTab("recipes");
  });
  // Deep-link from the ding digest: open Spells/Abilities pre-searched.
  const [spellsRequest, setSpellsRequest] = useState<{
    query: string;
    isAbility: boolean;
    seq: number;
  } | null>(null);
  useDeepLink("spells", (detail) => {
    const query = String(detail?.name ?? "").trim();
    if (!query) return;
    const isAbility = detail?.isAbility === true;
    setSpellsRequest((prev) => ({
      query,
      isAbility,
      seq: (prev?.seq ?? 0) + 1,
    }));
    setTab("spells");
  });
  // Deep-link from Settings → Loadouts: classes/level are edited on the
  // Triggers tab's "My classes" bar.
  useDeepLink("triggers", () => setTab("triggers"));
  const [tailing, setTailing] = useState(false);
  const [character, setCharacter] = useState("");
  /** Discovered eqlog_* characters for the quiet top-bar switcher. */
  const [characters, setCharacters] = useState<DiscoveredLog[]>([]);
  // Shared arrange store (overlayState): the top-bar toggle and Settings →
  // Overlays both derive from it, so neither control lies after the other is
  // used. Mutate via saveOverlayArrange.
  const overlaysArranging = useOverlayArrange();
  const overlaysLocked = !overlaysArranging;
  const [overlaysOn, setOverlaysOn] = useState(() => {
    const v = loadOverlayVisibility();
    return OVERLAYS.some((label) => v[label]);
  });
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<CharacterProfile | null>(null);
  const [toastNode, showToast] = useToast();
  /** Reason the tail session died unexpectedly (red banner + Restart). */
  const [sessionEnd, setSessionEnd] = useState<string | null>(null);
  /** Rolling unclassified-line rate from tail-stats (patch-day canary). */
  const [unclassifiedPct, setUnclassifiedPct] = useState(0);
  /** Replay catch-up in progress (item 13): alerts are suppressed. */
  const [catchingUp, setCatchingUp] = useState(false);
  /** Ref twin of catchingUp for event handlers (state is stale in callbacks). */
  const catchingUpRef = useRef(false);
  /** First run: no saved config yet — show the welcome card. */
  const [needsSetup, setNeedsSetup] = useState(false);
  /** Newer release found on GitHub (slim banner); null = up to date/unknown. */
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    const sync = () => {
      const v = loadOverlayVisibility();
      setOverlaysOn(OVERLAYS.some((label) => v[label]));
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === OVERLAY_VIS_KEY) sync();
    };
    window.addEventListener(OVERLAY_VIS_EVENT, sync);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(OVERLAY_VIS_EVENT, sync);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const openGlobalSearch = useCallback((query = "", reason?: string) => {
    setGlobalSearch((prev) => ({
      query,
      reason,
      seq: (prev?.seq ?? 0) + 1,
    }));
  }, []);

  // Session accumulation (loot/rolls/XP/kills/effects/recaps/scoreboard)
  // lives in lib/sessionLog so it keeps working no matter which tab is
  // mounted; its user-facing notices surface through the app toast.
  useEffect(() => {
    startSessionLog();
    return onSessionNotice((message) => showToast(message));
  }, [showToast]);

  useEffect(() => {
    isTailing()
      .then(setTailing)
      .catch(() => setTailing(false));
    getConfig()
      .then((c) => {
        setCharacter(c.characterName);
        setActiveLogPath(c.logPath);
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
    // Arrange is transient: clear any persisted arrange flag on startup so a
    // restart mid-arrange doesn't leave every overlay showing drag chrome. The
    // storage write also nudges overlay windows to re-lock.
    saveOverlayArrange(false);
    // Apply persisted overlay visibility (windows default to visible;
    // hide any the user previously turned off) and start click-through.
    const v = loadOverlayVisibility();
    for (const label of OVERLAYS) {
      (v[label] ? overlayShow(label) : overlayHide(label)).catch(() => {});
      overlaySetClickThrough(label, true).catch(() => {});
    }
    return () => {
      offTriggers();
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
    setActiveLogPath(c.logPath);
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

  useTauriEvent<LogLinePayload>("log-line", (p) => {
    pushRecentLogLine(p);
    const zone = zoneEnterName(p.event);
    if (zone) {
      setCurrentZone(zone);
      setLiveZoneName(zone);
    }
    // Replayed history must not pop the hail card / global search: a
    // week-old "Hail, X" is not a request to look X up now.
    if (catchingUpRef.current) return;
    const hailName = outgoingHailName(p.event);
    if (hailName !== undefined) {
      pendingHailUntil.current = p.ts + 8;
      if (hailName) {
        pendingHailUntil.current = 0;
        setHailCard({ name: hailName, ts: p.ts });
        openGlobalSearch(hailName, `Hail: ${hailName}`);
      }
      return;
    }
    if (p.ts <= pendingHailUntil.current) {
      const responseName = hailResponseName(p);
      if (responseName) {
        pendingHailUntil.current = 0;
        setHailCard({ name: responseName, ts: p.ts });
        openGlobalSearch(responseName, `Hail: ${responseName}`);
      }
    }
  });

  // Catch-up guard (item 13): topbar note while replayed lines stream
  // through with alerts suppressed; a toast sums it up on exit.
  useTauriEvent<CatchUpPayload>("catch-up", (p) => {
    catchingUpRef.current = p.active;
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

  // Backend already silenced the audio (Ctrl+Alt+S global hotkey, works
  // while the game has focus) — this is just the visible confirmation.
  useTauriEvent("global-silence", () => {
    showToast("Audio silenced — queued alerts dropped (Ctrl+Alt+S)");
  });

  // Esc-Esc double-tap = silence (item 14) while the companion has focus;
  // Ctrl+Alt+S (global, backend-registered) covers game-focused play.
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const typing =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        target?.isContentEditable === true;
      const chord =
        ((e.ctrlKey || e.metaKey) &&
          (e.key.toLowerCase() === "k" || e.key.toLowerCase() === "f")) ||
        (e.key === "/" && !typing);
      if (!chord) return;
      e.preventDefault();
      openGlobalSearch();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openGlobalSearch]);

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

  /** Start (never stop) tailing; shared by the welcome-card auto-start and
   *  the Live tab's empty-state CTA. Resolves true when tailing is running. */
  const startTailingNow = useCallback(async (): Promise<boolean> => {
    setError(null);
    try {
      await startTailing();
      setTailing(true);
      return true;
    } catch (e) {
      const msg = String(e);
      if (msg.includes("already tailing")) {
        // Not an error — the UI was stale (boot auto-resume). Adopt reality.
        setTailing(true);
        return true;
      }
      setError(msg);
      return false;
    }
  }, []);

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

  const refreshCharacters = useCallback(() => {
    discoverLogs()
      .then(setCharacters)
      .catch(() => setCharacters([]));
  }, []);

  useEffect(() => {
    const newest = characters
      .filter((l) => l.modifiedTs != null)
      .sort((a, b) => (b.modifiedTs ?? 0) - (a.modifiedTs ?? 0))[0];
    if (!newest || newest.path === dismissedLogPath) {
      setSuggestedLog(null);
      return;
    }
    const current = characters.find((l) => l.path === activeLogPath);
    const newerBySecs = (newest.modifiedTs ?? 0) - (current?.modifiedTs ?? 0);
    const newestAgeSecs = Date.now() / 1000 - (newest.modifiedTs ?? 0);
    const differentCharacter =
      newest.character.toLowerCase() !== character.toLowerCase() ||
      newest.path !== activeLogPath;
    const confident =
      newestAgeSecs <= 90 && (!current || newerBySecs >= (tailing ? 30 : 15));
    if (differentCharacter && confident) {
      setSuggestedLog(newest);
    } else {
      setSuggestedLog(null);
    }
  }, [activeLogPath, character, characters, dismissedLogPath, tailing]);

  const changeCharacter = useCallback(async (log: DiscoveredLog) => {
    setError(null);
    try {
      await setActiveCharacter(log.server, log.character);
      pushRecentLog(log);
      setActiveLogPath(log.path);
      setSuggestedLog(null);
      // The backend emits config/profile changes, but refresh directly too so
      // the selected character's one-to-many loadout list updates immediately.
      setCharacter(log.character);
      const [nextProfile, nextConfig] = await Promise.all([
        getProfile().catch(() => null),
        getConfig().catch(() => null),
      ]);
      if (nextProfile) setProfile(nextProfile);
      if (nextConfig) {
        setCharacter(nextConfig.characterName);
        setActiveLogPath(nextConfig.logPath);
      }
      refreshCharacters();
      showToast(`Switched to ${log.character}`);
    } catch (e) {
      setError(String(e));
    }
  }, [refreshCharacters]);

  const handleGlobalSearchAction = useCallback(
    (action: GlobalSearchAction) => {
      if (action.kind === "open-tab-search") {
        switch (action.tab) {
          case "live":
            setLiveRequest((prev) => ({
              query: action.query,
              seq: (prev?.seq ?? 0) + 1,
            }));
            setTab("live");
            break;
          case "drops":
            setDropsRequest((prev) => ({
              query: action.query,
              seq: (prev?.seq ?? 0) + 1,
              revealUnsourced: action.revealUnsourced,
            }));
            setTab("drops");
            break;
          case "mobs":
            setMobsRequest((prev) => ({
              query: action.query,
              seq: (prev?.seq ?? 0) + 1,
            }));
            setTab("mobs");
            break;
          case "quests":
            setQuestsRequest((prev) => ({
              query: action.query,
              seq: (prev?.seq ?? 0) + 1,
            }));
            setTab("quests");
            break;
          case "recipes":
            setRecipesRequest((prev) => ({
              query: action.query,
              seq: (prev?.seq ?? 0) + 1,
            }));
            setTab("recipes");
            break;
          case "spells":
            setSpellsRequest((prev) => ({
              query: action.query,
              isAbility: action.isAbility === true,
              seq: (prev?.seq ?? 0) + 1,
            }));
            setTab("spells");
            break;
          case "triggers":
            setTriggersRequest((prev) => ({
              query: action.query,
              seq: (prev?.seq ?? 0) + 1,
            }));
            setTab("triggers");
            break;
        }
      } else if (action.kind === "open-trigger") {
        setTriggersRequest((prev) => ({
          query: action.query,
          seq: (prev?.seq ?? 0) + 1,
        }));
        setTab("triggers");
      } else if (action.kind === "open-character-log") {
        const log = characters.find((c) => c.path === action.path);
        if (log) void changeCharacter(log);
        else void setActiveCharacter(action.server, action.character);
        setTab("live");
      }
    },
    [changeCharacter, characters],
  );

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
      // Hiding while arranging is a lock: clear the backend arrange latch
      // FIRST (see overlaySetArranging) so it can't linger and fight the
      // next show/lock pass.
      if (!next && !overlaysLocked) {
        await overlaySetArranging(false);
      }
      for (const label of OVERLAYS) {
        if (next) {
          await overlayShow(label);
          await overlaySetClickThrough(label, overlaysLocked);
        } else {
          await overlayHide(label);
        }
      }
      if (!next && !overlaysLocked) {
        saveOverlayArrange(false);
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
    saveOverlayArrange(!nextLocked);
    setError(null);
    try {
      if (!nextLocked) {
        // Arranging: the backend reveals + unlocks every overlay and latches a
        // guard so a drag that shifts focus can't re-lock the rest.
        setOverlaysOn(true);
        await overlaySetArranging(true);
      } else {
        // Leaving arrange: clear the guard FIRST so the lock pass below takes.
        await overlaySetArranging(false);
        const vis = loadOverlayVisibility();
        setOverlaysOn(OVERLAYS.some((label) => vis[label]));
        for (const label of OVERLAYS) {
          if (vis[label]) await overlayShow(label);
          else await overlayHide(label);
          await overlaySetClickThrough(label, true);
        }
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
                  title={t.label}
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
          <div className="identity-switch">
            {characters.length > 1 ? (
              <label
                className="char-switch"
                title="Active character — switching points the app at that character's log and profile"
              >
                <span className="topbar-label">Character</span>
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
                <span className="topbar-label">Loadout</span>
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
          </div>
          <button
            className="ghost small global-search-button"
            onClick={() => openGlobalSearch()}
            title="Global search (Ctrl+K, Ctrl+F, /)"
          >
            Search
            <span className="key-hint">Ctrl K</span>
          </button>
          <div className="topbar-menu" ref={liveMenuRef}>
            <button
              className="ghost small live-menu-button"
              onClick={() => {
                setSessionMenuOpen(false);
                setOverlayMenuOpen(false);
                setLiveMenuOpen((o) => !o);
              }}
              title="Live log and live-context controls"
              aria-expanded={liveMenuOpen}
            >
              <span className={`status-dot${tailing ? " live" : ""}`} />
              {tailing ? "Live" : "Idle"}
            </button>
            {liveMenuOpen && (
              <div className="topbar-popover live-popover" role="menu">
                <div className="topbar-popover-row">
                  <span className="popover-label">Log tail</span>
                  <strong>{tailing ? "Live" : "Idle"}</strong>
                </div>
                <div className="topbar-popover-row">
                  <span className="popover-label">Detected zone</span>
                  <strong>{liveZoneName || currentZone || "Unknown"}</strong>
                </div>
                <label
                  className={`live-feature-row${!liveZoneName && !currentZone ? " disabled" : ""}`}
                  title="When on, database views and search follow your current in-game zone"
                >
                  <span className="live-feature-copy">
                    <strong>Auto zone change</strong>
                    <span>Keep search, drops, mobs, recipes, spells, and timers synced to your current zone.</span>
                  </span>
                  <input
                    type="checkbox"
                    className="switch live-feature-switch"
                    checked={liveZoneEnabled}
                    disabled={!liveZoneName && !currentZone}
                    onChange={(e) => setLiveZoneEnabled(e.target.checked)}
                    aria-label="Auto zone change"
                  />
                </label>
              </div>
            )}
          </div>
          {catchingUp && (
            <span
              className="catchup-badge"
              title="The log jumped backwards (replayed content). Speech, sounds, timers and fight-history writes are paused until the session is back at the live edge; meters keep counting."
            >
              Catching up — alerts paused
            </span>
          )}
          <span className="spacer" />
          <div className="topbar-menu" ref={sessionMenuRef}>
            <button
              className="ghost small"
              onClick={() => {
                setLiveMenuOpen(false);
                setOverlayMenuOpen(false);
                setSessionMenuOpen((o) => !o);
              }}
              title="Tailing controls — start/stop following the log, silence audio"
              aria-expanded={sessionMenuOpen}
            >
              {tailing ? <IconStop /> : <IconPlay />}
              Tailing
            </button>
            {sessionMenuOpen && (
              <div className="topbar-popover" role="menu">
                <button className="ghost small" onClick={toggleTailing}>
                  {tailing ? <IconStop /> : <IconPlay />}
                  {tailing ? "Stop tailing" : "Start tailing"}
                </button>
                <button
                  className="ghost small"
                  onClick={() => void doSilence()}
                  title="Silence — stop the current speech and drop queued alerts (Esc Esc here, Ctrl+Alt+S anywhere — even with the game focused)"
                >
                  <IconSpeakerOff />
                  Silence audio
                </button>
                {unclassifiedPct > CANARY_PCT && (
                  <button
                    className="ghost small"
                    onClick={() => setTab("settings")}
                    title="Check for app and reference-data updates"
                  >
                    <IconWarn />
                    {unclassifiedPct.toFixed(1)}% unrecognized
                  </button>
                )}
              </div>
            )}
          </div>
          <div className="topbar-menu" ref={overlayMenuRef}>
            <button
              className="ghost small"
              onClick={() => {
                setLiveMenuOpen(false);
                setSessionMenuOpen(false);
                setOverlayMenuOpen((o) => !o);
              }}
              title="Overlay controls"
              aria-expanded={overlayMenuOpen}
            >
              {overlaysOn ? <IconEye /> : <IconEyeOff />}
              Overlays
            </button>
            {overlayMenuOpen && (
              <div className="topbar-popover" role="menu">
                <button className="ghost small" onClick={toggleOverlays}>
                  {overlaysOn ? <IconEyeOff /> : <IconEye />}
                  {overlaysOn ? "Hide overlays" : "Show overlays"}
                </button>
                <button
                  className="ghost small"
                  onClick={toggleOverlayLock}
                  disabled={!overlaysOn && overlaysLocked}
                >
                  {overlaysLocked ? <IconUnlock /> : <IconLock />}
                  {overlaysLocked ? "Arrange overlays" : "Lock overlays"}
                </button>
                <button
                  className="ghost small"
                  onClick={() => {
                    setOverlayMenuOpen(false);
                    setSettingsSectionRequest((prev) => ({
                      section: "overlays",
                      seq: (prev?.seq ?? 0) + 1,
                    }));
                    setTab("settings");
                  }}
                >
                  <IconSettings />
                  Overlay settings
                </button>
              </div>
            )}
          </div>
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
                onClick={() => {
                  setSettingsSectionRequest((prev) => ({
                    section: "updates",
                    seq: (prev?.seq ?? 0) + 1,
                  }));
                  setTab("settings");
                }}
                disabled={installing}
                title="Patch notes — what changed in recent releases"
              >
                What’s new
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
          {suggestedLog && (
            <div className="session-banner" role="status">
              <span className="session-banner-text">
                <strong>Newer active log detected</strong> - switch to{" "}
                {suggestedLog.character} / {suggestedLog.server}?
              </span>
              <button
                className="primary small"
                onClick={() => void changeCharacter(suggestedLog)}
              >
                Switch
              </button>
              <button
                className="ghost small"
                onClick={() => {
                  setDismissedLogPath(suggestedLog.path);
                  setSuggestedLog(null);
                }}
              >
                Not now
              </button>
            </div>
          )}
          {hailCard && (
            <div className="hail-card" role="status">
              <span className="hail-card-main">
                <strong>Hail:</strong> {hailCard.name}
                {hailQuests.length > 0 && (
                  <small>{hailQuests.length} quest{hailQuests.length === 1 ? "" : "s"}: {hailQuests.slice(0, 3).map((quest) => quest.name).join(", ")}</small>
                )}
              </span>
              {hailQuests.length > 0 && (
                <button
                  className="primary small"
                  onClick={() => {
                    setQuestsRequest((prev) => ({ query: hailCard.name, seq: (prev?.seq ?? 0) + 1 }));
                    setTab("quests");
                  }}
                >
                  Quests ({hailQuests.length})
                </button>
              )}
              <button
                className="ghost small"
                onClick={() => {
                  setMobsRequest((prev) => ({
                    query: hailCard.name,
                    seq: (prev?.seq ?? 0) + 1,
                  }));
                  setTab("mobs");
                }}
              >
                Mobs
              </button>
              <button
                className="ghost small"
                onClick={() => {
                  setDropsRequest((prev) => ({
                    query: hailCard.name,
                    seq: (prev?.seq ?? 0) + 1,
                  }));
                  setTab("drops");
                }}
              >
                Drops
              </button>
              <a
                className="ghost small button-link"
                href={`https://www.google.com/search?q=${encodeURIComponent(`EverQuest Legends ${hailCard.name}`)}`}
                target="_blank"
                rel="noreferrer"
              >
                Web
              </a>
              <button className="ghost small" onClick={() => setHailCard(null)}>
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
                // The user just picked a log to follow — start tailing right
                // away instead of pointing at the collapsed Tailing menu.
                void startTailingNow().then((ok) => {
                  if (ok) showToast(`Following ${name}'s log`);
                });
              }}
              onOpenSettings={() => setTab("settings")}
            />
          )}
          {!needsSetup && (
            <WelcomeBack
              character={character}
              level={profile?.level ?? null}
              catchingUp={catchingUp}
              onOpenSession={() => setTab("coach")}
            />
          )}
          <section className={`page page-live${tab === "live" ? "" : " hidden"}`}>
            <LiveTab
              character={character}
              searchRequest={liveRequest}
              tailing={tailing}
              onStartTailing={() => void startTailingNow()}
            />
          </section>
          <section className={`page${tab === "meters" ? "" : " hidden"}`}>
            <MetersTab character={character} />
          </section>
          <section className={`page${tab === "fights" ? "" : " hidden"}`}>
            <FightsTab character={character} />
          </section>
          <section className={`page${tab === "timers" ? "" : " hidden"}`}>
            <TimersTab />
          </section>
          <section className={`page${tab === "coach" ? "" : " hidden"}`}>
            <CoachTab character={character} />
          </section>
          <section className={`page${tab === "diagnostics" ? "" : " hidden"}`}>
            <DiagnosticsTab />
          </section>
          <section className={`page${tab === "drops" ? "" : " hidden"}`}>
            {visited.has("drops") && <DropsTab searchRequest={dropsRequest} />}
          </section>
          <section className={`page${tab === "mobs" ? "" : " hidden"}`}>
            {visited.has("mobs") && <MobsTab searchRequest={mobsRequest} />}
          </section>
          <section className={`page${tab === "quests" ? "" : " hidden"}`}>
            {visited.has("quests") && <QuestsTab character={character} searchRequest={questsRequest} />}
          </section>
          <section className={`page${tab === "recipes" ? "" : " hidden"}`}>
            {visited.has("recipes") && (
              <RecipesTab searchRequest={recipesRequest} />
            )}
          </section>
          <section className={`page${tab === "spells" ? "" : " hidden"}`}>
            {visited.has("spells") && (
              <SpellsTab searchRequest={spellsRequest} />
            )}
          </section>
          <section className={`page${tab === "macros" ? "" : " hidden"}`}>
            {visited.has("macros") && <MacrosTab />}
          </section>
          <section className={`page${tab === "triggers" ? "" : " hidden"}`}>
            <TriggersTab character={character} searchRequest={triggersRequest} />
          </section>
          <section className={`page${tab === "settings" ? "" : " hidden"}`}>
            <SettingsTab
              onCharacterChange={setCharacter}
              sectionRequest={settingsSectionRequest}
            />
          </section>
        </div>
      </div>
      <DingDigest
        classes={
          profile?.loadouts.find((l) => l.name === profile.active_loadout)
            ?.classes ?? []
        }
        catchingUp={catchingUp}
      />
      {toastNode}
      {globalSearch && (
        <GlobalSearchModal
          key={globalSearch.seq}
          initialQuery={globalSearch.query}
          reason={globalSearch.reason}
          currentZone={
            liveZoneEnabled ? liveZoneName || currentZone : null
          }
          onClose={() => setGlobalSearch(null)}
          onAction={handleGlobalSearchAction}
        />
      )}
    </div>
  );
}
