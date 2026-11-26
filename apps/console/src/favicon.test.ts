import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import html from "../index.html?raw";

// Vite's explicit ?inline overrides its default of always emitting link icons as files. The server's CSP
// permits those images, without relying on an unserved /favicon.ico or an SVG asset route.
describe("the page's icon", () => {
  const link = html.match(/<link rel="icon" type="image\/svg\+xml" href="([^"]+)"/)?.[1];
  it("explicitly embeds the vector icon rather than requesting an unserved icon file", () => {
    expect(link).toBe("./src/assets/branding/agentrun-favicon.svg?inline");
  });
  it("points to a square transparent vector with no raster payload", () => {
    const svg = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", link!.split("?")[0]), "utf8");
    expect(svg).toContain('viewBox="0 0 1080 1080"');
    expect(svg).toContain("<path");
    expect(svg).not.toMatch(/<image|<rect|data:image/);
  });
});
