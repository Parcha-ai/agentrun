import { describe, expect, it } from "vitest";
import config from "../tailwind.config";
import stylesCss from "./styles.css?raw";
import css from "./tokens.css?raw";
import { blend, contrast, hslToRgb, readTokens } from "@/design/contrast";
import { COLOR_TOKENS, CONTROL_SIZES, DURATIONS, LAYERS, NON_TEXT_PAIRS, TEXT_PAIRS, TYPE_SCALE } from "@/design/tokens";

// The design system's own contract (docs/console-design-system.md): tokens.css gives every token a value in both
// themes, Tailwind's names point at tokens, and the colours someone reads pass WCAG 2.2 AA.
const tokens = readTokens(css);
const colours = Object.values(COLOR_TOKENS).flat();
const TRIPLET = /^\d+(\.\d+)? \d+(\.\d+)?% \d+(\.\d+)?%$/;

describe("tokens.css", () => {
  it("gives every colour token an HSL triplet in the light and the dark theme", () => {
    for (const theme of ["light", "dark"] as const) for (const name of colours) expect(tokens[theme][name], `--${name} (${theme})`).toMatch(TRIPLET);
  });
  it("sets every colour the dark theme changes under .dark itself, so a dark panel inside a light page is whole", () => {
    const dark = css.match(/\n\.dark \{([\s\S]*?)\n\}/)![1]!;
    for (const name of colours) expect(dark, `--${name} under .dark`).toContain(`--${name}:`);
  });
  it("holds no colour token the guide's list does not name", () => {
    const named = new Set<string>(colours);
    const found = Object.entries(tokens.light).filter(([, value]) => TRIPLET.test(value)).map(([name]) => name);
    expect(found.filter((name) => !named.has(name))).toEqual([]);
  });
  it("defines each layer, duration and control size the guide lists, layers in rising order", () => {
    const layers = LAYERS.map((l) => Number(tokens.light[`layer-${l.name}`]));
    expect(layers.every(Number.isFinite), "every layer is a number").toBe(true);
    expect(layers).toEqual([...layers].sort((a, b) => a - b));
    expect(new Set(layers).size).toBe(layers.length);
    for (const d of DURATIONS) expect(tokens.light[`duration-${d.name}`], d.name).toMatch(/^\d+ms$/);
    for (const c of CONTROL_SIZES) expect(tokens.light[`control-${c.name}`], c.name).toMatch(/^[\d.]+rem$/);
  });
  it("paints a dark OS's page dark before any script runs, with the dark theme's own background", () => {
    const early = css.match(/html:not\(\.light\):not\(\.dark\) \{ --background: ([^;]+);/)?.[1];
    expect(early).toBe(tokens.dark.background);
  });
});

describe("contrast (WCAG 2.2 AA)", () => {
  for (const theme of ["light", "dark"] as const) {
    const rgb = (name: string) => hslToRgb(tokens[theme][name]!);
    it(`${theme}: every text pair is at least 4.5:1`, () => {
      const failed = TEXT_PAIRS.map(({ text, on, wash }) => {
        const surface = wash ? blend(rgb(wash), rgb(on), 0.1) : rgb(on);
        return { pair: `${text} on ${wash ? `${wash}/10 over ` : ""}${on}`, ratio: Number(contrast(rgb(text), surface).toFixed(2)) };
      }).filter((p) => p.ratio < 4.5);
      expect(failed).toEqual([]);
    });
    it(`${theme}: a field's edge and the focus ring are at least 3:1`, () => {
      const failed = NON_TEXT_PAIRS.map(({ mark, on }) => ({ pair: `${mark} on ${on}`, ratio: Number(contrast(rgb(mark), rgb(on)).toFixed(2)) })).filter((p) => p.ratio < 3);
      expect(failed).toEqual([]);
    });
  }
});

describe("tailwind.config.ts", () => {
  const theme = config.theme;
  it("names only colours tokens.css defines", () => {
    const used = [...JSON.stringify(theme.extend.colors).matchAll(/var\(--([a-z0-9-]+)\)/g)].map((m) => m[1]!);
    expect(used.length).toBeGreaterThan(20);
    for (const name of used) expect(tokens.light[name], `--${name}`).toBeDefined();
    for (const name of colours) expect(used, `a class for --${name}`).toContain(name);
  });
  it("has the type scale the guide lists, and no other size", () => {
    expect(Object.keys(theme.fontSize)).toEqual(TYPE_SCALE.map((t) => t.name));
    for (const t of TYPE_SCALE) expect([theme.fontSize[t.name]].flat()[0], t.name).toBe(`${t.px}px`);
  });
  it("has the layers and durations the guide lists, each one a token", () => {
    for (const l of LAYERS) expect(theme.zIndex[l.name]).toBe(`var(--layer-${l.name})`);
    expect(Object.keys(theme.zIndex).filter((k) => k !== "auto" && k !== "0")).toEqual(LAYERS.map((l) => l.name));
    for (const d of DURATIONS) expect(theme.transitionDuration[d.name]).toBe(`var(--duration-${d.name})`);
  });
  it("has two weights, the two the bundled fonts carry", () => {
    expect(theme.fontWeight).toEqual({ normal: "400", semibold: "600" });
    const fonts = [...stylesCss.matchAll(/@fontsource\/[a-z-]+\/(\d+)\.css/g)].map((m) => m[1]);
    expect([...new Set(fonts)].sort()).toEqual(["400", "600"]);
  });
  it("has square corners and one shadow", () => {
    expect(tokens.light.radius).toBe("0px");
    expect(Object.keys(theme.boxShadow)).toEqual(["none", "float"]);
  });
});
