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

createRoot(document.getElementById("root")!).render(<App />);
