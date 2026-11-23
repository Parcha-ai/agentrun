import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import html from "../index.html?raw";

// Vite's explicit ?inline overrides its default of always emitting link icons as files. The server's CSP
// permits those images, without relying on an unserved /favicon.ico or a PNG asset route.
describe("the page's icon", () => {
  const link = html.match(/<link rel="icon" type="image\/png" href="([^"]+)"/)?.[1];
  it("explicitly embeds the supplied PNG rather than requesting an unserved icon file", () => {
    expect(link).toBe("./src/assets/branding/agentrun-favicon.png?inline");
  });
  it("points to a square PNG image", () => {
    const png = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", link!.split("?")[0]));
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(png.readUInt32BE(16)).toBe(1080);
    expect(png.readUInt32BE(20)).toBe(1080);
  });
});
