// A person sees serve's words, never a provider's raw text. A provider's error carrying a host path, a Docker engine's
// JSON and a key-shaped string is driven through each site class at serve's own level (loopback fakes, no Docker, no
// network): a run's failure words at its claim, a tool result that reports its computer's loss or its new one's failed
// start, a run's end once its sandbox is lost past the claim's bound, and a read of the run's folder on its Archil disk
// (what the agent's file tools and the console's file routes read through). None of the path, the JSON or the key reaches
// those words; the class's one fixed sentence does; and the provider's words are on exactly one runner log line, with
// the run's id and the site, the key cut from it.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { readBackOf } from "@parcha/agentrun-computer";
import { archilWorkspace, computerForClaim, localWorkspace, runKey } from "../dist/workspace/index.js";
import { bookedIn } from "../dist/paid-calls.js";
import { FakeArchilDisk, FakeDiskError } from "./fixtures/archil-fake.mjs";
import { fakeComputer } from "./workspace-fake-computer.mjs";
import { KINDS } from "./workspace-kinds-fixture.mjs";

const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

/** A key-shaped dummy, built here so no literal of its shape is in the source. */
const KEY = ["ghp_", "z".repeat(36)].join("");
const PATH = "/tmp/wsb/x/home/agent/.cache";
/** A provider's words: `lead` (its own, so each error's line can be found), then a host path, Docker-style JSON and a
 *  key-shaped string, none of which names a class by its text. */
const RAW = (lead) => `${lead}: Error response from daemon: invalid mount config for type "bind": bind source path does not exist: ${PATH}; HostConfig.Mounts: declared [{"Type":"bind","Source":"/tmp/wsb/x/home/agent","Target":"/workspace"}]; auth ${KEY}`;
/** What must never reach a person's words. */
const LEAKS = [PATH, "/tmp/wsb", "{", "\"Type\"", "Type", "Source", "Target", "HostConfig", KEY, "Error response from daemon"];

/** Serve's one sentence per class, naming the provider. */
const SENTENCE = {
  key: (p) => `${p} refused its key. Check the ${p} key in Settings.`,
  quota: (p) => `${p} says the account is out of quota or credit. Check the ${p} account's plan and billing, then try again.`,
  down: (p) => `${p} couldn't be reached. Try again, or pick another place in Settings.`,
  machine: (p, kind) => `${p} refused the ${kind}, or no longer has it. Try again, and a new one starts.`,
  other: (p) => `${p} answered with an error. The server log has the details.`,
};

/** One row per class, each told by its structure alone (the computer package's code), and an unknown one: a code that
 *  says nothing, with text that names no class, which is "other". */
const ROWS = [
  { name: "key refused", cls: "key", error: (lead) => ({ code: "denied", message: RAW(lead) }) },
  { name: "quota or billing", cls: "quota", error: (lead) => ({ code: "limit", message: RAW(lead) }) },
  { name: "provider down or unreachable", cls: "down", error: (lead) => ({ code: "unreachable", message: RAW(lead) }) },
  { name: "machine refused or gone", cls: "machine", error: (lead) => ({ code: "not_found", message: RAW(lead) }) },
  { name: "other (the vendor's own failure)", cls: "other", error: (lead) => ({ code: "vendor", vendor: "docker", message: RAW(lead) }) },
  { name: "unknown", cls: "other", error: (lead) => ({ code: "invalid", message: RAW(lead) }) },
];

/** No word of the provider's in `words`, and the class's sentence there. */
function sayOnly(words, cls, provider, kind, where) {
  for (const leak of LEAKS) assert.ok(!words.includes(leak), `${where}: no ${JSON.stringify(leak)} in ${JSON.stringify(words)}`);
  const sentence = SENTENCE[cls](provider, kind);
  assert.ok(words.includes(sentence), `${where}: ${JSON.stringify(sentence)} in ${JSON.stringify(words)}`);
}

/** The provider's words `lead` on exactly one log line, `run <id> <site>: <class>: ...`, the key cut from it. */
function loggedOnce(lines, lead, runId, site, cls, where) {
  const found = lines.filter((line) => line.includes(lead));
  assert.equal(found.length, 1, `${where}: one runner log line holds the provider's words, of ${JSON.stringify(lines)}`);
  // The provider's words follow as it said them (a disk's begin with its status: "401 Unauthorized: ...").
  assert.ok(found[0].startsWith(`run ${runId} ${site}: ${cls}: `),`${where}: ${JSON.stringify(found[0])} names the run, the site and the class`);
  assert.ok(found[0].includes(PATH), `${where}: the provider's own words are on the log line`);
  assert.ok(!found[0].includes(KEY), `${where}: the key-shaped string is cut from the log line`);
}

/**
 * A Mode 1 claim (epoch 3) of a Docker sandbox, through a loopback provider: `record.createFails`, when set, answers
 * the create; `record.lose(id)` makes that computer's calls answer `record.lostAnswer` and its provider no longer list
 * it. The runner's log lines and the run's stop words are kept.
 */
async function claim({ recreates, spec = () => ({ image: "agentrun/computer:test", lifetimeMs: 60_000, network: "none" }) } = {}) {
  const dir = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-provider-words-")));
  dirs.push(dir);
  const root = join(dir, "work");
  mkdirSync(root);
  const keys = new Map();
  const store = {
    agents: { revision: async () => undefined },
    sealedKeys: { get: async (name) => keys.get(name), put: async (name, sealed) => void keys.set(name, sealed), remove: async () => {}, all: async () => [], clock: async () => Date.now() },
    computerLedger: { put: async () => {}, get: async () => undefined, list: async () => [], remove: async () => {} },
  };
  const record = { created: [], lines: [], stopped: [], createFails: undefined, lost: new Set(), lostAnswer: undefined };
  const held = new Map();
  const provider = {
    id: "fake",
    version: "0",
    capabilities: () => ({ lifetime: "janitor", maxLifetimeMs: 86_400_000 }),
    check: () => [],
    prepareImage: async () => ({ ok: true, value: "agentrun/computer:prepared" }),
    list: async () => ({ ok: true, value: [] }),
    async create(spec) {
      if (record.createFails) return { ok: false, error: record.createFails };
      record.created.push(spec);
      const id = `c${record.created.length}`;
      held.set(id, fakeComputer(root));
      return { ok: true, value: { id, name: id } };
    },
    async connect(ref) {
      const client = {
        async call(method, params) {
          if (record.lost.has(ref.id)) return { ok: false, error: record.lostAnswer };
          return held.get(ref.id).client.call(method, params);
        },
        close() {},
      };
      return { ok: true, value: { client, hello: { version: "0", os: "linux", kind: "linux", arch: "amd64", groups: ["exec", "files", "processes"] }, close: async () => {} } };
    },
    async attach(ref) {
      if (record.lost.has(ref.id)) return { ok: false, error: { code: "not_found", message: `no such container: ${ref.id}` } };
      const read = await held.get(ref.id).readBack();
      return { ok: true, value: { ...ref, spec: { image: "i", user: "1000:1000", network: "none", ...(read.ok ? { mount: read.value } : {}) } } };
    },
    async release() {
      return { ok: true, value: undefined };
    },
  };
  const run = () => computerForClaim({ runId: "run-1", epoch: 3, computer: { kind: "sandbox", provider: "docker" } }, store, {
    mode: 1,
    kinds: KINDS,
    sealKey: randomBytes(32),
    providers: { docker: () => provider },
    spec,
    workspace: localWorkspace(root),
    check: { readBackOf, epoch: 3 },
    log: (line) => void record.lines.push(line),
    stopRun: async (words) => void record.stopped.push(words),
    ...(recreates === undefined ? {} : { recreates }),
  });
  return { record, run };
}

const STAT = ["files.stat", { path: "/workspace" }];
/** One call of the computer's inside a tool call of the run's. */
const inCall = (client, method, params) => bookedIn({ call: "toolu_1", pause: async () => {} }, () => client.call(method, params));

// Each error's own words begin with a marker that names the row by its number, never its class, so no row's text tells
// the classifier its class.
for (const [n, row] of ROWS.entries()) {
  test(`a claim whose provider fails (${row.name}) fails the run in serve's words: the ${row.cls} sentence, no path, JSON or key; the provider's words on one runner log line`, async () => {
    const { record, run } = await claim();
    const lead = `claim-row${n}`;
    record.createFails = row.error(lead);
    const error = await run().then(() => undefined, (thrown) => thrown);
    assert.ok(error, "the claim fails");
    assert.equal(error.code, "computer_unavailable");
    assert.ok(error.message.startsWith("Docker could not start a sandbox computer: "), error.message);
    sayOnly(error.message, row.cls, "Docker", "sandbox", "the run's failure words");
    loggedOnce(record.lines, lead, "run-1", "claim", row.cls, "the claim");
  });

  test(`a sandbox lost mid-run whose new one's start fails (${row.name}): each tool result says it in serve's words, and the provider's words are on one runner log line each`, async () => {
    const { record, run } = await claim();
    const answer = await run();
    const client = answer.computer.computer.client;
    const why = `lost-row${n}`;
    record.lostAnswer = { code: "gone", message: RAW(why) };
    record.lost.add("c1");
    const cut = await inCall(client, ...STAT);
    assert.equal(cut.ok, false);
    assert.equal(cut.error.code, "gone", "a loss is never not_found");
    sayOnly(cut.error.message, "machine", "Docker", "sandbox", "the cut call's tool result");
    loggedOnce(record.lines, why, "run-1", "lost", "machine", "the loss");
    const lead = `restart-row${n}`;
    record.createFails = row.error(lead);
    const refused = await inCall(client, ...STAT);
    assert.equal(refused.ok, false);
    sayOnly(refused.error.message, row.cls, "Docker", "sandbox", "the failed start's tool result");
    loggedOnce(record.lines, lead, "run-1", "lost-start", row.cls, "the new one's start");
    loggedOnce(record.lines, why, "run-1", "lost", "machine", "the loss, said once");
    await answer.release();
  });
}

test("a sandbox lost past the claim's bound ends the run in serve's words, the provider's on one runner log line", async () => {
  const { record, run } = await claim({ recreates: 0 });
  const answer = await run();
  const client = answer.computer.computer.client;
  const why = "lost-past-the-bound";
  record.lostAnswer = { code: "gone", message: RAW(why) };
  record.lost.add("c1");
  const ended = await inCall(client, ...STAT);
  assert.equal(ended.ok, false);
  assert.equal(record.stopped.length, 1, "the run is stopped once");
  for (const words of [ended.error.message, record.stopped[0]]) sayOnly(words, "machine", "Docker", "sandbox", "the run's end");
  assert.ok(record.stopped[0].startsWith("computer_unavailable: the run's sandbox was lost 1 time"), record.stopped[0]);
  loggedOnce(record.lines, why, "run-1", "lost", "machine", "the loss");
  await answer.release();
});

test("a call outside the run's tool calls (the owner's computer channel) gets the loss in serve's words too", async () => {
  const { record, run } = await claim();
  const answer = await run();
  const client = answer.computer.computer.client;
  const why = "lost-outside";
  record.lostAnswer = { code: "gone", message: RAW(why) };
  record.lost.add("c1");
  for (const one of [await client.call(...STAT), await client.call(...STAT)]) {
    assert.equal(one.ok, false);
    sayOnly(one.error.message, "machine", "Docker", "sandbox", "the owner's call");
  }
  loggedOnce(record.lines, why, "run-1", "lost", "machine", "the loss");
  await answer.release();
});

test("a provider error told by its text alone (the vendor's own code) reads its class from the one table: a Docker engine not running is down", async () => {
  const { record, run } = await claim();
  record.createFails = { code: "vendor", vendor: "docker", message: `Cannot connect to the Docker daemon at unix:///tmp/wsb/x/docker.sock. Is the docker daemon running? auth ${KEY}` };
  const error = await run().then(() => undefined, (thrown) => thrown);
  assert.ok(error);
  sayOnly(error.message, "down", "Docker", "sandbox", "the run's failure words");
  assert.equal(record.lines.filter((line) => line.startsWith("run run-1 claim: down: Cannot connect to the Docker daemon")).length, 1, JSON.stringify(record.lines));
});

/** One row per class for the run's disk (Archil), each told by its structure (an HTTP status, or the disk gone), and
 *  an unknown one: no status, text that names no class. */
const DISK_ROWS = [
  { name: "key refused", cls: "key", fail: (disk, lead) => (disk.getRange = async () => { throw new FakeDiskError(401, "Unauthorized", RAW(lead)); }) },
  { name: "quota or billing", cls: "quota", fail: (disk, lead) => (disk.getRange = async () => { throw new FakeDiskError(429, "SlowDown", RAW(lead)); }) },
  { name: "provider down or unreachable", cls: "down", fail: (disk, lead) => (disk.getRange = async () => { throw new FakeDiskError(503, "ServiceUnavailable", RAW(lead)); }) },
  { name: "disk gone", cls: "machine", fail: (disk, lead) => (disk.gone = { region: "aws-us-east-1", words: RAW(lead) }) },
  { name: "other", cls: "other", fail: (disk, lead) => (disk.getRange = async () => { throw new FakeDiskError(400, "InvalidRequest", RAW(lead)); }) },
  { name: "unknown", cls: "other", fail: (disk, lead) => (disk.getRange = async () => { throw new Error(RAW(lead)); }) },
];

for (const [n, row] of DISK_ROWS.entries()) {
  test(`a read of the run's folder on its disk that Archil fails (${row.name}), as the agent's file tools and the console's file routes read it, says it in serve's words; Archil's on one log line`, async () => {
    const disk = new FakeArchilDisk();
    const key = runKey("acme", "run-1");
    disk.dirs.add(key);
    await disk.putObject(`${key}/notes.md`, new TextEncoder().encode("line one\n"));
    const lines = [];
    const workspace = archilWorkspace(disk, key, { tell: { runId: "run-1", log: (line) => void lines.push(line) } });
    const lead = `disk-row${n}`;
    row.fail(disk, lead);
    const error = await workspace.read("notes.md").then(() => undefined, (thrown) => thrown);
    assert.ok(error, "the read fails");
    assert.equal(error.code, "UNAVAILABLE");
    assert.ok(error.message.startsWith(`read "notes.md": `), error.message);
    sayOnly(error.message, row.cls, "Archil", "disk", "the read's error");
    loggedOnce(lines, lead, "run-1", "files", row.cls, "the read");
  });
}

test("serve's own refusal at the claim passes as it is, never as a provider's 'other', and logs no provider line", async () => {
  // A spec the computer can't be made with is serve's own refusal (code computer_unavailable, as computerSpecOf throws
  // one): its words stand.
  const own = Object.assign(new Error("This agent's computer needs a network: pick one in Settings → Computers."), { code: "computer_unavailable" });
  const { record, run } = await claim({ spec: () => { throw own; } });
  const error = await run().then(() => undefined, (thrown) => thrown);
  assert.ok(error);
  assert.equal(error.code, "computer_unavailable");
  assert.match(error.message, /This agent's computer needs a network: pick one in Settings → Computers\./);
  assert.deepEqual(record.lines, [], "nothing logged as a provider's failure");
});
