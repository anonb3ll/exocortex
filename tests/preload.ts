// Test preload: install fake-indexeddb globally before any test imports.
// This must run before db.ts is loaded so Dexie auto-detects the polyfill.
import "fake-indexeddb/auto";

// Dexie is imported dynamically, and it must stay that way. Dexie snapshots the
// IndexedDB implementation into `Dexie.dependencies` when its own module
// evaluates, and under Bun a *static* `import Dexie from "dexie"` on the line
// below evaluates before the polyfill side effect above has landed — the import
// order in the source is not the evaluation order. Writing this file with a
// static import made the guard below fire on every one of the 24 test files.
// The shipped MCP entrypoint has exactly the same constraint and the same fix;
// see the comment in `src/mcp/cli.ts`.
//
// Awaiting it here also pins the moment Dexie captures its dependencies to the
// line after the polyfill, so the ordering is a property of the harness rather
// than of whichever test file Bun happened to load first.
const Dexie = (await import("dexie")).default;

// Sentinel read by `tests/environment-guard.test.ts`. A preload that silently
// did not run is indistinguishable, from inside a failing test, from a database
// that is genuinely empty — the same invisible-failure class the MCP source
// envelope exists to close, one layer down.
(globalThis as Record<string, unknown>).__EXOCORTEX_TEST_PRELOAD__ = true;

if (typeof globalThis.indexedDB !== "object" || globalThis.indexedDB === null) {
  throw new Error(
    "Test preload ran but did not install an IndexedDB polyfill. " +
      "`fake-indexeddb/auto` is present in tests/preload.ts, so this means the " +
      "package is missing, broken, or changed its auto-install behaviour. " +
      "Every Dexie-backed test would otherwise fail with an unrelated-looking " +
      "MissingAPIError.",
  );
}

if (!Dexie.dependencies?.indexedDB) {
  throw new Error(
    "Dexie captured no IndexedDB implementation despite the polyfill being " +
      "installed. Something imported `dexie` before this preload ran, which " +
      "silently breaks every db.open() in the suite.",
  );
}
