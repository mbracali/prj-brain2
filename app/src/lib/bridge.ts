// Access to the Electron preload bridge, with browser fallbacks for server mode.

interface Bridge {
  config: { baseUrl: string; token: string; platform: string };
  pickFolder(): Promise<string | null>;
  openWindow(query: Record<string, string>): Promise<void>;
  reveal(fullPath: string): Promise<void>;
  openPath(fullPath: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  trashItem?(fullPath: string): Promise<void>;
  onMenu(cb: (action: string, payload?: string) => void): () => void;
}

declare global {
  interface Window {
    brain2?: Bridge;
  }
}

export const isElectron = !!window.brain2;

function browserConfig() {
  const params = new URLSearchParams(location.search);
  let token = params.get("token") || "";
  try {
    if (token) sessionStorage.setItem("brain2-token", token);
    else token = sessionStorage.getItem("brain2-token") || "";
  } catch {
    /* storage unavailable */
  }
  const devApi = import.meta.env.VITE_BRAIN2_API as string | undefined;
  return { baseUrl: devApi || location.origin, token, platform: navigator.platform };
}

export const config = window.brain2?.config ?? browserConfig();
export const isMac = /darwin|mac/i.test(config.platform);
export const modKey = isMac ? "⌘" : "Ctrl";

export const bridge = {
  pickFolder: () => window.brain2?.pickFolder() ?? Promise.resolve(null),
  openWindow(query: Record<string, string>) {
    if (window.brain2) return window.brain2.openWindow(query);
    const url = new URL(location.href);
    Object.entries(query).forEach(([k, v]) => url.searchParams.set(k, v));
    window.open(url.toString(), "_blank");
    return Promise.resolve();
  },
  reveal: (p: string) => window.brain2?.reveal(p) ?? Promise.resolve(),
  openPath: (p: string) => window.brain2?.openPath(p) ?? Promise.resolve(),
  openExternal(url: string) {
    if (window.brain2) return window.brain2.openExternal(url);
    window.open(url, "_blank", "noopener");
    return Promise.resolve();
  },
  onMenu: (cb: (action: string, payload?: string) => void) => window.brain2?.onMenu(cb) ?? (() => {}),
};
