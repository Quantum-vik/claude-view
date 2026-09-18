import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  // Tauri conventions
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "es2021",
    // don't minify for debuggability during development
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    // produce sourcemaps for debug builds
    sourcemap: !!process.env.TAURI_DEBUG,
    // Vite's default 500 kB warning is calibrated for the WEB, where the bundle
    // crosses a network and gzip size is the metric that matters. This is a
    // Tauri desktop app: the bundle is read from local disk through the asset
    // protocol, page-cached after the first window, and never transferred. The
    // warning therefore fires on every build for a cost this app does not pay,
    // which only teaches people to skim past build warnings.
    //
    // Measured composition of the 709 kB (by splitting it and reading the
    // output): xterm 428 kB (60%), react 142 kB (20%), app code 135 kB (19%),
    // tauri 1.4 kB. So it is mostly the terminal emulator, and it is not
    // accidental bloat.
    //
    // 800 rather than Infinity: the number is a tripwire, not a dismissal. If
    // this build crosses it, something genuinely unexpected has been added and
    // the warning should fire again.
    //
    // There IS one real inefficiency this does not address: AgentWindow.tsx
    // renders no terminal — "a run has no terminal" — yet every import is
    // static, so an agent window parses all 428 kB of xterm anyway. Making
    // Terminal a lazy() import would fix that. It is left undone deliberately:
    // two attempts to measure the cost came back below the noise floor
    // (chromium's ~550 ms process launch swamps script evaluation), so there is
    // no evidence it is worth the indirection. Revisit if window opens are ever
    // observed to be slow.
    chunkSizeWarningLimit: 800,
  },
});
