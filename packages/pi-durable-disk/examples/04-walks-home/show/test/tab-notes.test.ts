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

// v2: the take is shown in plain words. A checkpoint from the GPU is a reported fact (what the file says about itself); the distance
// it walked is the tab's own simulation, so SIMULATED; nothing here is a measurement except what the tab timed.
const checkpoint = (n: number, over: Partial<Extract<TabToShell, { type: "policy-arrived" }>> = {}): TabToShell => ({ ...arrived, kind: "checkpoint", checkpoint_n: n, steps: 2_000_000, wall_s: 63, reported_walk_10s_m: null, ...over }) as TabToShell;

test("a checkpoint arriving from the GPU is told in plain words and tagged reported, with its number", () => {
  const notes = notesFromTabEvent(checkpoint(4), 7000, { plain: true });
  assert.deepEqual(notes.map((n) => [n.text, n.measured ?? false, n.basis ?? null]), [["Version 4 of its brain arrived from the GPU, after 63 s of training.", false, "reported"]]);
  assert.ok(notes.every((n) => n.origin === "tab" && n.kind === "home"));
  assert.equal(notesFromTabEvent(checkpoint(2, { wall_s: null }), 1, { plain: true })[0]!.text, "Version 2 of its brain arrived from the GPU.");
  assert.equal(notesFromTabEvent(checkpoint(1, { checkpoint_n: undefined, wall_s: null }), 1, { plain: true })[0]!.text, "A new version of its brain arrived from the GPU.");
});

test("at home the tab's own walk is told in the one fixed window only: a measurement that was cut short is not shown as a 10 s one", () => {
  const w = (over: Partial<Extract<TabToShell, { type: "policy-walked" }>>): TabToShell => ({ ...walked, ...over }) as TabToShell;
  const home = notesFromTabEvent(w({ mean_speed: 0.46, window_seconds: 10 }), 1, { plain: true, kind: "final" });
  assert.equal(home.at(-1)!.text, "In your browser it walks 4.6 m in 10 s.");
  assert.equal(home.at(-1)!.basis, "simulated");
  const short = notesFromTabEvent(w({ mean_speed: 0.5, window_seconds: 7.1, partial: true }), 1, { plain: true, kind: "final" });
  assert.ok(!short.some((n) => /walks \d/.test(n.text)), "a 7.1 s window is not told as 10 s, nor as 7.1 s next to 10 s ones");
  const fell = notesFromTabEvent(w({ mean_speed: 0.02, window_seconds: 10, fell: true }), 1, { plain: true, kind: "final" });
  assert.equal(fell.at(-1)!.text, "The creature fell over within 10 s.");
});

test("a creature put back on its feet by a checkpoint, a getup and a recovery are said plainly, with no number to tag", () => {
  const stood = notesFromTabEvent({ ...base, type: "stood-up", reason: "checkpoint" }, 1, { plain: true });
  assert.deepEqual(stood.map((n) => [n.text, n.basis ?? null]), [["A new version of its brain arrived while it was lying down, and it stood back up.", null]]);
  const down = notesFromTabEvent({ ...base, type: "mode-changed", mode: "getup", t: 3.2, up: 0.12 }, 1, { plain: true });
  const up = notesFromTabEvent({ ...base, type: "mode-changed", mode: "walk", t: 4.5, up: 0.95 }, 1, { plain: true });
  assert.equal(down[0]!.text, "It was down. It learned to get back up.");
  assert.equal(up[0]!.text, "Back on its feet and walking again.");
  assert.ok([...down, ...up].every((n) => !/\d/.test(n.text)));
  assert.match(notesFromTabEvent({ ...base, type: "mode-changed", mode: "getup", t: 3.2, up: 0.12 }, 1)[0]!.text, /torso upright 0\.12/, "the debug wording is unchanged");
});

test("the untrained label and the network event make no note here; the page handles them", () => {
  assert.deepEqual(notesFromTabEvent({ ...base, type: "untrained", reason: "no policy" }, 1, { plain: true }), []);
  assert.deepEqual(notesFromTabEvent({ ...base, type: "network", online: false }, 1, { plain: true }), []);
});

test("plain captions pass through the caption rule: reported is never shown as measured, and a version's caption is reported", () => {
  const notes = notesFromTabEvent(checkpoint(4, { reported_walk_10s_m: 0.17 }), 7000, { plain: true });
  const s = { ...fold([run("live")]), notes };
  assert.deepEqual(captionsFor(s, 7100, 3).map((c) => [c.text, c.tag]), [["Version 4: shuffling forward - 0.17 m in 10 s", "reported"]]);
});

// A cold viewer saw "1.999999999999602 simulated seconds" on screen. Seconds are shown as people say them: whole, or to a tenth.
test("no number on screen carries float noise: seconds are whole or to a tenth", () => {
  const w = (over: Partial<Extract<TabToShell, { type: "policy-walked" }>>): TabToShell => ({ ...walked, ...over }) as TabToShell;
  const noisy = notesFromTabEvent(w({ mean_speed: 0.46, window_seconds: 9.999999999999602 }), 1, { plain: true, kind: "final" });
  assert.equal(noisy.at(-1)!.text, "In your browser it walks 4.6 m in 10 s.");
  const debug = notesFromTabEvent(w({ mean_speed: 0.5, window_seconds: 9.999999999999 }), 1);
  assert.equal(debug.at(-1)!.text, "Mean speed 0.50 m/s over 10 simulated seconds.");
  const fell = notesFromTabEvent(w({ mean_speed: 0.1, window_seconds: 7.300000000001, fell: true }), 1, { plain: true, kind: "final" });
  assert.equal(fell.at(-1)!.text, "The creature fell over within 7.3 s.");
  const arrival = notesFromTabEvent(checkpoint(2, { reported_walk_10s_m: 0.30000000000000004 }), 1, { plain: true });
  assert.equal(arrival[0]!.text, "Version 2: shuffling forward - 0.30 m in 10 s");
  for (const n of [...noisy, ...debug, ...fell, ...arrival]) assert.doesNotMatch(n.text, /\d\.\d{3,}/, n.text);
});

test("the v2 captions say only what a viewer can use: a checkpoint's result, never an internal state", () => {
  const w = (over: Partial<Extract<TabToShell, { type: "policy-walked" }>>): TabToShell => ({ ...walked, ...over }) as TabToShell;
  // A policy that has no speed to report makes no caption at all in plain words (the debug log keeps its line).
  assert.deepEqual(notesFromTabEvent(w({ mean_speed: null, arrival_to_walking_ms: null, fell: false }), 1, { plain: true, kind: "final" }), []);
  assert.match(notesFromTabEvent(w({ mean_speed: null, arrival_to_walking_ms: null, fell: false }), 1)[0]!.text, /did not walk off in time/);
});

// The learning arc: each checkpoint's lesson is read from the distance its own file reports, not from the clock.
test("a checkpoint teaches the lesson its own reported distance supports, tagged reported, with its number", () => {
  const lesson = (n: number, d: number | null) => notesFromTabEvent(checkpoint(n, { reported_walk_10s_m: d }), 1, { plain: true });
  assert.deepEqual(lesson(1, 0.04).map((n) => [n.text, n.basis]), [["Version 1: don't fall over - 0.04 m in 10 s", "reported"]]);
  assert.equal(lesson(3, 0.15)[0]!.text, "Version 3: shuffling forward - 0.15 m in 10 s");
  assert.equal(lesson(6, 3.59)[0]!.text, "Version 6: first steps - 3.6 m in 10 s");
  assert.equal(lesson(8, 4.76)[0]!.text, "Version 8: walking - 4.8 m in 10 s", "every version has a caption, walking ones too");
  assert.equal(lesson(4, null)[0]!.text, "Version 4 of its brain arrived from the GPU, after 63 s of training.", "a file with no distance says only that it arrived");
});

test("the tab's own walk of a checkpoint is not captioned in the clean view: the version's caption already has its distance in the one fixed window", () => {
  const w = (n: number, over: Partial<Extract<TabToShell, { type: "policy-walked" }>> = {}): TabToShell => ({ ...walked, mean_speed: 0.26, window_seconds: 10, checkpoint_n: n, ...over }) as TabToShell;
  for (const over of [{}, { fell: true }, { partial: true, window_seconds: 7.1 }, { outcome: "cut-short" as const }]) assert.deepEqual(notesFromTabEvent(w(8, over), 1, { plain: true, kind: "checkpoint" }), [], JSON.stringify(over));
  assert.match(notesFromTabEvent(w(5), 1, { kind: "checkpoint" })[0]!.text, /Walking 1014 ms after the policy arrived/, "the debug log keeps everything");
});

// D3's `outcome` says why a walk has no time: do not read a failure out of a null.
const w2 = (over: Partial<Extract<TabToShell, { type: "policy-walked" }>>): TabToShell => ({ ...walked, ...over }) as TabToShell;

test("the debug log says what happened to a walk from the tab's own outcome: cut short is not a failure", () => {
  const cut = notesFromTabEvent(w2({ outcome: "cut-short", arrival_to_walking_ms: null, sim_seconds_to_walking: null, mean_speed: 0.2, window_seconds: 6, partial: true }), 1);
  assert.equal(cut[0]!.text, "The next checkpoint arrived before this one's test was over.");
  assert.ok(!cut.some((n) => /did not walk off/.test(n.text)));
  assert.match(notesFromTabEvent(w2({ outcome: "not-walking", arrival_to_walking_ms: null, mean_speed: 0.02 }), 1)[0]!.text, /did not walk off in time/);
  assert.match(notesFromTabEvent(w2({ outcome: "fell", arrival_to_walking_ms: null, fell: true }), 1)[0]!.text, /fell before it walked off/);
  const walkedCut = notesFromTabEvent(w2({ outcome: "walked", partial: true }), 1);
  assert.match(walkedCut[0]!.text, /^Walking 1014 ms after the policy arrived/, "it walked, even though the measurement was cut short");
});

test("in plain words a walk that never walked off is not captioned at all", () => {
  assert.deepEqual(notesFromTabEvent(w2({ outcome: "not-walking", arrival_to_walking_ms: null, mean_speed: 0.02, checkpoint_n: 5 }), 1, { plain: true, kind: "checkpoint" }), []);
  assert.deepEqual(notesFromTabEvent(w2({ outcome: "not-walking", arrival_to_walking_ms: null, mean_speed: 0.02 }), 1, { plain: true, kind: "final" }), []);
});

// A cold viewer could not follow "checkpoint", "policy" or "getup brain". In the v2 view the words are the ones a person would use.
test("the trained brain coming home is told without jargon: installed, how long it trained, how fast it walks", () => {
  const home = notesFromTabEvent({ ...arrived, kind: "final", checkpoint_n: 11, training_seconds: 229.4 } as TabToShell, 1, { plain: true });
  assert.deepEqual(home.map((n) => [n.text, n.measured ?? false, n.basis ?? null]), [
    ["The trained brain was installed in your browser in 10 ms (timed in the tab).", true, null],
    ["It trained for 229 s before coming home.", false, "reported"],
  ]);
  const walkedHome = notesFromTabEvent({ ...walked, mean_speed: 0.46, window_seconds: 10 } as TabToShell, 1, { plain: true, kind: "final" });
  assert.equal(walkedHome[0]!.text, "It was walking 1014 ms after the new brain arrived (timed in the tab).");
  assert.equal(walkedHome[0]!.measured, true);
  assert.equal(notesFromTabEvent({ ...arrived, kind: "final", training_seconds: null } as TabToShell, 1, { plain: true }).length, 1, "no training time reported: no claim about it");
  assert.equal(notesFromTabEvent({ ...base, type: "policy-refused", name: "x", reason: "could not fetch /policy/home.json: HTTP 404" } as TabToShell, 1, { plain: true })[0]!.text, "The new brain could not be loaded, so the creature kept what it had.", "plain words, not the tab's reason");
});

test("no plain caption uses the words a viewer could not follow", () => {
  const w = (over: Partial<Extract<TabToShell, { type: "policy-walked" }>>): TabToShell => ({ ...walked, ...over }) as TabToShell;
  const all = [
    ...notesFromTabEvent(checkpoint(4), 1, { plain: true }),
    ...notesFromTabEvent(checkpoint(2, { reported_walk_10s_m: 0.05 }), 1, { plain: true }),
    ...notesFromTabEvent(checkpoint(6, { reported_walk_10s_m: 3.2 }), 1, { plain: true }),
    ...notesFromTabEvent(w({ mean_speed: 0.5, checkpoint_n: 8 }), 1, { plain: true, kind: "checkpoint" }),
    ...notesFromTabEvent(w({ mean_speed: 0.5, fell: true, checkpoint_n: 3 }), 1, { plain: true, kind: "checkpoint" }),
    ...notesFromTabEvent({ ...arrived, kind: "final" } as TabToShell, 1, { plain: true }),
    ...notesFromTabEvent(w({ mean_speed: 0.5 }), 1, { plain: true, kind: "final" }),
    ...notesFromTabEvent({ ...base, type: "stood-up", reason: "checkpoint" }, 1, { plain: true }),
    ...notesFromTabEvent({ ...base, type: "mode-changed", mode: "getup", t: 3, up: 0.1 }, 1, { plain: true }),
    ...notesFromTabEvent({ ...base, type: "mode-changed", mode: "walk", t: 4, up: 0.9 }, 1, { plain: true }),
    ...notesFromTabEvent({ ...base, type: "policy-refused", name: "x", reason: "y" }, 1, { plain: true }),
  ];
  assert.ok(all.length >= 9);
  for (const n of all) assert.doesNotMatch(n.text, /checkpoint|policy|getup|combined|network/i, n.text);
});

// Greptile on #110: a refusal's own reason is a developer's sentence. Real ones, from the tab's arrival.ts.
test("a refusal is told in plain words whatever the tab's reason says, and the debug log keeps the reason", () => {
  const refused = (reason: string) => ({ ...base, type: "policy-refused", name: "home/policy.json", reason }) as TabToShell;
  const real = [
    "could not fetch /policy/home.json: HTTP 404",
    "the file is not valid JSON",
    "the file is not a policy object",
    'unknown format "mlp-v2", expected mlp-v1',
    'unknown spec_version "9"',
    "mjcf_sha256 is missing or malformed",
    "the policy was trained for a body that is neither the one on screen nor a preset (mjcf_sha256 differs)",
    "something nobody planned for",
  ];
  const says = real.map((r) => notesFromTabEvent(refused(r), 1, { plain: true })[0]!.text);
  assert.deepEqual(says, [
    "The new brain could not be loaded, so the creature kept what it had.",
    "The brain file was damaged or in the wrong form, so the tab did not use it.",
    "The brain file was damaged or in the wrong form, so the tab did not use it.",
    "The brain file was damaged or in the wrong form, so the tab did not use it.",
    "The brain file was damaged or in the wrong form, so the tab did not use it.",
    "The brain file was damaged or in the wrong form, so the tab did not use it.",
    "That brain was trained for a different body, so the tab did not use it.",
    "The tab could not use that brain.",
  ]);
  for (const t of says) assert.doesNotMatch(t, /policy|mjcf|sha|json|http|mlp|spec|\//i, t);
  assert.match(notesFromTabEvent(refused(real[0]!), 1)[0]!.text, /Policy refused: could not fetch \/policy\/home\.json: HTTP 404/, "the debug log keeps the tab's own words");
});
