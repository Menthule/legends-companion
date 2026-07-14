// Session wallet: coin income accumulated from the "log-line" stream.
// Sources are the three verified Money line shapes (corpse coin, vendor
// sale, item redemption — see eqlog-core events.rs MoneyKind provenance)
// plus the auto-sell figure riding on Loot.sold_for ("...and sold it for
// 1 gold, 2 silver and 9 copper." / "...and sold it for free." = all-zero
// Coins; null = the item went to inventory/depot and earned nothing).
//
// Pure module (lib/pace.ts pattern): sessionLog feeds gains in, the Session
// tab's Wallet panel renders the immutable state. Nothing persists — coin
// history restarts with the app run, like loot and kills.

import type { Coins, EqEvent, MoneyKind } from "../types";

/** Where a coin gain came from: a Money line, or auto-sold loot. */
export type WalletSource = MoneyKind | "AutoSell";

export const WALLET_SOURCE_LABELS: Record<WalletSource, string> = {
  CorpseLoot: "Corpse coin",
  VendorSale: "Vendor sales",
  ItemSale: "Item redemptions",
  AutoSell: "Auto-sold loot",
};

export interface WalletGain {
  id: number;
  /** Log-domain seconds (display clock). */
  ts: number;
  /** Wall-clock ms when observed — anchors the plat/hour rate. */
  atMs: number;
  source: WalletSource;
  coins: Coins;
  /** totalCopper(coins), precomputed. */
  copper: number;
  /** Item name for vendor sales / auto-sell, when the line carried one. */
  note: string | null;
}

export interface WalletState {
  /** Session income in copper. */
  totalCopper: number;
  /** Copper per source. */
  bySource: Partial<Record<WalletSource, number>>;
  /** Newest first, capped at WALLET_GAIN_CAP. */
  gains: WalletGain[];
  /** Largest single gain this session (copper > 0), kept outside the cap. */
  biggest: WalletGain | null;
  /** All gains seen (not capped). */
  count: number;
  /** Wall-clock ms of the first gain — anchors plat/hour. */
  firstAtMs: number | null;
}

export const WALLET_GAIN_CAP = 200;
/** Under a minute of data the rate is meaningless noise (kills/hr rule). */
export const WALLET_RATE_MIN_MS = 60_000;

export function emptyWallet(): WalletState {
  return {
    totalCopper: 0,
    bySource: {},
    gains: [],
    biggest: null,
    count: 0,
    firstAtMs: null,
  };
}

/** Frontend twin of Rust `Coins::total_copper()` (1p = 10g = 100s = 1000c). */
export function totalCopper(c: Coins): number {
  return c.platinum * 1000 + c.gold * 100 + c.silver * 10 + c.copper;
}

/** Copper total back to denominations (largest-first carry). */
export function coinsFromCopper(copper: number): Coins {
  const c = Math.max(0, Math.floor(copper));
  return {
    platinum: Math.floor(c / 1000),
    gold: Math.floor((c % 1000) / 100),
    silver: Math.floor((c % 100) / 10),
    copper: c % 10,
  };
}

/** "1p 8g 9s 6c" with zero denominations skipped; all-zero renders "0c". */
export function fmtCoins(c: Coins): string {
  const parts: string[] = [];
  if (c.platinum > 0) parts.push(`${c.platinum}p`);
  if (c.gold > 0) parts.push(`${c.gold}g`);
  if (c.silver > 0) parts.push(`${c.silver}s`);
  if (c.copper > 0) parts.push(`${c.copper}c`);
  return parts.length > 0 ? parts.join(" ") : "0c";
}

export function fmtCopperAmount(copper: number): string {
  return fmtCoins(coinsFromCopper(copper));
}

/** Copper → platinum (fractional). */
export function platFromCopper(copper: number): number {
  return copper / 1000;
}

function validCoins(value: unknown): Coins | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const num = (x: unknown) =>
    typeof x === "number" && Number.isFinite(x) && x >= 0 ? Math.floor(x) : 0;
  const hasAny = ["platinum", "gold", "silver", "copper"].some(
    (k) => k in raw,
  );
  if (!hasAny) return null;
  return {
    platinum: num(raw.platinum),
    gold: num(raw.gold),
    silver: num(raw.silver),
    copper: num(raw.copper),
  };
}

const MONEY_KINDS: readonly string[] = ["CorpseLoot", "VendorSale", "ItemSale"];

/**
 * Extract a coin gain from a serde-encoded eqlog-core event:
 * `{"Money":{"kind":"CorpseLoot","coins":{...}}}` or a Loot event whose
 * `sold_for` is non-null (all-zero Coins = "sold it for free"). Returns null
 * for everything else, including Loot kept in inventory (`sold_for: null`).
 */
export function walletGainFromEvent(
  ev: EqEvent | unknown,
): { source: WalletSource; coins: Coins; note: string | null } | null {
  if (typeof ev !== "object" || ev === null) return null;
  const rec = ev as Record<string, unknown>;
  if ("Money" in rec) {
    const d = rec.Money as Record<string, unknown> | null;
    const kind = d?.kind;
    const coins = validCoins(d?.coins);
    if (typeof kind === "string" && MONEY_KINDS.includes(kind) && coins) {
      return { source: kind as MoneyKind, coins, note: null };
    }
    return null;
  }
  if ("Loot" in rec) {
    const d = rec.Loot as Record<string, unknown> | null;
    const coins = validCoins(d?.sold_for);
    if (!coins) return null;
    const item = typeof d?.item === "string" ? d.item : null;
    return { source: "AutoSell", coins, note: item };
  }
  return null;
}

/** Fold a gain into the wallet (immutable). */
export function applyWalletGain(
  state: WalletState,
  gain: Omit<WalletGain, "copper">,
): WalletState {
  const copper = totalCopper(gain.coins);
  const full: WalletGain = { ...gain, copper };
  return {
    totalCopper: state.totalCopper + copper,
    bySource: {
      ...state.bySource,
      [gain.source]: (state.bySource[gain.source] ?? 0) + copper,
    },
    gains: [full, ...state.gains].slice(0, WALLET_GAIN_CAP),
    biggest:
      copper > 0 && copper > (state.biggest?.copper ?? 0)
        ? full
        : state.biggest,
    count: state.count + 1,
    firstAtMs: state.firstAtMs ?? gain.atMs,
  };
}

/** Live plat/hour over wall time since the first gain; null under a minute
 *  of data (same honesty rule as the kills/hour column). */
export function walletPlatPerHour(
  state: WalletState,
  nowMs: number,
): number | null {
  if (state.firstAtMs === null) return null;
  const elapsedMs = nowMs - state.firstAtMs;
  if (elapsedMs < WALLET_RATE_MIN_MS) return null;
  return platFromCopper(state.totalCopper) / (elapsedMs / 3_600_000);
}
