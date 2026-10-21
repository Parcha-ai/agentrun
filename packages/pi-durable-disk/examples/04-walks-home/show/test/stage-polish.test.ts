// What the film of the stage must not show: a rounded corner (Miguel's rule of 2026-10-20: none on any surface we make; only a true circle, a status dot), a hint over a card, "1 GPUs", "the Your browser tab".
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { relearnHtml, relearnSummary } from "../relearn.ts";
import { plainSwitch } from "../page/story-notes.ts";
import type { Note, Thread } from "../types.ts";

const here = (rel: string) => fileURLToPath(new URL(`../${rel}`, import.meta.url));
const read = (rel: string) => readFileSync(here(rel), "utf8");
const SURFACES = ["page/index.html", "page/robot-pieces.css", "page/stage-theme.css", "page/stub-tab/index.html", "episode2/page/index.html", "obsession/page/index.html"];

test("no surface of the stage has a rounded corner: every border-radius is 0, except a true circle (50%)", () => {
  const bad: string[] = [];
  for (const rel of SURFACES) {
    read(rel).split("\n").forEach((line, i) => {
      for (const m of line.matchAll(/border-radius\s*:\s*([^;}"]+)/g)) {
        const v = m[1]!.trim();
        if (!/^(0|0px|50%)(\s*!important)?$/.test(v)) bad.push(`${rel}:${i + 1}: border-radius: ${v}`);
      }
    });
  }
  assert.deepEqual(bad, []);
});

test("the stage's radius tokens are 0 (the shared theme's .card, .btn and inputs read them)", () => {
  const css = read("page/stage-theme.css");
  for (const token of ["--r1", "--r2", "--r3"]) assert.match(css, new RegExp(`${token}:\\s*0(px)?\\s*[;}]`), `${token} is 0 in the stage theme`);
});

test("no SVG rect on the stage has rx or ry (the machine timeline's bars)", () => {
  assert.doesNotMatch(read("page/timeline.ts"), /<rect[^>]*\b(rx|ry)=/);
});

test("the chat hint steps aside once the robot's cards are in the column, so it never sits over one", () => {
  assert.match(read("page/stage-theme.css") + read("page/robot-pieces.css"), /#robotside:not\(:empty\)\s*~\s*#chathint\s*\{[^}]*display:\s*none/);
});

const T = (over: Partial<Thread>): Thread => ({ id: "walk", skill: "walk", host: null, status: "done", acquireMs: null, costUsd: null, metric: null, unit: null, target: null, mjcf: "ab".repeat(32), bodyName: "spider", passedS: 70, wallS: 90, cpuS: null, cpuCores: null, home: false, points: [], at: 0, ...over });

test("one GPU and one skill read as one: '1 GPU', 'the 1 skill passed', '0 of 1 skill has passed'", () => {
  const done = relearnHtml(relearnSummary([T({})], "cd".repeat(32))!);
  assert.match(done, /1 GPU, one skill:/);
  assert.doesNotMatch(done, /1 GPUs|1 skills/);
  assert.match(done, /the 1 skill passed in 70 s/);
  const learning = relearnHtml(relearnSummary([T({ status: "learning", passedS: null, wallS: null })], "cd".repeat(32))!);
  assert.match(learning, /0 of 1 skill has passed/);
});

test("several keep the plural: '2 GPUs, one skill each', 'all 2 skills passed'", () => {
  const html = relearnHtml(relearnSummary([T({}), T({ id: "spin", skill: "spin" })], "cd".repeat(32))!);
  assert.match(html, /2 GPUs, one skill each/);
  assert.match(html, /all 2 skills passed in 70 s/);
});

const sw = (text: string): Note => ({ at: 0, kind: "switch", text, measured: true }) as unknown as Note;
test("the switch line has no double article and no capital in the middle of the sentence", () => {
  assert.equal(plainSwitch(sw("Switched to Your browser tab in 2168 ms (timed by the server).")).text, "Moved to your browser tab in 2.2 s");
  assert.equal(plainSwitch(sw("Switched to A Modal VM in 1234 ms (timed by the server).")).text, "Moved to a Modal VM in 1.2 s");
  assert.equal(plainSwitch(sw("Switched to H100 GPU in 822 ms (timed by the server).")).text, "Moved to the H100 GPU in 0.8 s", "a name with no article still gets 'the', as before");
});
