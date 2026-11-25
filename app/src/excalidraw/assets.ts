// Excalidraw loads its fonts from EXCALIDRAW_ASSET_PATH; point it at our bundled copy
// (copied by vite.config.ts) so drawings work offline and under the app's CSP.
declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[];
  }
}
window.EXCALIDRAW_ASSET_PATH = new URL("./excalidraw-assets/", window.location.href).toString();
export {};
