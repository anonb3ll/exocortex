/**
 * Layer 1: the manifest/artifact contract.
 *
 * This is the layer that would have caught the shipped bug. `bun run build`
 * was green for four phases while `dist/content.js` was unloadable in Chrome:
 * it was emitted with a leading ESM import, and an MV3 content script is
 * injected as a CLASSIC script, which cannot execute one. The sensor layer
 * never ran on any page.
 *
 * No compiler catches this. The build succeeded because the output was valid
 * ESM — what was wrong was the contract between the artifact and the manifest.
 * `content_scripts` entries take no `"type": "module"`, so the emitted file
 * must parse as a classic script.
 */

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import vm from "node:vm";

const ROOT = resolve(import.meta.dir, "..");
const DIST = join(ROOT, "dist");

function distMissing(): boolean {
  return !existsSync(join(DIST, "manifest.json"));
}

function getNewestSourceMtime(dirPath: string): number {
  let maxMtime = 0;
  if (!existsSync(dirPath)) return maxMtime;

  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const stat = statSync(fullPath);
        if (stat.mtimeMs > maxMtime) {
          maxMtime = stat.mtimeMs;
        }
      }
    }
  }
  walk(dirPath);

  for (const configName of ["public/manifest.json", "vite.config.ts", "vite.content.config.ts", "package.json"]) {
    const configPath = join(ROOT, configName);
    if (existsSync(configPath)) {
      const stat = statSync(configPath);
      if (stat.mtimeMs > maxMtime) {
        maxMtime = stat.mtimeMs;
      }
    }
  }

  return maxMtime;
}

describe("manifest/artifact contract", () => {
  test("dist/ exists — run `bun run build` first", () => {
    expect(distMissing()).toBe(false);
  });

  test("dist/ is fresh — run `bun run build` if stale", () => {
    if (distMissing()) return;

    const distMtime = statSync(join(DIST, "manifest.json")).mtimeMs;
    const newestSrc = getNewestSourceMtime(join(ROOT, "src"));

    const isStale = newestSrc > distMtime;
    if (isStale) {
      expect.unreachable(
        `dist/ is stale (src modified after last build). Run 'bun run build' to update dist/.`
      );
    }
    expect(isStale).toBe(false);
  });

  test("every file the manifest references was actually emitted", () => {
    const manifest = JSON.parse(readFileSync(join(DIST, "manifest.json"), "utf8"));

    const referenced: string[] = [];
    if (manifest.background?.service_worker) referenced.push(manifest.background.service_worker);
    if (manifest.side_panel?.default_path) referenced.push(manifest.side_panel.default_path);
    if (manifest.action?.default_popup) referenced.push(manifest.action.default_popup);
    for (const entry of manifest.content_scripts ?? []) {
      referenced.push(...(entry.js ?? []), ...(entry.css ?? []));
    }
    for (const icon of Object.values(manifest.icons ?? {})) referenced.push(icon as string);

    expect(referenced.length).toBeGreaterThan(0);
    const missing = referenced.filter((p) => !existsSync(join(DIST, p)));
    expect(missing).toEqual([]);
  });

  test("content script parses as a CLASSIC script — the bug that shipped", () => {
    // package.json is "type": "module", so a bare `node --check dist/content.js`
    // parses it as ESM and proves nothing. Copy to .cjs to force a classic parse,
    // which is what Chrome does when it injects a content script.
    const source = readFileSync(join(DIST, "content.js"), "utf8");
    const scratch = mkdtempSync(join(tmpdir(), "exocortex-contract-"));
    const asClassic = join(scratch, "content.cjs");
    writeFileSync(asClassic, source);

    try {
      execFileSync("node", ["--check", asClassic], { stdio: "pipe" });
    } catch (e: any) {
      if (e?.code === "ENOENT") {
        // Fallback to in-process Script compilation for classic script syntax check
        expect(() => new vm.Script(source)).not.toThrow();
      } else {
        throw e;
      }
    }
  });

  test("content script has no top-level import/export statement", () => {
    // Belt and braces alongside the parse check: names the defect directly, so
    // a failure reads as "the module boundary came back" rather than a generic
    // syntax error.
    const source = readFileSync(join(DIST, "content.js"), "utf8");
    const topLevelModuleSyntax = /^\s*(?:import\s|export\s|import\{|export\{)/m;
    expect(source).not.toMatch(topLevelModuleSyntax);
  });

  test("production bundle in dist/ contains no fake-indexeddb import or implementation", () => {
    // Architectural invariant (task #683): fake-indexeddb is test-only.
    // Bundling it in production previously shadowed the real IndexedDB global
    // and crashed the service worker in Chrome.
    const jsFiles: string[] = [];
    (function walk(dir: string) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) walk(fullPath);
        else if (entry.name.endsWith(".js")) jsFiles.push(fullPath);
      }
    })(DIST);

    expect(jsFiles.length).toBeGreaterThan(0);

    for (const filePath of jsFiles) {
      const code = readFileSync(filePath, "utf8");
      expect(code).not.toContain("fake-indexeddb");
      expect(code).not.toContain("FDBFactory");
      expect(code).not.toContain("FDBDatabase");
      expect(code).not.toContain("FDBTransaction");
    }
  });

  test("every chrome.* API the source calls is covered by a declared permission", () => {
    // The second shipped bug of exactly this shape. src/ called chrome.offscreen,
    // the shipped manifest never declared "offscreen", so the API was undefined at
    // runtime — setupOffscreenDocument() returned early and every embedding came
    // back empty. Nothing failed: not the build, not tsc (@types/chrome types the
    // API regardless of the manifest), not a single test. Same class of defect as
    // the dead content script — a contract between artifact and manifest that no
    // compiler checks.
    //
    // Only APIs that actually require a permission entry are listed. chrome.runtime,
    // chrome.i18n and chrome.extension need none, so their absence here is correct.
    const API_TO_PERMISSION: Record<string, string> = {
      tabs: "tabs",
      storage: "storage",
      sidePanel: "sidePanel",
      scripting: "scripting",
      offscreen: "offscreen",
      alarms: "alarms",
      bookmarks: "bookmarks",
      history: "history",
      downloads: "downloads",
      notifications: "notifications",
      idle: "idle",
      cookies: "cookies",
      contextMenus: "contextMenus",
      webNavigation: "webNavigation",
      declarativeNetRequest: "declarativeNetRequest",
      topSites: "topSites",
      management: "management",
      tabGroups: "tabGroups"
    };

    const sources: string[] = [];
    (function walk(dir: string) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) walk(fullPath);
        else if (entry.name.endsWith(".ts")) sources.push(readFileSync(fullPath, "utf8"));
      }
    })(join(ROOT, "src"));
    const allSource = sources.join("\n");

    const manifest = JSON.parse(readFileSync(join(DIST, "manifest.json"), "utf8"));
    const declared: string[] = manifest.permissions ?? [];

    const required = new Set<string>();
    for (const [api, permission] of Object.entries(API_TO_PERMISSION)) {
      if (new RegExp(`\\bchrome\\.${api}\\b`).test(allSource)) required.add(permission);
    }
    // Native messaging is a method on chrome.runtime, not an API namespace.
    // Both entry points need the permission: connectNative (the MCP bridge) and
    // sendNativeMessage (the optional omaCortex feed).
    if (/\bchrome\.runtime\.(connectNative|sendNativeMessage)\b/.test(allSource)) required.add("nativeMessaging");

    expect(required.size).toBeGreaterThan(0);
    const undeclared = [...required].filter((p) => !declared.includes(p));
    expect(undeclared).toEqual([]);
  });

  test("extension pages may execute WebAssembly", () => {
    // The offscreen document runs ONNX Runtime to produce MiniLM embeddings, and
    // instantiating its Wasm needs 'wasm-unsafe-eval'. MV3's default CSP is
    // script-src 'self', under which the embedder throws on first use and every
    // vector silently degrades to the hash-bag-of-words fallback forever.
    const manifest = JSON.parse(readFileSync(join(DIST, "manifest.json"), "utf8"));
    const csp: string = manifest.content_security_policy?.extension_pages ?? "";
    expect(csp).toContain("wasm-unsafe-eval");
  });

  test("the shipped manifest is the one under public/", () => {
    // A stale copy at the repo root used to declare permissions that the real,
    // shipped manifest lacked — so reading the obvious file showed a correct
    // manifest while Chrome loaded an incorrect one.
    const shipped = readFileSync(join(DIST, "manifest.json"), "utf8");
    const source = readFileSync(join(ROOT, "public", "manifest.json"), "utf8");
    expect(JSON.parse(shipped)).toEqual(JSON.parse(source));
    expect(existsSync(join(ROOT, "manifest.json"))).toBe(false);
  });

  test("content_scripts entries do not declare type: module", () => {
    // If someone "fixes" a future ESM-in-content-script error by adding this,
    // Chrome silently ignores it — MV3 content_scripts have no module support.
    const manifest = JSON.parse(readFileSync(join(DIST, "manifest.json"), "utf8"));
    for (const entry of manifest.content_scripts ?? []) {
      expect(entry.type).toBeUndefined();
    }
  });
});
