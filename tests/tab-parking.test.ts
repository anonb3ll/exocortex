import { describe, expect, test } from "bun:test";
import {
  addOwnedParkedGroupId,
  isTabEligibleForParking,
  normalizeOwnedParkedGroupIds,
  normalizeTabContextSignals,
  selectTabsToPark
} from "../src/lib/focus-shield/tab-parking";

describe("Focus Shield tab parking policy", () => {
  test("normalizes persisted group ownership and avoids duplicate ids", () => {
    expect(normalizeOwnedParkedGroupIds([12, 12, -1, 3.5, "12", 7])).toEqual([12, 7]);
    expect(addOwnedParkedGroupId([12, 7], 12)).toEqual([12, 7]);
    expect(addOwnedParkedGroupId([12, 7], 19)).toEqual([12, 7, 19]);
  });

  test("normalizes persisted tab classifications by tab id", () => {
    expect(normalizeTabContextSignals([
      { tabId: 4, intentCategory: "Research & Gathering", url: "https://old.test", title: "Old" },
      { tabId: 4, intentCategory: "Distraction / Rabbit Hole", url: "https://current.test", title: "Current" },
      { tabId: -1, intentCategory: "Distraction / Rabbit Hole", url: "https://invalid.test", title: "Invalid" },
      { tabId: 7, intentCategory: "Research & Gathering", url: "", title: "Invalid" }
    ])).toEqual([
      { tabId: 4, intentCategory: "Distraction / Rabbit Hole", url: "https://current.test", title: "Current" }
    ]);
  });

  test("selects only known distraction tabs", () => {
    expect(
      selectTabsToPark([
        { id: 1, active: true, url: "https://work.test", intentCategory: "Distraction / Rabbit Hole" },
        { id: 2, url: "https://rabbit.test", classifiedUrl: "https://rabbit.test", intentCategory: "Distraction / Rabbit Hole" },
        { id: 3, url: "https://docs.test", classifiedUrl: "https://docs.test", intentCategory: "Research & Gathering" }
      ], 1)
    ).toEqual([2]);
  });

  test("never parks pinned, grouped, special-scheme, or non-distraction tabs", () => {
    const excluded = [
      { id: 1, pinned: true, url: "https://x.test", classifiedUrl: "https://x.test", intentCategory: "Distraction / Rabbit Hole" },
      { id: 2, groupId: 7, url: "https://x.test", classifiedUrl: "https://x.test", intentCategory: "Distraction / Rabbit Hole" },
      { id: 3, url: "chrome://settings", intentCategory: "Distraction / Rabbit Hole" },
      { id: 4, url: "https://x.test", classifiedUrl: "https://x.test", intentCategory: "Research & Gathering" }
    ];
    expect(excluded.every((tab) => !isTabEligibleForParking(tab))).toBe(true);
  });

  test("rejects a distraction classification from a previous URL", () => {
    expect(
      isTabEligibleForParking({
        id: 5,
        url: "https://current.test",
        classifiedUrl: "https://previous.test",
        intentCategory: "Distraction / Rabbit Hole"
      })
    ).toBe(false);
  });
});
