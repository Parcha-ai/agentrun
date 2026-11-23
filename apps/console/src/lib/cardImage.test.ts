import { describe, expect, it, vi } from "vitest";
import css from "@/tokens.css?raw";
import { hslToRgb, readTokens } from "@/design/contrast";
import { CARD_HEIGHT, CARD_WIDTH, cardAlt, renderCard, toPng, type CardBody } from "./cardImage";

// The one card renderer (a free run's receipt, each Wrapped card): a CardBody in, an SVG string and its data URL out.
// Pure, every word from the body, every colour a token of the card's theme, nothing that loads from anywhere.
const tokens = readTokens(css);
const hex = (triplet: string) => `#${hslToRgb(triplet).map((c) => Math.round(Math.max(0, Math.min(1, c)) * 255).toString(16).padStart(2, "0")).join("")}`;
const paletteOf = (theme: "dark" | "light") => new Set(Object.values(tokens[theme]).filter((v) => /^\d+(\.\d+)? \d+(\.\d+)?% \d+(\.\d+)?%$/.test(v)).map(hex));

const parse = (svg: string) => {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  expect(doc.querySelector("parsererror"), svg).toBeNull();
  return doc;
};
const texts = (svg: string) => [...parse(svg).querySelectorAll("text")].map((t) => t.textContent ?? "");
const fills = (svg: string) => [...parse(svg).querySelectorAll("[fill]")].map((el) => el.getAttribute("fill")!);

const receipt: CardBody = {
  eyebrow: "Receipt",
  title: "triage-bot ran for free",
  figure: { value: "$0.00", unit: "known" },
  rows: [
    { label: "Model", value: "ollama/qwen3:8b" },
    { label: "Requests", value: "14" },
    { label: "Tokens", value: "21.4k in · 3.1k out" },
    { label: "Tools", value: "web_fetch ×3" },
    { label: "Wall", value: "2m 41s" },
    { label: "Ran on", value: "this machine" },
  ],
  footnote: "Free: a local model on your own machine.",
};

const hours: CardBody = {
  eyebrow: "Your year",
  title: "You work late",
  figure: { value: "11 pm", unit: "busiest hour" },
  charts: [
    { label: "By hour", bars: Array.from({ length: 24 }, (_, h) => ({ label: String(h), value: h === 3 ? 0 : 1 + ((h * 7) % 13) })) },
    { label: "By weekday", bars: ["S", "M", "T", "W", "T", "F", "S"].map((label, i) => ({ label, value: i + 1 })) },
  ],
};

describe("renderCard", () => {
  it("draws a 1200 by 675 SVG and the same SVG as a data URL", () => {
    const image = renderCard(receipt);
    expect([image.width, image.height]).toEqual([CARD_WIDTH, CARD_HEIGHT]);
    expect([CARD_WIDTH, CARD_HEIGHT]).toEqual([1200, 675]);
    const root = parse(image.svg).documentElement;
    expect([root.getAttribute("width"), root.getAttribute("height"), root.getAttribute("viewBox")]).toEqual(["1200", "675", "0 0 1200 675"]);
    expect(image.dataUrl.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
    expect(decodeURIComponent(image.dataUrl.slice("data:image/svg+xml;charset=utf-8,".length))).toBe(image.svg);
  });

  it("is pure: the same body draws the same bytes", () => {
    expect(renderCard(receipt).svg).toBe(renderCard({ ...receipt }).svg);
  });

  it("says only the body's words, and the brand", () => {
    const words = [receipt.eyebrow!.toUpperCase(), receipt.title, receipt.figure!.value, receipt.figure!.unit!, ...receipt.rows!.flatMap((r) => [r.label.toUpperCase(), r.value]), receipt.footnote!, "AGENTRUN"];
    const drawn = texts(renderCard(receipt).svg);
    for (const text of drawn) expect(words, text).toContain(text);
    for (const word of words) expect(drawn, word).toContain(word);
    // A field not given draws nothing for it.
    const bare = texts(renderCard({ title: "Just a title" }).svg);
    expect(bare).toEqual(["AGENTRUN", "Just a title"]);
  });

  it("paints every mark in a token of the card's theme, dark unless asked, and loads nothing", () => {
    for (const theme of ["dark", "light"] as const) {
      const { svg } = renderCard({ ...hours, ...receipt, theme: theme === "dark" ? undefined : theme });
      const palette = paletteOf(theme);
      for (const fill of fills(svg)) expect(palette, `${fill} (${theme})`).toContain(fill);
      expect(svg).not.toMatch(/url\(|href|<image|<style|style=|@import|<script|<foreignObject/i);
    }
    const background = (svg: string) => parse(svg).querySelector("rect")!.getAttribute("fill");
    expect(background(renderCard(receipt).svg)).toBe(hex(tokens.dark.card!));
    expect(background(renderCard({ ...receipt, theme: "light" }).svg)).toBe(hex(tokens.light.card!));
  });

  it("escapes what it is given: markup in a body is text", () => {
    const { svg } = renderCard({ title: `</text><script>"x"</script>&'y'`, rows: [{ label: "<b>", value: "a&b" }] });
    const doc = parse(svg);
    expect(doc.querySelector("script")).toBeNull();
    expect(texts(svg)).toContain(`</text><script>"x"</script>&'y'`);
    expect(texts(svg)).toContain("<B>");
    expect(texts(svg)).toContain("a&b");
  });

  it("keeps the title to two lines and cuts what does not fit with an ellipsis", () => {
    const long = "word ".repeat(80).trim();
    const drawn = texts(renderCard({ title: long, rows: [{ label: "Model", value: "x".repeat(300) }], footnote: "f".repeat(400) }).svg);
    const title = drawn.filter((t) => t.startsWith("word"));
    expect(title).toHaveLength(2);
    expect(title[1]!.endsWith("…")).toBe(true);
    expect(drawn.find((t) => t.startsWith("xxx"))!.endsWith("…")).toBe(true);
    expect(drawn.find((t) => t.startsWith("fff"))!.endsWith("…")).toBe(true);
    // Nothing is drawn past the card's edge.
    for (const el of parse(renderCard({ ...hours, title: long, rows: receipt.rows, footnote: "foot" }).svg).querySelectorAll("text, rect")) {
      const y = Number(el.getAttribute("y"));
      expect(y, el.outerHTML).toBeGreaterThanOrEqual(0);
      expect(y + Number(el.getAttribute("height") ?? 0), el.outerHTML).toBeLessThanOrEqual(CARD_HEIGHT);
    }
  });

  it("draws a chart's bars against its largest: many as columns, a few as labelled rows, nothing for zero or a non-number", () => {
    const primary = hex(tokens.dark.primary!);
    const marks = (svg: string) => [...parse(svg).querySelectorAll(`rect[fill="${primary}"]`)].filter((r) => r.getAttribute("y") !== "0.0");
    // 24 hours (one at zero) and 7 weekdays: a column for each non-zero bar.
    const columns = marks(renderCard(hours).svg);
    expect(columns.filter((r) => Number(r.getAttribute("height")) > 0)).toHaveLength(23 + 7);
    const split: CardBody = { title: "Where it went", charts: [{ bars: [{ label: "claude-code", value: 60, text: "60%" }, { label: "codex", value: 30, text: "30%" }, { label: "broken", value: Number.NaN }, { label: "none", value: -4 }] }] };
    const svg = renderCard(split).svg;
    expect(texts(svg)).toEqual(expect.arrayContaining(["claude-code", "codex", "60%", "30%", "broken", "none"]));
    const widths = marks(svg).map((r) => Number(r.getAttribute("width")));
    expect(widths[0]! / widths[1]!).toBeCloseTo(2, 1);
    expect(widths.slice(2)).toEqual([0, 0]);
  });
});

describe("toPng", () => {
  it("draws the card's data URL on a canvas at the scale asked and answers its PNG", async () => {
    const image = renderCard(receipt);
    const drawn: unknown[][] = [];
    const scaled: number[][] = [];
    const context = { scale: (...a: number[]) => scaled.push(a), drawImage: (...a: unknown[]) => drawn.push(a) };
    const png = new Blob(["png"], { type: "image/png" });
    // jsdom decodes no image: the test's Image says it has, as a browser's does once the data URL is read.
    const hadDecode = Object.hasOwn(HTMLImageElement.prototype, "decode");
    if (!hadDecode) Object.defineProperty(HTMLImageElement.prototype, "decode", { configurable: true, value: async () => undefined });
    const restore = [
      { mockRestore: () => { if (!hadDecode) delete (HTMLImageElement.prototype as { decode?: unknown }).decode; } },
      vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as never),
      vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (this: HTMLCanvasElement, done: BlobCallback, type?: string) {
        expect([this.width, this.height, type]).toEqual([2400, 1350, "image/png"]);
        done(png);
      }),
    ];
    try {
      expect(await toPng(image)).toBe(png);
      expect(scaled).toEqual([[2, 2]]);
      expect((drawn[0]![0] as HTMLImageElement).src).toBe(image.dataUrl);
      expect(drawn[0]!.slice(1)).toEqual([0, 0, 1200, 675]);
    } finally {
      for (const spy of restore) spy.mockRestore();
    }
  });
});

describe("cardAlt", () => {
  it("reads the card's words in order", () => {
    expect(cardAlt({ eyebrow: "Receipt", title: "Free run", figure: { value: "$0.00" }, rows: [{ label: "Model", value: "qwen" }], charts: [{ label: "By day", bars: [{ label: "Mon", value: 3 }, { label: "Tue", value: 1, text: "1 run" }] }], footnote: "Local." }))
      .toBe("Receipt. Free run. $0.00. Model: qwen. By day: Mon 3, Tue 1 run. Local.");
    expect(renderCard(receipt).alt).toBe(cardAlt(receipt));
  });
});
