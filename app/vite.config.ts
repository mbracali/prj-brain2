import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; " +
  "img-src 'self' data: blob: https: http://127.0.0.1:*; media-src 'self' blob: http://127.0.0.1:*; " +
  "connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:* ws:; frame-src 'self' http://127.0.0.1:*; object-src 'none'";

export default defineConfig(({ command }) => ({
  base: "./",
  plugins: [
    react(),
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
