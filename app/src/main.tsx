import "./excalidraw/assets"; // must run before the (lazy) Excalidraw library loads
import { createRoot } from "react-dom/client";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/400-italic.css";
import "@fontsource/ibm-plex-mono/600.css";
import "@fontsource/source-serif-4/400.css";
import "@fontsource/source-serif-4/600.css";
import "material-symbols/outlined.css";
import "./styles/skins.css";
import "./styles/base.css";
import "./styles/editor.css";
import "./styles/markdown.css";
import "./styles/modules.css";
import "./styles/calendar.css";
import { App } from "./App";
import { ConnectServer } from "./components/ConnectServer";
import { isNativeMobile, savedServer } from "./lib/bridge";

const root = createRoot(document.getElementById("root")!);
// The Android app first needs to know which BRAIN2 server to use, and that it is reachable.
const server = isNativeMobile ? savedServer() : null;
if (isNativeMobile && !server) root.render(<ConnectServer />);
else if (server) {
  fetch(`${server.baseUrl}/api/health`, { signal: AbortSignal.timeout(6000) })
    .then((r) => {
      if (!r.ok) throw new Error();
      root.render(<App />);
    })
    .catch(() => root.render(<ConnectServer error={`Can't reach ${server.baseUrl}. Is BRAIN2 running there?`} />));
} else root.render(<App />);
