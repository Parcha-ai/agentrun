import assert from "node:assert/strict";
import { test } from "node:test";
import { captionsFor } from "../page/caption.ts";
import { notesFromTabEvent } from "../page/tab-notes.ts";
import { fold } from "../reduce.ts";
import type { ShowEvent, TabToShell } from "../types.ts";

const base = { ns: "walks-home" as const };
const arrived: TabToShell = { ...base, type: "policy-arrived", name: "home/policy.json", via: "watch", message: "policy arrived from modal after 229 s of training", host: "modal", training_seconds: 229.2, mjcf_sha256: "cfd5", switched_body: null, arrival_to_installed_ms: 10, bytes: 209978 };
const walked: TabToShell = { ...base, type: "policy-walked", name: "home/policy.json", arrival_to_installed_ms: 10, arrival_to_walking_ms: 1014, sim_seconds_to_walking: 1.02, mean_speed: 0.487, window_seconds: 10, fell: false };
const run = (source: "live" | "scripted"): ShowEvent => ({ t: "run", at: 0, run: "r", origin: 0, environments: [], source });

test("an arrival becomes a measured install time and, apart, what the file says about itself", () => {
  const notes = notesFromTabEvent(arrived, 5000);
  assert.deepEqual(notes.map((n) => [n.text, n.measured ?? false, n.basis ?? null]), [
    ["Policy installed in the walking creature in 10 ms (timed in the tab).", true, null],
    ["policy arrived from modal after 229 s of training", false, "reported"],
  ]);
  assert.ok(notes.every((n) => n.origin === "tab" && n.kind === "home" && n.at === 5000));
});

test("a walk becomes a measured time to walking and, apart, the simulation's mean speed", () => {
  const notes = notesFromTabEvent(walked, 9000);
  assert.deepEqual(notes.map((n) => [n.text, n.measured ?? false, n.basis ?? null]), [
    ["Walking 1014 ms after the policy arrived (timed in the tab).", true, null],
    ["Mean speed 0.49 m/s over 10 simulated seconds.", false, "simulated"],
  ]);
});

test("a creature that never walked off states no time, and a fall is said", () => {
  const fell = notesFromTabEvent({ ...walked, arrival_to_walking_ms: null, sim_seconds_to_walking: null, mean_speed: 0.1, fell: true }, 1);
  assert.equal(fell.length, 2);
  assert.equal(fell[0].text, "The creature fell before it walked off.");
  assert.ok(!fell[0].measured && !/\d/.test(fell[0].text));
  assert.match(fell[1].text, /and it fell/);
  assert.equal(notesFromTabEvent({ ...walked, arrival_to_walking_ms: null, mean_speed: null }, 1).length, 1);
});

test("a switched body and a refusal are told in the tab's own words; other events make no notes", () => {
  assert.match(notesFromTabEvent({ ...arrived, switched_body: "quadruped 2-DOF" }, 1).at(-1)!.text, /switched to the quadruped 2-DOF body/);
  assert.equal(notesFromTabEvent({ ...base, type: "policy-refused", name: "x", reason: "could not fetch /policy/home.json: HTTP 404" }, 1)[0].text, "Policy refused: could not fetch /policy/home.json: HTTP 404");
  assert.deepEqual(notesFromTabEvent({ ...base, type: "kicked", force_n: 60, t: 3 }, 1), []);
});

test("captions: measured by the tab, simulated and reported are tagged apart, even on the scripted feed", () => {
  for (const source of ["live", "scripted"] as const) {
    const s = fold([run(source)]);
    const tabNotes = [...notesFromTabEvent(arrived, 1000), ...notesFromTabEvent(walked, 1000)];
    const caps = captionsFor({ ...s, notes: tabNotes }, 1100, 6);
    assert.deepEqual(caps.map((c) => c.tag), ["measured", "reported", "measured", "simulated"], source);
  }
});

test("a scripted feed's own numbers are still scripted when the tab's are real", () => {
  const s = fold([run("scripted"), { t: "note", at: 500, kind: "switch", text: "Switched in 908 ms." }]);
  const caps = captionsFor({ ...s, notes: [...s.notes, ...notesFromTabEvent(walked, 600)] }, 700, 6);
  assert.deepEqual(caps.map((c) => c.tag), ["scripted", "measured", "simulated"]);
});

test("a mode change is the simulation's arithmetic: simulated, never measured, with the simulated time and the uprightness", () => {
  const down = notesFromTabEvent({ ...base, type: "mode-changed", mode: "getup", t: 12.34, up: 0.21 }, 4000);
  assert.equal(down.length, 1);
  assert.equal(down[0].basis, "simulated");
  assert.ok(!down[0].measured);
  assert.equal(down[0].text, "The creature went down (torso upright 0.21) and the getup network took over at 12.3 s of simulated time.");
  const up = notesFromTabEvent({ ...base, type: "mode-changed", mode: "walk", t: 14.9, up: 0.93 }, 5000);
  assert.equal(up[0].text, "Back on its feet (torso upright 0.93) and walking again at 14.9 s of simulated time.");
  assert.equal(up[0].basis, "simulated");
  assert.ok([...down, ...up].every((n) => n.origin === "tab" && n.kind === "home"));
});

test("a kick that topples a getup policy: only the mode changes make notes, in order, each tagged simulated even on the scripted feed", () => {
  const events: TabToShell[] = [
    { ...base, type: "kicked", force_n: 60, t: 10 },
    { ...base, type: "fell", t: 10.4 },
    { ...base, type: "mode-changed", mode: "getup", t: 10.5, up: 0.25 },
    { ...base, type: "mode-changed", mode: "walk", t: 13.1, up: 0.95 },
    { ...base, type: "stood", t: 15.1, since_kick: 5.1 },
  ];
  let at = 100;
  const notes = events.flatMap((e) => notesFromTabEvent(e, at++));
  assert.deepEqual(notes.map((n) => n.text.split(" ").slice(0, 3).join(" ")), ["The creature went", "Back on its"]);
  for (const source of ["live", "scripted"] as const) {
    const caps = captionsFor({ ...fold([run(source)]), notes }, 200, 6);
    assert.deepEqual(caps.map((c) => c.tag), ["simulated", "simulated"], source);
  }
});
