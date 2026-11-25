/**
 * Turns a misconfigured test run into one named diagnosis.
 *
 * `bunfig.toml` declares `preload = ["./tests/preload.ts"]`, and Bun resolves
 * bunfig relative to the current working directory — not to the test files it
 * was handed. Run `bun test` from a parent directory rather than the repo root and
 * the preload never executes, no IndexedDB polyfill is installed, and roughly
 * twenty Dexie-backed tests die with `MissingAPIError: IndexedDB API missing`.
 *
 * Nothing in that output names the actual cause. It reads exactly like a real
 * database failure, which is how a fifteen-second cwd mistake turns into an
 * afternoon of debugging Dexie. This file cannot prevent those failures — by
 * the time it runs the preload has already been skipped — but it stands beside
 * them saying which mistake was made.
 *
 * The guard inside `tests/preload.ts` is the complement to this one: it catches
 * a preload that ran and did not work. This catches a preload that never ran.
 * Neither can catch the other's case, which is why both exist.
 */

import { expect, test } from "bun:test";

test("the test preload actually ran — run `bun test` from the repo root", () => {
  const preloadRan = (globalThis as Record<string, unknown>).__EXOCORTEX_TEST_PRELOAD__ === true;

  expect(
    preloadRan,
    "tests/preload.ts did not run, so fake-indexeddb was never installed and " +
      "every Dexie-backed test in this run will fail with MissingAPIError. " +
      "Bun reads bunfig.toml (which declares the preload) relative to the " +
      "current working directory. Fix: cd into the repository root and re-run " +
      "`bun test` there.",
  ).toBe(true);
});

test("an IndexedDB implementation is reachable before any suite opens a database", () => {
  expect(
    typeof globalThis.indexedDB,
    "No IndexedDB implementation is present. See the preceding test for the " +
      "usual cause (wrong working directory).",
  ).toBe("object");
});
