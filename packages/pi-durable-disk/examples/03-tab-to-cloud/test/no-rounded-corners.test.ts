// Invariant: no rounded corner on any surface of the agent's chat page, which is filmed; only a true circle, such as a status dot.
// The page's own sheet and the shared theme it links are read as text, so a corner added later fails here before it is filmed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const SURFACES = ["../tab/index.html", "../tab/agent-theme.css", "../../theme/theme.css"];

test("no surface of the agent's page has a rounded corner: every border-radius is 0, a radius token, or a true circle (50%)", () => {
  const bad: string[] = [];
  for (const rel of SURFACES) {
    read(rel).split("\n").forEach((line, i) => {
      for (const m of line.matchAll(/border-radius\s*:\s*([^;}"]+)/g)) {
        const v = m[1]!.trim();
        if (!/^(0|0px|50%|var\(--r[123]\))(\s*!important)?$/.test(v)) bad.push(`${rel}:${i + 1}: border-radius: ${v}`);
      }
    });
  }
  assert.deepEqual(bad, []);
});

test("the shared theme's radius tokens are 0 (the page's .card, .btn, inputs and tools read them)", () => {
  const css = read("../../theme/theme.css");
  for (const token of ["--r1", "--r2", "--r3"]) assert.match(css, new RegExp(`${token}:\\s*0(px)?\\s*[;}]`), `${token} is 0 in the shared theme`);
});

test("no source of the page sets a radius from script or draws a rounded SVG rect", () => {
  for (const rel of ["../tab/main.ts", "../tab/chat-view.ts", "../tab/code-view.ts", "../tab/composer.ts", "../tab/workspace.ts"]) {
    const text = read(rel);
    assert.doesNotMatch(text, /borderRadius|border-radius/, `${rel} sets no radius`);
    assert.doesNotMatch(text, /<rect[^>]*\b(rx|ry)=/, `${rel} draws no rounded rect`);
  }
});
