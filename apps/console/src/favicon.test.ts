import { describe, expect, it } from "vitest";
import html from "../index.html?raw";

// The page declares its icon itself, as a data: URL (the page's CSP allows data: images): the browser never asks for
// /favicon.ico, which the server answers 404 (it serves the console's index.html and its /assets/ scripts, styles and
// fonts only), so no load logs a red 404.
describe("the page's icon", () => {
  const link = html.match(/<link rel="icon" type="image\/svg\+xml" href="(data:image\/svg\+xml,[^"]+)"/)?.[1];
  it("is declared in index.html as a data: URL, so no icon file is ever asked for", () => {
    expect(link).toBeDefined();
  });
  it("is an SVG image", () => {
    const svg = decodeURIComponent(link!.slice("data:image/svg+xml,".length));
    expect(svg).toMatch(/^<svg xmlns='http:\/\/www\.w3\.org\/2000\/svg' viewBox='0 0 32 32'>.*<\/svg>$/);
  });
});
