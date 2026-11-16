export type Theme = "light" | "dark" | "system";

const themeKey = "beebot.theme";
const sidebarKey = "beebot.sidebarCollapsed";

// Storage can be missing or throw (private windows, blocked site data): fall back to defaults.
function read(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, value);
    }
  } catch {
    // Not remembered; the choice still applies for this session.
  }
}

const darkQuery = () =>
  typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : undefined;

export function readTheme(): Theme {
  const saved = read(themeKey);
  return saved === "light" || saved === "dark" ? saved : "system";
}

// `data-theme` always holds the resolved mode, so the stylesheet has one dark selector.
export function applyTheme(theme: Theme) {
  const dark = theme === "dark" || (theme === "system" && darkQuery()?.matches === true);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

export function saveTheme(theme: Theme) {
  write(themeKey, theme === "system" ? null : theme);
  applyTheme(theme);
}

export const readSidebarCollapsed = () => read(sidebarKey) === "true";

export const saveSidebarCollapsed = (collapsed: boolean) =>
  write(sidebarKey, collapsed ? "true" : null);

if (typeof document !== "undefined") {
  applyTheme(readTheme());
  darkQuery()?.addEventListener("change", () => applyTheme(readTheme()));
}
