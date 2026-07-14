import { describe, expect, it } from "vitest";
import macros from "./macros.json";

describe("macro library", () => {
  it("keeps the pet-mez state commands in their required order", () => {
    const macro = macros.find((entry) => entry.name === "Pet Tank (Hold and Stop)");

    expect(macro).toBeDefined();
    expect(macro?.category).toBe("Pet");
    expect(macro?.lines).toEqual([
      "/pet guard",
      "/pause 5, /pet hold on",
      "/pause 5, /pet back off",
      "/pet stop",
    ]);
    expect(macro?.tips).toContain("/pet ghold on");
    expect(macro?.tips).toContain("not /pet guard here");
  });

  it("ships the paired resume macro that explicitly attacks", () => {
    const macro = macros.find((entry) => entry.name === "Resume Pet from Hold");

    expect(macro?.lines).toEqual(["/pet attack"]);
  });
});
