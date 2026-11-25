import { defineConfig } from "vite";
import { resolve } from "path";

// The content script gets its own single-input pass so it can be emitted with
// `codeSplitting: false` — rolldown rejects that option when a build has
// multiple inputs, and with splitting on, tracker.ts and the service worker
// share a chunk, which makes dist/content.js start with an `import`. Chrome
// injects content scripts as classic scripts (content_scripts entries take no
// "type": "module"), so that import throws at injection time and nothing on the
// page is ever captured.
//
// Runs after the main build with emptyOutDir disabled, so it adds to dist/
// instead of wiping it.
export default defineConfig({
  build: {
    rolldownOptions: {
      input: {
        content: resolve(__dirname, "src/content/tracker.ts")
      },
      output: {
        entryFileNames: "[name].js",
        assetFileNames: "[name].[ext]",
        codeSplitting: false
      }
    },
    outDir: "dist",
    emptyOutDir: false
  }
});
