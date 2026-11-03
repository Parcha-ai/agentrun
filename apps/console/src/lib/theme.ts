/** The console's theme: the OS's (prefers-color-scheme) unless the person picked Light or Dark, which this browser keeps.
 *  What shows goes on <html> as `dark` or `light`: the stylesheet's dark tokens hang off `.dark`. Before the script runs,
 *  the stylesheet paints the page's background as the OS is, so a dark OS never flashes white. */
export type Theme = "system" | "light" | "dark";
export const THEMES: readonly Theme[] = ["system", "light", "dark"];
export const THEME_KEY = "agentrun.theme";
const DARK_OS = "(prefers-color-scheme: dark)";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
/** What the theme reads of matchMedia("(prefers-color-scheme: dark)"). */
type Media = { matches: boolean; addEventListener(type: "change", f: () => void): void; removeEventListener(type: "change", f: () => void): void };
const local = (): Store | null => { try { return globalThis.localStorage ?? null; } catch { return null; } };
const os = (): Media | null => (typeof globalThis.matchMedia === "function" ? globalThis.matchMedia(DARK_OS) : null);

// A pick made on this page that the storage refused to keep: it still holds here, for an OS change and the switch.
let unkept: Theme | null = null;

/** The pick this browser kept; anything else, or a storage that refuses (a private window), is the OS's. */
export function savedTheme(store: Store | null = local()): Theme {
  try {
    const t = store?.getItem(THEME_KEY);
    return t === "light" || t === "dark" ? t : "system";
  } catch { return "system"; }
}

/** The pick in force on this page: one made here that the storage could not keep, else the one this browser kept. */
export const currentTheme = (store: Store | null = local()): Theme => unkept ?? savedTheme(store);

/** Keeps the pick for this page and in this browser; System forgets it. A storage that refuses keeps nothing, and the
 *  pick still holds on this page. */
export function saveTheme(t: Theme, store: Store | null = local()) {
  unkept = null;
  try { if (t === "system") store?.removeItem(THEME_KEY); else store?.setItem(THEME_KEY, t); } catch { unkept = t; }
}

/** Puts what shows on <html>: the pick, or for System the OS's scheme now. */
export function applyTheme(t: Theme, html: HTMLElement = document.documentElement, media: Media | null = os()) {
  const dark = t === "dark" || (t === "system" && !!media?.matches);
  html.classList.toggle("dark", dark);
  html.classList.toggle("light", !dark);
}

/** Shows the kept pick now, and follows the OS as it changes while the pick is System. Returns its unsubscribe. */
export function followTheme(html: HTMLElement = document.documentElement, media: Media | null = os(), store: Store | null = local()) {
  applyTheme(currentTheme(store), html, media);
  const on = () => { if (currentTheme(store) === "system") applyTheme("system", html, media); };
  media?.addEventListener("change", on);
  return () => media?.removeEventListener("change", on);
}
