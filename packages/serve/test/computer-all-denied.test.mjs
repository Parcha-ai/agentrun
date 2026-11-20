// A computer every tool of which is set to deny is never started (computer-for-claim.ts, tool-gate.ts computerDenied):
// its provider is never asked for one, nothing is rented, and the run goes on with what else it has, its kind's tools and
// skill not handed. A computer one of whose tools is allowed starts as before. And the first deny of a call of the run's
// computer's own tools turns that computer off for the rest of the run (RunGate.decide): the refusal says so once, and
// each later call of its tools is refused on the runner, short, never sent to the computer, a setting changed since or
// not. The pi spec (adapter-run-spec.ts) through specFor, as the runner builds it; the desktop is --faux's through the
// runner's one composer (computerDepsFrom) with its launches counted, the phone a provider whose loads are counted, and
// a fake phone (workspace-fake-computer.mjs) whose calls are recorded. Loopback only: no provider, no key.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as bg } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { COMPUTER_TOOLS } from "@parcha/agentrun-kernel/kernel";
import { specFor, toolNames } from "./runner-spec-support.mjs";
import { fakeComputer } from "./workspace-fake-computer.mjs";

const { computerDepsFrom } = await import("../dist/workspace/index.js");
const { fauxComputers } = await import("../dist/faux-computers.js");
const { computerDenied, deniedText } = await import("../dist/tool-gate.js");
const { computerDeniedWords, computerOffText, computerOffWords } = await import("../dist/refusal-words.js");
const { journalEntries } = await import("../dist/runner/journal-reader.js");

/** The root entry a run's first deny of its computer's tools writes (the computer off for the run), as its journal has it. */
const OFF_KIND = "agentrun.computer.off";

const FAUX_DESKTOP = { kind: "desktop", provider: "faux-desktop" };
const PHONE = { kind: "phone", provider: "phone-harness" };
const CLICK = { steps: [{ click: [10, 10] }] };
const ctx = (callId) => ({ callId, signal: new AbortController().signal, attempt: 0 });
const callOf = (spec, name) => spec.session.tools.find((tool) => tool.name === name);

/** The runner's one composer over --faux's computers, each launch it makes counted in `counted.launches`. */
const countingFaux = (counted) => ({ store, sealKey }) => {
  const composed = computerDepsFrom({ env: {}, store, sealKey, faux: fauxComputers() });
  const launch = composed.computerDeps.launch;
  return { ...composed, computerDeps: { ...composed.computerDeps, launch: (...args) => { counted.launches += 1; return launch(...args); } } };
};

/** The runner's one composer with no --faux, each provider it loads counted in `counted.loads` (and none made). */
const countingLoads = (counted) => ({ store, sealKey }) => computerDepsFrom({ env: {}, store, sealKey, load: async (id) => { counted.loads += 1; throw new Error(`no ${id} here`); } });

/** A run whose `read` call answers the file it reads: the run works without its computer. */
async function readsItsFile(spec, workFolder) {
  writeFileSync(join(workFolder, "notes.txt"), "still here\n");
  assert.equal(await spec.gate({ callId: "r1", tool: "read", args: { path: "notes.txt" } }), "allow", "read is allowed");
  const read = await callOf(spec, "read").call({ path: "notes.txt" }, ctx("r1"));
  assert.notEqual(read.isError, true, `the read ran: ${read.text}`);
  assert.match(read.text, /still here/);
}

for (const [where, options] of [["on this server", { settings: { desktop: { permission: "deny" } } }], ["for this agent", { toolSettings: { desktop: { permission: "deny" } } }]]) {
  test(`pi: a desktop set to deny ${where} is never launched: no desktop tool, no desktop skill in the prompt, and the run's read still runs`, async (t) => {
    const counted = { launches: 0 };
    const { spec, workFolder } = await specFor(t, { body: { tools: ["read"], computer: FAUX_DESKTOP, ...(options.toolSettings ? { toolSettings: options.toolSettings } : {}) }, ...(options.settings ? { settings: options.settings } : {}), computer: countingFaux(counted) });
    assert.equal(counted.launches, 0, "the faux desktop's provider made no desktop");
    const names = toolNames(spec);
    assert.deepEqual(COMPUTER_TOOLS.filter((name) => names.includes(name)), [], `no desktop tool is handed: ${JSON.stringify(names)}`);
    assert.doesNotMatch(spec.session.system.join("\n"), /desktop-computer/, "the desktop's skill is named to no one");
    await readsItsFile(spec, workFolder);
  });
}

test("pi: a desktop allowed (its one key, which every desktop tool follows) is launched once and its tools are handed", async (t) => {
  const counted = { launches: 0 };
  const { spec } = await specFor(t, { body: { tools: ["read"], computer: FAUX_DESKTOP }, settings: { desktop: { permission: "allow" }, read: { permission: "deny" } }, computer: countingFaux(counted) });
  assert.equal(counted.launches, 1, "the faux desktop was made");
  assert.ok(toolNames(spec).includes("computer_act"), JSON.stringify(toolNames(spec)));
  assert.equal(await spec.gate({ callId: "a1", tool: "computer_act", args: CLICK }), "allow");
});

test("pi: a phone set to deny is never made: its provider is not even loaded, and the run's read still runs", async (t) => {
  const counted = { loads: 0 };
  const { spec, workFolder } = await specFor(t, { body: { tools: ["read"], computer: PHONE }, settings: { phone: { permission: "deny" } }, computer: countingLoads(counted) });
  assert.equal(counted.loads, 0, "no phone provider was loaded");
  const names = toolNames(spec);
  assert.deepEqual(COMPUTER_TOOLS.filter((name) => names.includes(name)), [], `no phone tool is handed: ${JSON.stringify(names)}`);
  assert.doesNotMatch(spec.session.system.join("\n"), /phone-computer/, "the phone's skill is named to no one");
  await readsItsFile(spec, workFolder);
});

// Every tool a computer serves, by kind: a desktop's or a phone's own (one key), a browser's (its key), and the host tools
// the agent grants where the run's shell is on that computer (a sandbox, a desktop that mounts the folder).
test("computerDenied: a computer is denied only when every tool it serves the run is set to deny, by kind and by where the shell is", () => {
  const read = (settings) => ({ settings, problems: [] });
  const agent = (computer, tools, toolSettings) => ({ kind: "agentic", body: { tools, computer, ...(toolSettings ? { toolSettings } : {}) } });
  const sandbox = { kind: "sandbox", provider: "docker" };
  assert.equal(computerDenied(agent(sandbox, ["read", "bash"]), "computer", read({ read: { permission: "deny" }, bash: { permission: "deny" } })), "sandbox", "a sandbox whose every granted host tool is denied");
  assert.equal(computerDenied(agent(sandbox, ["read", "bash"]), "computer", read({ bash: { permission: "deny" } })), undefined, "read still runs on it");
  assert.equal(computerDenied(agent(sandbox, ["read", "bash"]), "none", read({ read: { permission: "deny" }, bash: { permission: "deny" } })), undefined, "a sandbox that holds no shell serves no tool: not this check's");
  assert.equal(computerDenied(agent({ kind: "desktop", provider: "docker" }, ["read"]), "computer", read({ desktop: { permission: "deny" } })), undefined, "a desktop that mounts the folder still serves read");
  assert.equal(computerDenied(agent({ kind: "desktop", provider: "docker" }, ["read"]), "computer", read({ desktop: { permission: "deny" }, read: { permission: "deny" } })), "desktop");
  assert.equal(computerDenied(agent(PHONE, ["read"]), "local", read({ phone: { permission: "deny" } })), "phone", "a phone serves its own tools alone");
  assert.equal(computerDenied(agent(PHONE, ["read"], { phone: { permission: "deny" } }), "local", read({})), "phone", "the agent's own deny");
  assert.equal(computerDenied(agent(PHONE, ["read"], { phone: { permission: "allow" } }), "local", read({ phone: { permission: "deny" } })), "phone", "the server's deny stands over the agent's allow, as the gate holds it");
  assert.equal(computerDenied(agent(PHONE, ["read"]), "local", read({})), undefined, "allowed by default");
  assert.equal(computerDenied(agent({ kind: "browser", provider: "local-chrome" }, ["browser"]), "none", read({ browser: { permission: "deny" } })), "browser");
  assert.equal(computerDenied(agent({ kind: "none" }, ["read"]), "none", read({ read: { permission: "deny" } })), undefined, "no computer");
  assert.equal(computerDeniedWords("phone"), "Every tool for this agent's phone is set to deny, so a run never starts it: allow one, or set the computer to none.");
});

/** The claim's phone, as a provider hands it: a fake computerd client that records each call (no ui group). */
const phoneComposer = (phone) => () => ({ computerForClaim: async () => ({ computer: { kind: "phone", computer: phone, hello: { protocol: "0.2", version: "0", os: "android", kind: "android", arch: "amd64", groups: ["screen", "input.touch", "apps"] } }, release: async () => {} }) });

test("pi: the model calls a denied phone tool 4 times: the first is refused with the phone off for the run, said once; calls 2-4 are refused on the runner, short, and never reach the phone, a setting allowed again since included", async (t) => {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "computer-all-denied-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const phone = fakeComputer(root);
  phone.overrides["input.actions"] = ({ actions }) => ({ done: actions.length });
  const { spec, server, store, claim } = await specFor(t, { body: { tools: ["read"], computer: PHONE }, computer: phoneComposer(phone) });
  assert.ok(toolNames(spec).includes("computer_act"), "the phone started with its tools allowed");
  const reached = () => phone.calls.filter(([method]) => method !== "hello" && method !== "ping").length;
  const before = reached();
  // Each read of the stored tool settings the runner's gate makes.
  const reads = { n: 0 };
  const get = store.settings.get.bind(store.settings);
  store.settings.get = (...args) => { reads.n += 1; return get(...args); };
  // The owner sets phone to deny while the run is going.
  await server.settings.put("tool-settings", { phone: { permission: "deny" } });
  await server.flush?.();
  const answers = [];
  let readsAfterFirst = 0;
  for (let n = 1; n <= 4; n += 1) {
    const verdict = await spec.gate({ callId: `p${n}`, tool: "computer_act", args: CLICK });
    answers.push(verdict);
    if (verdict === "allow") await callOf(spec, "computer_act").call(CLICK, ctx(`p${n}`));
    // After the first refusal the owner allows phone again: the phone stays off for this run all the same.
    if (n === 1) {
      await server.settings.put("tool-settings", {});
      await server.flush?.();
      readsAfterFirst = reads.n;
    }
  }
  assert.equal(reached(), before, `no call reached the phone: ${JSON.stringify(answers)}; ${JSON.stringify(phone.calls.slice(before))}`);
  assert.equal(reads.n, readsAfterFirst, "calls 2-4 are refused with no settings read");
  // The run's journal says the phone is off for the run, once, so a later claim of the run starts none.
  const offs = (await journalEntries(store.journal(claim), bg)).filter((entry) => entry.kind === OFF_KIND);
  assert.deepEqual(offs.map((entry) => entry.data), [{ computer: "phone" }], "the off is in the run's journal once");
  assert.deepEqual(answers[0], { deny: `${deniedText("phone", "phone", "server")} ${computerOffWords("phone")}` }, "the first: the deny's words, then the phone off for the run");
  for (const [i, answer] of answers.slice(1).entries()) assert.deepEqual(answer, { deny: computerOffText("phone") }, `call ${i + 2} is refused short`);
  const said = answers.map((one) => one.deny ?? "").join("\n");
  assert.equal(said.split(computerOffWords("phone")).length - 1, 1, "the off words are said once");
  // A call of another tool is decided as before: the phone's being off holds no other tool.
  assert.equal(await spec.gate({ callId: "r1", tool: "read", args: { path: "notes.txt" } }), "allow");
});

test("pi: a later claim of a run whose phone an earlier claim's deny turned off starts no phone, its tools allowed again or not: each call of them is refused short, and the run's read still runs", async (t) => {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "computer-all-denied-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const phone = fakeComputer(root);
  const claimed = { n: 0 };
  const composer = phoneComposer(phone);
  const counting = (given) => {
    const made = composer(given);
    return { ...made, computerForClaim: (...args) => { claimed.n += 1; return made.computerForClaim(...args); } };
  };
  // The earlier claim's deny, as its gate wrote it on the run's root; the phone allowed (no setting) since.
  const earlier = (harness) => harness.commit((tx) => tx.appendEntry(ROOT_CONVERSATION_ID, { kind: OFF_KIND, data: { computer: "phone" } }), bg);
  const { spec, workFolder } = await specFor(t, { body: { tools: ["read"], computer: PHONE }, computer: counting, journal: earlier });
  assert.equal(claimed.n, 0, "the claim asked for no phone");
  const names = toolNames(spec);
  assert.deepEqual(COMPUTER_TOOLS.filter((name) => names.includes(name)), [], `no phone tool is handed: ${JSON.stringify(names)}`);
  assert.doesNotMatch(spec.session.system.join("\n"), /phone-computer/, "the phone's skill is named to no one");
  assert.deepEqual(await spec.gate({ callId: "p1", tool: "computer_act", args: CLICK }), { deny: computerOffText("phone") }, "refused short: the off was said in the earlier claim");
  await readsItsFile(spec, workFolder);
});
