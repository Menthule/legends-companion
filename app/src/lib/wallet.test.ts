import { describe, expect, it } from "vitest";
import type { Coins } from "../types";
import {
  applyWalletGain,
  coinsFromCopper,
  emptyWallet,
  fmtCoins,
  fmtCopperAmount,
  platFromCopper,
  totalCopper,
  WALLET_GAIN_CAP,
  walletGainFromEvent,
  walletPlatPerHour,
  type WalletState,
} from "./wallet";

const HOUR = 3_600_000;

function coins(platinum = 0, gold = 0, silver = 0, copper = 0): Coins {
  return { platinum, gold, silver, copper };
}

function gain(
  state: WalletState,
  c: Coins,
  atMs: number,
  source: "CorpseLoot" | "VendorSale" | "ItemSale" | "AutoSell" = "CorpseLoot",
): WalletState {
  return applyWalletGain(state, {
    id: state.count,
    ts: atMs / 1000,
    atMs,
    source,
    coins: c,
    note: null,
  });
}

describe("coin math", () => {
  it("total_copper mirrors the Rust helper (1p=10g=100s=1000c)", () => {
    // Verified corpse line: 1p 8g 9s 6c.
    expect(totalCopper(coins(1, 8, 9, 6))).toBe(1896);
    expect(totalCopper(coins())).toBe(0);
  });

  it("round-trips copper through denominations", () => {
    expect(coinsFromCopper(1896)).toEqual(coins(1, 8, 9, 6));
    expect(coinsFromCopper(0)).toEqual(coins());
    expect(totalCopper(coinsFromCopper(123456))).toBe(123456);
  });

  it("formats coins with zero denominations skipped", () => {
    expect(fmtCoins(coins(1, 8, 9, 6))).toBe("1p 8g 9s 6c");
    expect(fmtCoins(coins(4))).toBe("4p");
    expect(fmtCoins(coins(0, 0, 2, 0))).toBe("2s");
    // "...sold it for free." arrives as all-zero Coins.
    expect(fmtCoins(coins())).toBe("0c");
    expect(fmtCopperAmount(1896)).toBe("1p 8g 9s 6c");
  });

  it("converts copper to fractional platinum", () => {
    expect(platFromCopper(1500)).toBe(1.5);
  });
});

describe("walletGainFromEvent", () => {
  it("decodes the three Money kinds", () => {
    const ev = {
      Money: { kind: "CorpseLoot", coins: coins(1, 8, 9, 6) },
    };
    expect(walletGainFromEvent(ev)).toEqual({
      source: "CorpseLoot",
      coins: coins(1, 8, 9, 6),
      note: null,
    });
    expect(
      walletGainFromEvent({ Money: { kind: "VendorSale", coins: coins(4) } })
        ?.source,
    ).toBe("VendorSale");
    expect(
      walletGainFromEvent({ Money: { kind: "ItemSale", coins: coins(0, 6) } })
        ?.source,
    ).toBe("ItemSale");
  });

  it("rejects malformed Money payloads", () => {
    expect(walletGainFromEvent({ Money: { kind: "Bribe", coins: coins(1) } })).toBeNull();
    expect(walletGainFromEvent({ Money: { kind: "CorpseLoot" } })).toBeNull();
    expect(walletGainFromEvent("System")).toBeNull();
    expect(walletGainFromEvent(null)).toBeNull();
  });

  it("extracts auto-sell proceeds from Loot.sold_for with the item as note", () => {
    const ev = {
      Loot: {
        looter: "You",
        item: "Rusty Warhammer +2",
        quantity: 1,
        corpse: "a lesser mummy",
        sold_for: coins(0, 1, 2, 9),
      },
    };
    expect(walletGainFromEvent(ev)).toEqual({
      source: "AutoSell",
      coins: coins(0, 1, 2, 9),
      note: "Rusty Warhammer +2",
    });
  });

  it("ignores Loot kept in inventory (sold_for null/absent)", () => {
    expect(
      walletGainFromEvent({
        Loot: { looter: "You", item: "Bone Chips", quantity: 4, sold_for: null },
      }),
    ).toBeNull();
    expect(
      walletGainFromEvent({
        Loot: { looter: "You", item: "Bone Chips", quantity: 4 },
      }),
    ).toBeNull();
  });

  it('keeps the "sold it for free" all-zero Coins as a real (0c) gain', () => {
    const g = walletGainFromEvent({
      Loot: { looter: "You", item: "Cracked Staff", quantity: 1, sold_for: coins() },
    });
    expect(g).not.toBeNull();
    expect(totalCopper(g!.coins)).toBe(0);
  });
});

describe("applyWalletGain", () => {
  it("accumulates totals, per-source buckets, and the biggest gain", () => {
    let w = emptyWallet();
    w = gain(w, coins(1, 8, 9, 6), 1000, "CorpseLoot"); // 1896c
    w = gain(w, coins(4), 2000, "VendorSale"); // 4000c
    w = gain(w, coins(0, 1, 2, 9), 3000, "AutoSell"); // 129c
    expect(w.totalCopper).toBe(6025);
    expect(w.bySource.CorpseLoot).toBe(1896);
    expect(w.bySource.VendorSale).toBe(4000);
    expect(w.bySource.AutoSell).toBe(129);
    expect(w.count).toBe(3);
    expect(w.biggest?.copper).toBe(4000);
    expect(w.firstAtMs).toBe(1000);
    // Newest first.
    expect(w.gains[0].source).toBe("AutoSell");
  });

  it("a free (0c) sale counts as a gain but never becomes the biggest", () => {
    let w = emptyWallet();
    w = gain(w, coins(), 1000, "AutoSell");
    expect(w.count).toBe(1);
    expect(w.biggest).toBeNull();
  });

  it("caps the gains list without losing totals", () => {
    let w = emptyWallet();
    for (let i = 0; i < WALLET_GAIN_CAP + 10; i++) {
      w = gain(w, coins(0, 0, 0, 1), 1000 + i);
    }
    expect(w.gains.length).toBe(WALLET_GAIN_CAP);
    expect(w.totalCopper).toBe(WALLET_GAIN_CAP + 10);
    expect(w.count).toBe(WALLET_GAIN_CAP + 10);
  });
});

describe("walletPlatPerHour", () => {
  it("is null with no gains or under a minute of data", () => {
    expect(walletPlatPerHour(emptyWallet(), 1000)).toBeNull();
    const w = gain(emptyWallet(), coins(1), 1000);
    expect(walletPlatPerHour(w, 1000 + 59_000)).toBeNull();
  });

  it("rates platinum over wall time since the first gain", () => {
    let w = gain(emptyWallet(), coins(1), 0); // 1p
    w = gain(w, coins(2), HOUR / 2); // +2p
    // 3p over one hour.
    expect(walletPlatPerHour(w, HOUR)).toBeCloseTo(3, 10);
  });
});
