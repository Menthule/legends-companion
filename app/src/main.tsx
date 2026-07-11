import React, { Suspense } from "react";
import ReactDOM from "react-dom/client";
import Dashboard from "./components/Dashboard";
import {
  getOverlayModuleByRoute,
  getOverlayModuleByWindowLabel,
} from "./overlay/modules";
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
// Overlay windows accept their catalog route or exact Tauri window label.
const windowParam = params.get("window");
const overlayRoute =
  params.get("overlay") ??
  (windowParam ? getOverlayModuleByWindowLabel(windowParam)?.route : null);
const overlayModule = overlayRoute
  ? getOverlayModuleByRoute(overlayRoute)
  : undefined;

if (overlayModule) {
  document.documentElement.classList.add("overlay-root");
  document.body.classList.add("overlay-root");
  // In mock mode give the transparent overlay a stand-in "game footage"
  // backdrop so readability treatments (pill, scrim, blur) are visible.
  if (IS_MOCK) document.body.classList.add("mock-backdrop");
}

const OverlayView = overlayModule?.component;
const view: React.ReactElement = OverlayView ? (
  <Suspense fallback={null}>
    <OverlayView />
  </Suspense>
) : (
  <Dashboard />
);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{view}</React.StrictMode>,
);
