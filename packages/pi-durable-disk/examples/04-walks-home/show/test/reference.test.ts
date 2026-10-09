import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { renderReference, type ReferenceTimings } from "../reference.ts";

const ref = JSON.parse(readFileSync(fileURLToPath(new URL("../reference-timings.json", import.meta.url)), "utf8")) as ReferenceTimings;

test("the reference data keeps its provenance and chains tab, basic, GPU, tab", () => {
  assert.match(ref.source.url, /^https:\/\/docs\.g\.parcha\.dev\/.*pi-agent-switch-tab-daytona-gpu\.html$/);
  assert.equal(ref.platform, "Daytona");
  assert.deepEqual(ref.rows.map((r) => [r.from, r.to]), [["This tab", "Daytona basic"], ["Daytona basic", "Daytona GPU"], ["Daytona GPU", "This tab"]]);
  // The page's number includes the click-to-notice work after the server's, so it is never the smaller one.
  for (const r of ref.rows) assert.ok(r.pageSeconds >= r.serverSeconds && r.serverSeconds > 0, `${r.from} to ${r.to}`);
});

test("the reference block states the three page numbers, tags them as measured on Daytona and links the source", () => {
  const html = renderReference(ref);
  for (const n of ["2.9 s", "6.3 s", "1.5 s", "2.5 s", "5.0 s", "1.4 s"]) assert.ok(html.includes(n), n);
  assert.match(html, /MEASURED on Daytona/);
  assert.ok(html.includes('href="2026-10-09-pi-agent-switch-tab-daytona-gpu.html"'), "a page on the docs site is linked by file name");
  assert.ok(!html.includes("https://docs"), "no absolute address in the visible block");
  assert.doesNotMatch(html, /MEASURED locally/, "no local numbers unless given");
});

test("this stage's own numbers are shown apart, tagged as local and not Daytona", () => {
  const html = renderReference(ref, { startedAt: "2026-10-09T07:20:00Z", switches: [{ target: "Second host", serverMs: 865 }, { target: "This tab", serverMs: 57 }] });
  assert.match(html, /MEASURED locally/);
  assert.match(html, /not Daytona/);
  assert.ok(html.includes("0.87 s") || html.includes("0.86 s"));
  assert.ok(html.includes("0.06 s"));
  assert.ok(html.indexOf("MEASURED on Daytona") < html.indexOf("MEASURED locally"));
});

test("text from the data is escaped", () => {
  const html = renderReference({ ...ref, source: { ...ref.source, title: "<b>x</b>" } });
  assert.ok(!html.includes("<b>x</b>"));
});
