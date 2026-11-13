// A run's context reset or summarized older context shows on its Timeline as a phase row whose text is the new context or
// the summary: words from the run, which can quote a held key. That row holds none of it, as every other row a run's words
// reach (the host's redact before any cut).
import assert from "node:assert/strict";
import { test } from "node:test";
import { timelineOf, timelineReducer } from "../dist/timeline/index.js";
import { custom, user } from "./timeline-lib-support.mjs";

/** A held key, made at runtime: no credential-shaped literal for the source export. */
const KEY = ["not-a-secret", "phase-row", "0123456789ab"].join("-");
const B64 = Buffer.from(KEY).toString("base64");
const redact = (text) => text.split(KEY).join("[redacted]").split(B64).join("[redacted]");
const holds = (text) => text.includes(KEY) || text.includes(B64);

const entries = () => [
  user("Go on."),
  custom("pi.reset", undefined, { model: [{ role: "user", content: `Handoff: continue with ${KEY}.` }] }),
  custom("pi.compaction", undefined, { model: [{ role: "user", content: `## Goal\nKeep going with ${B64}.` }] }),
];

test("a context reset's and a summarized context's phase row hold no held key, settled", () => {
  const rows = timelineOf(entries(), { redact });
  const phases = rows.filter((row) => row.kind === "phase" && /Context reset|Summarized older context/.test(row.summary));
  assert.equal(phases.length, 2, JSON.stringify(rows.map((row) => [row.kind, row.summary])));
  assert.ok(!holds(JSON.stringify(rows)), JSON.stringify(phases));
});

test("the same two rows, live: no held key", () => {
  const reducer = timelineReducer({ redact });
  reducer.apply(entries().map((entry) => ({ type: "entry_appended", entry })));
  const rows = reducer.rows();
  assert.ok(rows.some((row) => row.summary === "Context reset"), JSON.stringify(rows.map((row) => row.summary)));
  assert.ok(!holds(JSON.stringify(rows)), JSON.stringify(rows));
});
