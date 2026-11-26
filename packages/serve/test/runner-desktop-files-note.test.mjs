// A desktop that holds none of the run's files (its provider mounts no folder, as --faux's desktop and a desktop with
// exec off): the model is told so once in the run, as the server's note (the model proxy's, as the replaced computer's
// note is told), so it never takes a file it saved on the desktop for one the user gets; and computer_screenshot's
// save_as puts the screen in the run's files, for an agent given write alone. A run not given write, or with write set to
// deny, is told instead that screenshots can't be saved to the run's files. Through the runner, the pi spec and the adapter loop as they really run.
// A resumed claim (a park on a tool's approval, then the approval) never tells the files note again. A person's own
// paired desktop is never deleted when the run ends, so its note never says it is, with write or without.
//
// The desktop is --faux's (faux-computers.ts): nothing is rented. The paired one is the computer package's fake UI
// driver on a socket to this process's attach hub.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { AttachHub, readBackOf } from "@parcha/agentrun-computer";
import { FakeUiDriver, serveUiSocket } from "@parcha/agentrun-computer/fake-ui-driver";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { closeOpenSessions, scriptedOrigin } from "./conformance-pi-adapter.mjs";

const { openSqliteStore } = await import("../dist/store/index.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { CONFORMANCE_TIMING } = await import("../dist/runner/conformance/harness.js");
const { journalRecords } = await import("../dist/runner/journal-reader.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { cliRunSpecFromLaunch } = await import("../dist/runner/cli-run-spec.js");
const { OPENCODE_STANDIN_ENV } = await import("../dist/adapters.js");
const { computerForClaim } = await import("../dist/workspace/index.js");
const { runFolder } = await import("../dist/workspace/paths.js");
const { fauxComputers } = await import("../dist/faux-computers.js");
const { runTimeline } = await import("../dist/store-reads/journal.js");

process.env.AGENTRUN_OPENCODE_STANDIN = "1";
const STAND_IN = fileURLToPath(new URL("./fixtures/fake-opencode-serve.mjs", import.meta.url));
const RUN = "run-1";
const SEAL_KEY = Buffer.alloc(32, 7);
const DESKTOP = { kind: "desktop", provider: "faux-desktop" };
const FAUX = fauxComputers();
after(closeOpenSessions);

/** The note the model is told, exactly, labelled as the server's. */
const NOTE = "AgentRun server note: this desktop's own disk is not this run's files: nothing saved on the desktop reaches the user, and it is deleted when the run ends. Keep anything the user should get in the run's files, the folder your file tools work on; computer_screenshot with save_as saves the screen there as a PNG.";
/** Its row on the run's timeline: the server's, labelled once. */
const ROW = "AgentRun: This desktop's own disk is not this run's files: nothing saved on the desktop reaches the user, and it is deleted when the run ends. Keep anything the user should get in the run's files, the folder your file tools work on; computer_screenshot with save_as saves the screen there as a PNG.";
/** The note of a run not given write, or with write set to deny: a screenshot can't be saved to its files, and no save_as
 *  or file tool is promised. */
const NOTE_NO_FILES = "AgentRun server note: this desktop's own disk is not this run's files: nothing saved on the desktop reaches the user, and it is deleted when the run ends. Screenshots can't be saved to the run's files here (write isn't offered): put what you found in your answer.";
const NOTES = /AgentRun server note: this desktop's own disk[^<]*/g;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const until = async (done, what, ms = 60_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await done();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

const FAUX_DEPS = { kinds: FAUX.kinds, keyTable: FAUX.keyTable, launch: FAUX.launch, providers: {}, spec: () => ({ image: "faux", lifetimeMs: 600_000, network: "open" }), check: { readBackOf } };

/** run-1 on --faux's desktop, run by a runner on the pi spec with `script` as its model, or with `cli` (`{ env }`) on
 *  opencode's CLI spec; `body`, the agent's; `approvers`, given, the server's approvers row. Each pi request's body is
 *  kept in `requests`, and each claim's spec in `specs`. `paired`: the agent's desktop is instead this paired computer
 *  (`{ row, hub }`: its store row, and the hub its socket is on). */
async function desktopRun(t, { script = [], body = { tools: ["read", "write"] }, approvers, cli, paired }) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-desktop-files-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  let runner;
  t.after(async () => {
    await runner?.close().catch(() => {});
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Desk" }, { id: "rev-1", kind: "agentic", body: { instructions: "Look.", computer: paired ? { kind: "desktop", provider: paired.row.id } : DESKTOP, ...body } });
  const model = cli ? { harness: "opencode", model: { provider: "openai", modelId: "gpt-6.1-sol" } } : { harness: "pi", model: { provider: "anthropic", modelId: "claude-sonnet-5.5" } };
  await server.runs.create({ id: RUN, agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { content: "Look." }, title: "t", place: { mode: "runner" }, ...model } });
  if (approvers !== undefined) await server.settings.put("approvers", { approvers });
  await server.flush?.();
  const requests = [];
  const route = { model: "faux-1", provider: { api: "anthropic-messages", origin: "https://route.invalid", credential: () => "not-a-secret" }, fetch: scriptedOrigin(script, requests), price: () => 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, outputCeiling: 100 };
  const deps = { env: cli?.env ?? {}, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY, routeOf: async () => route, computerForClaim, computerDeps: paired ? { ...FAUX_DEPS, attached: { rows: async () => [paired.row], hub: paired.hub } } : FAUX_DEPS };
  const specs = [];
  const kept = async (made) => {
    const spec = await made;
    specs.push(spec);
    return spec;
  };
  runner = startRunner({
    store, name: "runner-a", ...CONFORMANCE_TIMING, leaseMs: 30_000, stopMarginMs: 5_000,
    createLoop: createDispatchLoop({ launchOf: (runId) => store.runs.launch(runId), resolve: (name, given) => (name === "pi" ? createAdapterLoop((claim, run) => kept(adapterRunSpecFromLaunch(given, run, deps, claim))) : name === "opencode" ? createAdapterLoop((claim, run) => kept(cliRunSpecFromLaunch(given, run, deps, claim))) : undefined) }),
  });
  return { dir, server, requests, specs };
}

/** Until the run rests in one of `states`, released; its row. */
const rests = (one, states) => until(async () => {
  const now = await one.server.runs.get(RUN);
  return [...states, "failed", "stopped"].includes(now.state) && now.runner === null && now;
}, `the run rests (${states.join(", ")})`);

const count = (requests, pattern) => requests.map((body) => (JSON.stringify(body).match(pattern) ?? []).length);
const fileRows = (said) => said.filter((summary) => summary?.startsWith("AgentRun: This desktop's own disk"));

test("a desktop that mounts no folder: the model's first request carries the files note once, in its words; the timeline shows it once; a screenshot saved with save_as is in the run's files", { timeout: 120_000 }, async (t) => {
  const one = await desktopRun(t, { script: [{ call: "computer_screenshot", args: { save_as: "shots/desktop.png" } }, { say: "done" }] });
  const row = await rests(one, ["ended"]);
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.equal(one.requests.length, 2, "a screenshot, then the answer");
  assert.deepEqual(count(one.requests, NOTES), [1, 0], "the first request carries it, the next does not");
  assert.equal(JSON.stringify(one.requests[0]).match(NOTES)[0], NOTE, "in its exact words");
  const said = (await runTimeline(one.server, RUN, ctx)).map((entry) => entry.summary);
  assert.deepEqual(fileRows(said), [ROW], "one row of the server's, labelled once");
  const saved = readFileSync(join(runFolder(one.dir, "agent-1", RUN), "shots/desktop.png"));
  assert.deepEqual(saved.subarray(0, 8), PNG_MAGIC, "a PNG, in the run's files");
  assert.match(JSON.stringify(one.requests[1]), /saved as shots\/desktop\.png in the run's files/, "the model is told where it went");
});

/** The computer_screenshot a request offers the model. */
const offeredShot = (request) => request.tools.find((tool) => tool.name === "computer_screenshot");

// Write's deny in the gate's own words is screenshot-save-gate.test.mjs's: here the offered schema refuses save_as first.
test("with the desktop allowed and write set to deny, computer_screenshot offers no save_as, a screenshot with save_as anyway is refused, and nothing is written to the run's files", { timeout: 120_000 }, async (t) => {
  const one = await desktopRun(t, {
    script: [{ call: "computer_screenshot", args: { save_as: "shots/desktop.png" } }, { say: "done" }],
    body: { tools: ["read", "write"], toolSettings: { desktop: { permission: "allow" }, write: { permission: "deny" } } },
  });
  const row = await rests(one, ["ended"]);
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.equal(one.requests.length, 2, "the refused screenshot, then the answer");
  assert.equal(JSON.stringify(one.requests[0]).match(NOTES)?.[0], NOTE_NO_FILES, "the files note says screenshots can't be saved here, and promises no save_as");
  const offered = offeredShot(one.requests[0]);
  assert.ok(offered && !("save_as" in offered.input_schema.properties), `no save_as offered: ${JSON.stringify(offered?.input_schema)}`);
  assert.doesNotMatch(offered.description, /save_as/, "nor named in its words");
  const answered = JSON.stringify(one.requests[1].messages.at(-1));
  assert.match(answered, /save_as/, `the call is refused: ${answered}`);
  assert.doesNotMatch(JSON.stringify(one.requests), /saved as shots/, "nothing says it was saved");
  assert.ok(!existsSync(join(runFolder(one.dir, "agent-1", RUN), "shots/desktop.png")), "nothing in the run's files");
});

test("given write set to ask on a server where no one can approve, or naming no tools list, the files note says screenshots can't be saved and computer_screenshot offers no save_as", { timeout: 120_000 }, async (t) => {
  for (const [what, body, approvers] of [
    ["write asks, no approvers", { tools: ["read", "write"], toolSettings: { desktop: { permission: "allow" }, write: { permission: "ask" } } }, false],
    ["no tools list", { toolSettings: { desktop: { permission: "allow" } } }, undefined],
  ]) {
    const one = await desktopRun(t, { script: [{ say: "done" }], body, approvers });
    const row = await rests(one, ["ended"]);
    assert.equal(row.state, "ended", `${what}: ${JSON.stringify(row)}`);
    assert.equal(JSON.stringify(one.requests[0]).match(NOTES)?.[0], NOTE_NO_FILES, `${what}: the note offers no save_as`);
    const offered = offeredShot(one.requests[0]);
    assert.ok(offered && !("save_as" in offered.input_schema.properties), `${what}: no save_as offered: ${JSON.stringify(offered?.input_schema)}`);
  }
});

test("the same with write set to ask and approvers on: the full note, and save_as offered", { timeout: 120_000 }, async (t) => {
  const one = await desktopRun(t, { script: [{ say: "done" }], body: { tools: ["read", "write"], toolSettings: { desktop: { permission: "allow" }, write: { permission: "ask" } } }, approvers: true });
  const row = await rests(one, ["ended"]);
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.equal(JSON.stringify(one.requests[0]).match(NOTES)?.[0], NOTE, "a person can approve a save: the note offers it");
  assert.ok("save_as" in offeredShot(one.requests[0]).input_schema.properties, "save_as offered");
});

// The direct call and a codemode script's nested call are both refused by the session's check of the offered schema,
// before the gate; the gate's own refusal, for a call that reaches it anyway, is screenshot-save-gate.test.mjs's.
test("an agent not given write: computer_screenshot offers no save_as, and a screenshot with save_as anyway, direct or from a script, is refused and nothing is written to the run's files", { timeout: 120_000 }, async (t) => {
  const one = await desktopRun(t, {
    script: [
      { call: "computer_screenshot", args: { save_as: "shots/desktop.png" } },
      { call: "codemode", args: { script: "return await tools.computer_screenshot({ save_as: \"shots/desktop.png\" });" } },
      { say: "done" },
    ],
    body: { tools: ["read"], toolSettings: { desktop: { permission: "allow" }, codemode: { permission: "allow" } } },
  });
  const row = await rests(one, ["ended"]);
  assert.equal(row.state, "ended", JSON.stringify(row));
  const offered = one.requests[0].tools.find((tool) => tool.name === "computer_screenshot");
  assert.ok(offered, `computer_screenshot is offered: ${JSON.stringify(one.requests[0].tools.map((tool) => tool.name))}`);
  assert.ok(!("save_as" in offered.input_schema.properties), `no save_as offered: ${JSON.stringify(offered.input_schema)}`);
  assert.doesNotMatch(offered.description, /save_as/, "nor named in its words");
  assert.equal(JSON.stringify(one.requests[0]).match(NOTES)?.[0], NOTE_NO_FILES, "the files note says screenshots can't be saved here, and promises no save_as");
  assert.equal(one.requests.length, 3, "the refused screenshot, the refused script, then the answer");
  const direct = JSON.stringify(one.requests[1].messages.at(-1));
  assert.match(direct, /save_as/, `the direct call is refused: ${direct}`);
  const scripted = JSON.stringify(one.requests[2].messages.at(-1));
  assert.match(scripted, /save_as/, `the script's call is refused: ${scripted}`);
  assert.doesNotMatch(JSON.stringify(one.requests), /saved as shots/, "nothing says it was saved");
  assert.ok(!existsSync(join(runFolder(one.dir, "agent-1", RUN), "shots/desktop.png")), "nothing in the run's files");
});

test("the files note is told once a run: the claim that resumes it after a park never tells it again", { timeout: 120_000 }, async (t) => {
  const one = await desktopRun(t, {
    script: [{ call: "computer_screenshot", args: {} }, { say: "done" }],
    body: { tools: ["read", "write"], toolSettings: { desktop: { permission: "ask" } } },
    approvers: true,
  });
  const parked = await rests(one, ["ended", "parked"]);
  assert.equal(parked.state, "parked", JSON.stringify(parked));
  const records = await journalRecords(one.server.journal({ runId: RUN, runner: "reader", epoch: parked.epoch, until: 0, from: parked.state }), ctx);
  const [ask] = records.entries.filter((entry) => entry.kind === "agentrun.ask").map((entry) => entry.data);
  assert.ok(ask, "parked on the screenshot's ask");
  const before = one.requests.length;
  await one.server.command(RUN, { kind: "approve", body: { approval: ask.callId } });
  const row = await until(async () => {
    const now = await one.server.runs.get(RUN);
    return ["ended", "failed", "stopped"].includes(now.state) && now.runner === null && now;
  }, "the run ends");
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.ok(one.requests.length > before, "the resume asked the model");
  assert.equal(count(one.requests, NOTES).reduce((a, b) => a + b, 0), 1, `the files note once in the whole run: ${JSON.stringify(count(one.requests, NOTES))}`);
  const said = (await runTimeline(one.server, RUN, ctx)).map((entry) => entry.summary);
  assert.deepEqual(fileRows(said), [ROW], "its row once");
});

/** Two ends of one socket, delivering in order (a paired computer's driver on one, the hub on the other). */
function socketPair() {
  const ends = [{ text: [], closes: [] }, { text: [], closes: [] }];
  let closed;
  const side = (me, peer) => ({
    send(text) { if (!closed) queueMicrotask(() => peer.text.forEach((listener) => listener(text))); },
    close(code, reason) {
      if (closed) return;
      closed = { code, reason };
      queueMicrotask(() => [...me.closes, ...peer.closes].forEach((listener) => listener(code, reason)));
    },
    onText(listener) { me.text.push(listener); },
    onClose(listener) { me.closes.push(listener); },
    get closed() { return closed; },
  });
  return [side(ends[0], ends[1]), side(ends[1], ends[0])];
}

test("a person's own paired desktop, which mounts no folder: the files note says what is saved on it stays there after the run, never that it is deleted when the run ends, given write or not", { timeout: 120_000 }, async (t) => {
  const { pairedOf } = await import("../dist/workspace/attached-computers.js");
  const OUTLIVES = "this desktop's own disk is not this run's files: nothing saved on the desktop reaches the user, and it stays on the desktop after the run ends.";
  for (const [what, body, keep] of [
    ["given write", undefined, " Keep anything the user should get in the run's files, the folder your file tools work on; computer_screenshot with save_as saves the screen there as a PNG."],
    ["not given write", { tools: ["read"] }, " Screenshots can't be saved to the run's files here (write isn't offered): put what you found in your answer."],
  ]) {
    const driver = new FakeUiDriver({ groups: ["screen", "input.pointer", "input.keys", "apps", "ui"] });
    t.after(() => driver.close());
    const row = { id: "cmp-0000000000000001", name: "Test box", hello: driver.hello(), driver: "0", labels: { owner: "test" }, pairingId: "p-1", createdAt: 0, seenAt: 0, revokedAt: null };
    const hub = new AttachHub();
    const [served, computer] = socketPair();
    serveUiSocket(driver, computer);
    assert.equal((await hub.accept(pairedOf(row), served)).ok, true, `${what}: the paired desktop is attached`);
    const one = await desktopRun(t, { script: [{ say: "done" }], ...(body ? { body } : {}), paired: { row, hub } });
    const ran = await rests(one, ["ended"]);
    assert.equal(ran.state, "ended", `${what}: ${JSON.stringify(ran)}`);
    const told = JSON.stringify(one.requests[0]).match(NOTES)?.[0];
    assert.equal(told, `AgentRun server note: ${OUTLIVES}${keep}`, `${what}: the model is told the paired desktop outlives the run`);
    const said = (await runTimeline(one.server, RUN, ctx)).map((entry) => entry.summary);
    assert.deepEqual(fileRows(said), [`AgentRun: T${OUTLIVES.slice(1)}${keep}`], `${what}: and the person reading the run is never told their computer is deleted`);
  }
});

/** A model gateway opencode's stand-in talks to, answering "Done." to each request, and the env that points it there;
 *  each POST's body is kept in `bodies`. */
async function opencodeGateway(t) {
  const bodies = [];
  const gw = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    if (req.method === "POST") bodies.push(text);
    const events = [
      { type: "response.output_text.delta", item_id: "m_0", output_index: 0, content_index: 0, delta: "Done." },
      { type: "response.completed", response: { id: "resp_0", object: "response", status: "completed", usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 0 } } } },
    ];
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
  });
  await new Promise((resolve) => gw.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => gw.close(resolve)));
  const env = { AGENT_MODEL_BASE_URL: `http://127.0.0.1:${gw.address().port}`, AGENT_MODEL_API_KEY: "not-a-secret", [OPENCODE_STANDIN_ENV]: JSON.stringify({ command: process.execPath, args: [STAND_IN] }), PATH: process.env.PATH };
  return { env, bodies };
}

test("a CLI harness (opencode) on a desktop that mounts no folder: its first main-model request carries the files note once, and the timeline shows it once", { timeout: 120_000 }, async (t) => {
  const { env, bodies } = await opencodeGateway(t);
  const one = await desktopRun(t, { body: { harness: "opencode", tools: ["read", "write"] }, cli: { env } });
  const row = await rests(one, ["ended"]);
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.ok(bodies.length >= 1, "a request was sent");
  assert.deepEqual(bodies.map((body) => (body.match(NOTES) ?? []).length), [1, ...bodies.slice(1).map(() => 0)], "the first request carries it, no later one");
  const said = (await runTimeline(one.server, RUN, ctx)).map((entry) => entry.summary);
  assert.deepEqual(fileRows(said), [ROW], "one row of the server's, labelled once");
});

test("a CLI harness (opencode) not given write, or given write set to ask where no one can approve: its files note says screenshots can't be saved", { timeout: 120_000 }, async (t) => {
  for (const [what, body, approvers] of [
    ["write absent", { harness: "opencode", tools: ["read"] }, undefined],
    ["write asks, no approvers", { harness: "opencode", tools: ["read", "write"], toolSettings: { write: { permission: "ask" } } }, false],
  ]) {
    const { env, bodies } = await opencodeGateway(t);
    const one = await desktopRun(t, { body, approvers, cli: { env } });
    const row = await rests(one, ["ended"]);
    assert.equal(row.state, "ended", `${what}: ${JSON.stringify(row)}`);
    const noted = bodies.filter((sent) => sent.match(NOTES) !== null);
    assert.equal(noted.length, 1, `${what}: one request carries the note`);
    assert.ok(noted[0].includes(NOTE_NO_FILES.slice(0, -1)), `${what}: the note says screenshots can't be saved: ${noted[0].match(NOTES)?.[0]}`);
    assert.ok(!noted[0].includes("save_as saves the screen"), `${what}: no save_as promised`);
  }
});

// What a claim's spec offers a script on its desktop (computer_op's op list and the script's `computer`) leaves out the
// file ops its gate refuses for want of a tool, on the pi spec and a CLI harness's alike. The declarations those ops
// leave out are computer-op-grants.test.mjs's; --faux's desktop has no files group to declare.
test("the pi spec and a CLI harness's (opencode) offer a script on the desktop only the file ops the agent is given: computer_op's op list and the script's computer leave the others out", { timeout: 120_000 }, async (t) => {
  const READS = ["files.read", "files.list", "files.stat"];
  for (const [tools, notGiven] of [[["read", "write"], []], [["write"], READS], [["read"], ["files.write"]], [undefined, [...READS, "files.write"]]]) {
    for (const harness of ["pi", "opencode"]) {
      const what = `${harness}, tools ${JSON.stringify(tools)}`;
      const cli = harness === "opencode" ? { env: (await opencodeGateway(t)).env } : undefined;
      const one = await desktopRun(t, { script: [{ say: "done" }], body: { ...(harness === "opencode" ? { harness } : {}), ...(tools ? { tools } : {}) }, ...(cli ? { cli } : {}) });
      const row = await rests(one, ["ended"]);
      assert.equal(row.state, "ended", `${what}: ${JSON.stringify(row)}`);
      const [spec] = one.specs;
      const opTool = spec.session.tools.find((tool) => tool.name === "computer_op");
      assert.ok(opTool, `${what}: computer_op is bound: ${JSON.stringify(spec.session.tools.map((tool) => tool.name))}`);
      const offered = opTool.inputSchema.properties.op.enum;
      for (const op of [...READS, "files.write"]) assert.equal(offered.includes(op), !notGiven.includes(op), `${what}: ${op} in ${JSON.stringify(offered)}`);
      assert.deepEqual([...(spec.scriptComputer.opsNotGiven ?? [])].sort(), [...notGiven].sort(), `${what}: the script's computer leaves them out`);
    }
  }
});
