import { defineConfig } from "vite";
import { resolve } from "path";

// Module-context entries: the MV3 service worker is declared `"type": "module"`
// and the popup/sidepanel/offscreen are HTML pages, so ESM imports and shared
// chunks are fine here.
//
// The content script is NOT built here — see vite.content.config.ts. A content
// script is injected as a classic script, so any `import` in it throws
// "Cannot use import statement outside a module" and the sensor layer dies.
//
// There is also no `mcp` entry: the MCP bridge is a bun stdio process
// (registered as `bun src/mcp/cli.ts`), not a browser bundle. Bundling it here
// produced a 16-byte dist/mcp.js stub that silently did nothing if registered.
export default defineConfig({
  build: {
    rolldownOptions: {
      input: {
        popup: resolve(__dirname, "src/popup/popup.html"),
        sidepanel: resolve(__dirname, "src/sidepanel/sidepanel.html"),
        background: resolve(__dirname, "src/background/service-worker.ts"),
        offscreen: resolve(__dirname, "src/offscreen/offscreen.html")
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "[name].[ext]"
      }
    },
    outDir: "dist",
    emptyOutDir: true
  }
});
