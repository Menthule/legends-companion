import React from "react";
import ReactDOM from "react-dom/client";
import Dashboard from "./components/Dashboard";
import OverlayAlerts from "./overlay/OverlayAlerts";
import OverlayBuffs from "./overlay/OverlayBuffs";
import OverlayMeter from "./overlay/OverlayMeter";
import OverlayXp from "./overlay/OverlayXp";
import OverlayStance from "./overlay/OverlayStance";
import OverlayOnOthers from "./overlay/OverlayOnOthers";
import OverlayTarget from "./overlay/OverlayTarget";
import OverlayRespawn from "./overlay/OverlayRespawn";
import { openUrl } from "@tauri-apps/plugin-opener";
import { initTheme } from "./theme";
import { IS_MOCK, startMockDriver } from "./mock";
import "./styles.css";

initTheme();
if (IS_MOCK) startMockDriver();

// Tauri webviews don't hand target="_blank" to the OS browser, so external
// links did nothing (reported bug). One delegated handler routes every http(s)
// link through the opener plugin. Mock/browser mode keeps native behavior.
if (!IS_MOCK) {
  document.addEventListener("click", (e) => {
    const anchor = (e.target as HTMLElement | null)?.closest?.("a");
    const href = anchor?.getAttribute("href");
    if (href && /^https?:\/\//i.test(href)) {
      e.preventDefault();
      void openUrl(href).catch(() => {});
    }
  });
}

const params = new URLSearchParams(window.location.search);
// Overlay windows are `?overlay=alerts|buffs|target|meter`; also accept
// `?window=overlay-<name>` for symmetry with window labels.
const windowParam = params.get("window");
const overlay =
  params.get("overlay") ??
  (windowParam?.startsWith("overlay-")
    ? windowParam.slice("overlay-".length)
    : null);

if (overlay) {
  document.documentElement.classList.add("overlay-root");
  document.body.classList.add("overlay-root");
  // In mock mode give the transparent overlay a stand-in "game footage"
  // backdrop so readability treatments (pill, scrim, blur) are visible.
  if (IS_MOCK) document.body.classList.add("mock-backdrop");
}

let view: React.ReactElement;
switch (overlay) {
  case "alerts":
    view = <OverlayAlerts />;
    break;
  case "buffs":
    view = <OverlayBuffs />;
    break;
  case "target":
    view = <OverlayTarget />;
    break;
  case "meter":
    view = <OverlayMeter />;
    break;
  case "xp":
    view = <OverlayXp />;
    break;
  case "stance":
    view = <OverlayStance />;
    break;
  case "onothers":
    view = <OverlayOnOthers />;
    break;
  case "respawn":
    view = <OverlayRespawn />;
    break;
  default:
    view = <Dashboard />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{view}</React.StrictMode>,
);
