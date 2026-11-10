// WCAG 2.2 contrast, for src/design-system.test.ts and the Storybook's colour page.
export type Rgb = [number, number, number];

/** An HSL triplet as tokens.css writes it ("30 100% 50%") to sRGB, each channel 0 to 1. */
export function hslToRgb(triplet: string): Rgb {
  const [h, s, l] = triplet.trim().split(/\s+/).map((part) => Number.parseFloat(part)) as [number, number, number];
  const [sat, light] = [s / 100, l / 100];
  const a = sat * Math.min(light, 1 - light);
  const channel = (n: number) => { const k = (n + h / 30) % 12; return light - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1))); };
  return [channel(0), channel(8), channel(4)];
}

const luminance = ([r, g, b]: Rgb) => { const lin = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); };

/** `over` at `alpha` on `under`: what a `bg-success/10` wash is on the page. */
export const blend = (over: Rgb, under: Rgb, alpha: number): Rgb => over.map((v, i) => v * alpha + under[i]! * (1 - alpha)) as Rgb;

/** The contrast ratio of two colours, 1 to 21. */
export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** tokens.css's colour tokens per theme, a pointer (`var(--other)`) followed to its value. */
export function readTokens(css: string): { light: Record<string, string>; dark: Record<string, string> } {
  const block = (selector: RegExp) => {
    const body = css.match(selector)?.[1] ?? "";
    return Object.fromEntries([...body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
  };
  const light = block(/:root, \.light \{([\s\S]*?)\n\}/);
  const dark = { ...light, ...block(/\n\.dark \{([\s\S]*?)\n\}/) };
  const resolve = (set: Record<string, string>) => Object.fromEntries(Object.entries(set).map(([name, value]) => {
    let v = value;
    for (let i = 0; i < 5 && /^var\(--[a-z0-9-]+\)$/.test(v); i++) v = set[v.slice(6, -1)] ?? v;
    return [name, v];
  }));
  return { light: resolve(light), dark: resolve(dark) };
}
