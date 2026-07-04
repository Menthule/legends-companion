// Theme system per DESIGN.md — dark is the default, `data-theme` on <html>.
// Persistence: localStorage (works in both mock/browser and Tauri webview).
// `?theme=light|dark` forces a theme for the session (screenshots) without
// persisting it.

export type Theme = "dark" | "light";

const STORAGE_KEY = "eqlogs.theme";

export function initTheme(): Theme {
  let theme: Theme = "dark";
  try {
    if (localStorage.getItem(STORAGE_KEY) === "light") theme = "light";
  } catch {
    /* storage unavailable — keep default */
  }
  const forced = new URLSearchParams(window.location.search).get("theme");
  if (forced === "light" || forced === "dark") theme = forced;
  document.documentElement.dataset.theme = theme;
  return theme;
}

export function getTheme(): Theme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

export function setTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* non-fatal */
  }
}
