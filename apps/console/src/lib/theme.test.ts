import { afterEach, describe, expect, it } from "vitest";
import { applyTheme, currentTheme, followTheme, savedTheme, saveTheme, THEME_KEY } from "./theme";
import html from "../../index.html?raw";
// (The stylesheet is not read here: this test runner gives a CSS import as an empty string.)

// The console follows the OS (prefers-color-scheme) unless the person picked Light or Dark, which this browser remembers.
const memory = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m }; };
/** An OS scheme that can change, as matchMedia("(prefers-color-scheme: dark)") reports it. */
function scheme(dark: boolean) {
  const on = new Set<() => void>();
  const m = {
    matches: dark, on,
    addEventListener(_: "change", f: () => void) { on.add(f); },
    removeEventListener(_: "change", f: () => void) { on.delete(f); },
    set(d: boolean) { m.matches = d; for (const f of on) f(); },
  };
  return m;
}
const shown = () => [...document.documentElement.classList];

// A pick a refusing storage could not keep stays held on the page (in the module): each test starts from none.
afterEach(() => { document.documentElement.className = ""; saveTheme("system", memory()); });

describe("the theme", () => {
  it("is the OS's until the person picks one; a pick is kept per browser, and System forgets it", () => {
    const s = memory();
    expect(savedTheme(s)).toBe("system");
    saveTheme("light", s);
    expect(s.m.get(THEME_KEY)).toBe("light");
    expect(savedTheme(s)).toBe("light");
    saveTheme("dark", s);
    expect(savedTheme(s)).toBe("dark");
    saveTheme("system", s);
    expect(s.m.has(THEME_KEY)).toBe(false);
    expect(savedTheme(s)).toBe("system");
  });

  it("reads anything else, or a storage that refuses (a private window), as the OS's", () => {
    const s = memory();
    s.m.set(THEME_KEY, "sepia");
    expect(savedTheme(s)).toBe("system");
    const refusing = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); }, removeItem: () => { throw new Error("denied"); } };
    expect(savedTheme(refusing)).toBe("system");
    expect(() => saveTheme("dark", refusing)).not.toThrow();
  });

  it("shows the pick, or for System the OS's scheme, as one class on <html>", () => {
    const el = document.documentElement;
    applyTheme("system", el, scheme(true));
    expect(shown()).toEqual(["dark"]);
    applyTheme("system", el, scheme(false));
    expect(shown()).toEqual(["light"]);
    applyTheme("dark", el, scheme(false));
    expect(shown()).toEqual(["dark"]);
    applyTheme("light", el, scheme(true));
    expect(shown()).toEqual(["light"]);
    // No matchMedia at all (an old browser): System is light, the stylesheet's default.
    applyTheme("system", el, null);
    expect(shown()).toEqual(["light"]);
  });

  it("follows the OS as it changes while the pick is System, and stays put on a pick", () => {
    const s = memory(), os = scheme(false), el = document.documentElement;
    const stop = followTheme(el, os, s);
    expect(shown()).toEqual(["light"]);
    os.set(true);
    expect(shown()).toEqual(["dark"]);
    saveTheme("light", s);
    applyTheme("light", el, os);
    os.set(false);
    os.set(true);
    expect(shown()).toEqual(["light"]);
    stop();
    expect(os.on.size).toBe(0);
  });
});

describe("a pick this browser can't keep (storage refused)", () => {
  it("stays the pick for this page: an OS change never replaces it, and the switch reads it back", () => {
    const refusing = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); }, removeItem: () => { throw new Error("denied"); } };
    const os = scheme(false), el = document.documentElement;
    const stop = followTheme(el, os, refusing);
    saveTheme("dark", refusing);
    applyTheme("dark", el, os);
    os.set(true);
    os.set(false);
    expect(shown()).toEqual(["dark"]);
    expect(currentTheme(refusing)).toBe("dark");
    saveTheme("system", refusing);
    os.set(true);
    expect(shown()).toEqual(["dark"]);
    os.set(false);
    expect(shown()).toEqual(["light"]);
    stop();
  });
});

describe("the page", () => {
  it("no longer hard-codes dark on <html>, and tells the browser both schemes are drawn", () => {
    expect(html).not.toMatch(/<html[^>]*class="[^"]*dark/);
    expect(html).toMatch(/<meta name="color-scheme" content="light dark"/);
  });
});
