import { describe, expect, it } from "vitest";
import { KEY_GROUPS } from "./KeysPage";
import { SETTINGS_PAGES } from "./Settings";

// Every "Settings → X" the server and the console say, in their words and their comments, names a place a person can
// open: a Settings tab (SETTINGS_PAGES) or a group on the keys page (KEY_GROUPS). A phrase naming a page the console
// doesn't have sends a person looking for it.
const SOURCES: Record<string, string> = {
  ...import.meta.glob("../../../../packages/serve/src/**/*.{ts,mts,mjs}", { query: "?raw", import: "default", eager: true }),
  ...import.meta.glob("../**/*.{ts,tsx,mjs}", { query: "?raw", import: "default", eager: true }),
};
const PLACES = [...SETTINGS_PAGES.map((p) => p.label), ...KEY_GROUPS.map((g) => g.name)];

describe("Settings → X", () => {
  it("names a Settings tab or a keys page group, wherever the server or the console says it", () => {
    expect(Object.keys(SOURCES).some((file) => file.includes("packages/serve/src/"))).toBe(true);
    const said: { at: string; place: string }[] = [];
    // This file's own phrases are the rule's, not places.
    for (const [file, text] of Object.entries(SOURCES).filter(([file]) => !file.endsWith("/SettingsWords.test.ts"))) {
      text.split("\n").forEach((line, i) => {
        for (const m of line.matchAll(/Settings → (.{0,40})/g)) said.push({ at: `${file.replace(/^(\.\.\/)+/, "")}:${i + 1}`, place: m[1]! });
      });
    }
    expect(said.length).toBeGreaterThan(10);
    // A phrase names a place when it starts with the place's name, ending at a word's end.
    const unknown = said.filter(({ place }) => !PLACES.some((name) => place.startsWith(name) && !/^[\p{L}\p{N}]/u.test(place.slice(name.length))));
    expect(unknown.map(({ at, place }) => `${at}: Settings → ${place}`)).toEqual([]);
  });
});
