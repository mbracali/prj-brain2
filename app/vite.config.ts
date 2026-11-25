import { cpSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import sirv from "sirv";
import { defineConfig } from "vite";

// Excalidraw fonts are served locally (offline, CSP-friendly) from /excalidraw-assets/.
const EXCALIDRAW_FONTS = resolve(__dirname, "node_modules/@excalidraw/excalidraw/dist/prod");
import react from "@vitejs/plugin-react";

const CSP =
  "default-src 'self'; script-src 'self'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data: blob:; " +
  "img-src 'self' data: blob: https: http://127.0.0.1:*; media-src 'self' blob: http://127.0.0.1:*; " +
  "connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:* ws:; frame-src 'self' http://127.0.0.1:*; object-src 'none'";

export default defineConfig(({ command }) => ({
  base: "./",
  plugins: [
    react(),
    {
      name: "brain2-excalidraw-assets",
      configureServer(server) {
        server.middlewares.use("/excalidraw-assets", sirv(EXCALIDRAW_FONTS, { dev: true }));
      },
      // Never fall back to a CDN for Excalidraw fonts: point the fallback at the bundled copy.
      transform(code, id) {
        if (!id.includes("@excalidraw/excalidraw/dist") || !code.includes("esm.sh")) return null;
        const out = code.replace(
          /`https:\/\/esm\.sh\/\$\{\w+\.PKG_NAME\?`\$\{\w+\.PKG_NAME\}@\$\{\w+\.PKG_VERSION\}`:"@excalidraw\/excalidraw"\}\/dist\/prod\/`/g,
          '(typeof window!=="undefined"&&typeof window.EXCALIDRAW_ASSET_PATH==="string"?window.EXCALIDRAW_ASSET_PATH:"./excalidraw-assets/")',
        );
        if (out === code) this.warn("Excalidraw CDN fallback not found; fonts may be requested from esm.sh");
        return { code: out, map: null };
      },
      closeBundle() {
        const src = resolve(EXCALIDRAW_FONTS, "fonts");
        if (existsSync(src)) cpSync(src, resolve(__dirname, "dist/excalidraw-assets/fonts"), { recursive: true });
      },
    },
    {
      name: "brain2-csp",
      transformIndexHtml(html) {
        // Strict CSP for production builds; the dev server needs inline scripts for HMR.
        return command === "build"
          ? html.replace("<!--CSP-->", `<meta http-equiv="Content-Security-Policy" content="${CSP}">`)
          : html;
      },
    },
  ],
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 4000 },
}));
