import assert from "node:assert/strict";
import { test } from "node:test";
import { badgeFor } from "../page/badge.ts";
import { chatHtml, visibleTurns } from "../page/chat.ts";
import { emptyState } from "../reduce.ts";
import type { ChatTurn, Place } from "../types.ts";

const at = (place: Place) => ({ ...emptyState(), place });

const stayOf = (host: string, hostKind: "tab" | "gpu", from = 0) => ({ id: `${host}${from}`, lane: "run", host, hostKind, from, to: null });
const BACK = [stayOf("your browser", "tab"), stayOf("a cloud GPU (Modal H100)", "gpu", 10), stayOf("your browser", "tab", 90)];

test("the header says what happened to the agent in plain words, from the pipe's own label for the machine", () => {
  const gpu = "a cloud GPU (Modal H100)";
  assert.deepEqual(badgeFor(at({ where: "tab", host: "This tab" })), { text: "Your agent is in your browser", tone: "tab", memory: false });
  assert.deepEqual(badgeFor(at({ where: "moving", to: gpu, host: "This tab" })), { text: `Your agent is moving to ${gpu}\u2026`, tone: "moving", memory: true });
  assert.deepEqual(badgeFor(at({ where: "cloud", host: gpu })), { text: `Your agent moved to ${gpu} to train`, tone: "cloud", memory: true });
  assert.deepEqual(badgeFor({ ...at({ where: "home", host: "This tab" }), stays: BACK }), { text: "Your agent is back in your browser", tone: "tab", memory: false });
  assert.equal(badgeFor({ ...at({ where: "moving", to: "This tab", host: gpu }), stays: BACK.slice(0, 2) }).text, "Your agent is moving back to your browser\u2026");
  assert.deepEqual(badgeFor(at({ where: "parked" })), { text: "Your agent is waiting", tone: "parked", memory: false });
  assert.doesNotMatch(badgeFor(at({ where: "cloud", host: "Modal-less label" })).text, /Modal(?!-less)/, "no provider the feed did not name");
});

test("the cloud-disk sentence is shown for as long as the agent is away, and not at home", () => {
  for (const place of [{ where: "moving", to: "X", host: "This tab" }, { where: "cloud", host: "X" }, { where: "universes", host: "X" }] as const) assert.equal(badgeFor(at(place)).memory, true, place.where);
  for (const place of [{ where: "tab", host: "x" }, { where: "home", host: "x" }, { where: "parked" }] as const) assert.equal(badgeFor(at(place)).memory, false, place.where);
});

const turn = (id: string, role: "user" | "agent", text: string, streaming?: boolean): ChatTurn => ({ id, role, text, ...(streaming ? { streaming } : {}) });

test("the chat shows the user's words and the agent's, newest last, a streaming line with a caret, and escapes everything", () => {
  const html = chatHtml([turn("u1", "user", "teach it to walk"), turn("a1", "agent", "I'm <b>taking</b> us to a GPU", true)]);
  assert.match(html, /<div class="turn user" data-id="u1"><div class="who">You<\/div><div class="said">teach it to walk<\/div><\/div>/);
  assert.match(html, /class="turn agent streaming"[^>]*><div class="who">Agent<\/div><div class="said">I&#39;m &lt;b&gt;taking&lt;\/b&gt; us to a GPU<span class="caret"><\/span>/);
  assert.ok(!html.includes("<b>taking</b>"));
  assert.ok(html.indexOf("teach it") < html.indexOf("taking"));
});

test("only the last turns are shown and the older ones are dimmed", () => {
  const turns = Array.from({ length: 9 }, (_, i) => turn(`t${i}`, i % 2 ? "agent" : "user", `line ${i}`));
  assert.deepEqual(visibleTurns(turns).map((t) => t.id), ["t3", "t4", "t5", "t6", "t7", "t8"]);
  const html = chatHtml(turns);
  assert.equal((html.match(/ old"/g) ?? []).length, 3);
  assert.ok(!html.includes("line 2"));
});

import { trackFor } from "../page/badge.ts";
import type { ShowState } from "../types.ts";

const withEnvs = (place: Place, environments: ShowState["environments"]): ShowState => ({ ...emptyState(), place, environments });
const ENVS: ShowState["environments"] = [{ id: "tab", label: "Your browser tab", kind: "tab" }, { id: "gpu", label: "H100 GPU, Virginia", kind: "gpu" }];

test("the track shows the browser, the machine it can go to, and where the agent is between them", () => {
  assert.deepEqual(trackFor(withEnvs({ where: "tab", host: "Your browser tab" }, ENVS)), { left: "your browser", right: "H100 GPU, Virginia", at: "left" });
  assert.deepEqual(trackFor(withEnvs({ where: "moving", to: "H100 GPU, Virginia", host: "x" }, ENVS)), { left: "your browser", right: "H100 GPU, Virginia", at: "between" });
  assert.deepEqual(trackFor(withEnvs({ where: "cloud", host: "H100 GPU, Virginia" }, ENVS)), { left: "your browser", right: "H100 GPU, Virginia", at: "right" });
  assert.deepEqual(trackFor(withEnvs({ where: "home", host: "x" }, ENVS)).at, "left");
  assert.equal(trackFor(withEnvs({ where: "parked" }, ENVS)).at, "none");
});

test("with no machine listed the track names the one the agent is on, and shows only the browser before it has anywhere to go", () => {
  assert.equal(trackFor(withEnvs({ where: "cloud", host: "Modal H100" }, [{ id: "tab", label: "tab", kind: "tab" }])).right, "Modal H100");
  assert.equal(trackFor(withEnvs({ where: "tab", host: "tab" }, [{ id: "tab", label: "tab", kind: "tab" }])).right, null);
});

import { cardShown, cardTag, cardVisible, decisionCardHtml } from "../page/decision-card.ts";

const shown = (over: Record<string, unknown> = {}) => ({ id: "d1", phase: "start" as const, question: "Where should this run?", options: [{ id: "tab", label: "Browser", probability: 0.02 }, { id: "modal-vm", label: "Modal VM", probability: 0.04 }, { id: "modal-gpu", label: "H100 GPU", probability: 0.94 }], choice: "modal-gpu", latencyMs: 36.6, model: "jev" as const, at: 10_000, ...over });

test("the card asks the question, shows a bar and a percent per option, lights the chosen one, and says how long it took", () => {
  const html = decisionCardHtml(shown(), "live");
  assert.match(html, /<h3>Where should this run\?<\/h3>/);
  assert.match(html, /<span class="name">Browser<\/span><span class="bar"><i style="--w:2\.0%"><\/i><\/span><span class="pct">2%<\/span>/);
  assert.match(html, /class="opt chosen"><span class="name">H100 GPU<\/span><span class="bar"><i style="--w:94\.0%"><\/i><\/span><span class="pct">94%<\/span>/);
  assert.equal((html.match(/class="opt chosen"/g) ?? []).length, 1);
  assert.match(html, /decided by TypeSafe Jev in 37 ms/);
  assert.match(html, /<span class="tag measured">measured<\/span>/);
});

test("only the typed model's decision on a live feed is measured; a stand-in or a rehearsal says scripted", () => {
  assert.equal(cardTag(shown(), "live"), "measured");
  assert.equal(cardTag(shown({ model: "scripted" }), "live"), "scripted");
  assert.equal(cardTag(shown(), "scripted"), "scripted");
  assert.match(decisionCardHtml(shown({ model: "scripted" }), "live"), /decided by a stand-in in 37 ms/);
});

test("the card is up for a few seconds from the decision, and not before it", () => {
  const d = shown();
  assert.equal(cardVisible(d, 9_999), false);
  assert.equal(cardVisible(d, 10_000), true);
  assert.equal(cardVisible(d, 15_999), true);
  assert.equal(cardVisible(d, 16_000), false);
  assert.equal(cardVisible(null, 10_000), false);
});

test("text in a decision is escaped", () => {
  const html = decisionCardHtml(shown({ question: "<img src=x>", options: [{ id: "a", label: "<b>A</b>", probability: 0.5 }, { id: "b", label: "B", probability: 0.5 }], choice: "a" }), "live");
  assert.ok(!html.includes("<img") && !html.includes("<b>A"));
});

// Greptile on #107: with two machines listed, the marker must name the one the agent is on, or moving to, not the first listed.
const TWO: ShowState["environments"] = [{ id: "tab", label: "Your browser tab", kind: "tab" }, { id: "vm", label: "Modal VM", kind: "vm" }, { id: "gpu", label: "H100 GPU", kind: "gpu" }];
const stay = (host: string, hostKind: "tab" | "vm" | "gpu", from: number) => ({ id: `s${from}`, lane: "run", host, hostKind, from, to: null });

test("with a VM listed before a GPU the track names the machine the agent is on or moving to, never the first listed", () => {
  assert.equal(trackFor(withEnvs({ where: "cloud", host: "H100 GPU" }, TWO)).right, "H100 GPU");
  assert.equal(trackFor(withEnvs({ where: "cloud", host: "Modal VM" }, TWO)).right, "Modal VM");
  assert.equal(trackFor(withEnvs({ where: "moving", to: "H100 GPU", host: "Your browser tab" }, TWO)).right, "H100 GPU", "moving out: the target");
  assert.equal(trackFor(withEnvs({ where: "moving", to: "Your browser tab", host: "H100 GPU" }, TWO)).right, "H100 GPU", "moving home: the machine it is leaving");
});

test("at home the track still names the machine the agent came from, and before it has gone anywhere the first one listed", () => {
  const back = { ...withEnvs({ where: "home", host: "Your browser tab" }, TWO), stays: [stay("Your browser tab", "tab", 0), stay("H100 GPU", "gpu", 10), stay("Your browser tab", "tab", 90)] };
  assert.equal(trackFor(back).right, "H100 GPU");
  assert.equal(trackFor(withEnvs({ where: "tab", host: "Your browser tab" }, TWO)).right, "Modal VM", "no machine visited yet: the first listed");
});

test("the decision card's own tag is not drawn in the clean view, but is kept for the debug view", () => {
  assert.doesNotMatch(decisionCardHtml(shown(), "live", { pill: false }), /class="tag/);
  assert.match(decisionCardHtml(shown(), "live", { pill: true }), /<span class="tag measured">measured<\/span>/);
  assert.match(decisionCardHtml(shown(), "live"), /class="tag measured"/, "the debug view is the default");
  assert.match(decisionCardHtml(shown(), "live", { pill: false }), /decided by TypeSafe Jev in 37 ms/, "the words stay");
});

// Cold view 4: "decided by a stand-in in 0 ms" read as an admission that the agent's choice was canned.
test("the clean view shows the decision card only for a real decision by the typed model; a stand-in's is kept as a record, and the debug view shows it", () => {
  assert.equal(cardShown(shown({ model: "jev" }), "live", false), true);
  assert.equal(cardShown(shown({ model: "scripted" }), "live", false), false, "a scripted placement is not shown to the viewer");
  assert.equal(cardShown(shown({ model: "jev" }), "scripted", false), false, "a rehearsal's feed is scripted whatever the card says");
  assert.equal(cardShown(shown({ model: "scripted" }), "live", true), true, "?debug=1 shows everything");
  assert.equal(cardShown(null, "live", false), false);
});
