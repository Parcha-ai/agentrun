// An MCP tool's answer passes the run's redactor, not only the per-call scrub of its own server's credentials: a value
// the run's redactor holds (a run key, the model key, another server's token) that a tool echoes back is cut from what
// the model reads, from the answer a tool's file setting files whole (<folder>/<tool>-<time>-<id>.json), and from the
// rest of an answer too long for the model, filed at evidence/mcp/<server>/. On every place a claim makes its MCP: pi's
// spec, the CLI spec, and a run's own process, whose MCP is its runner's (run-child-host.ts heldFor).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { mode2Run } from "./fixtures/mode2-mounted-run.mjs";
import { storeOn } from "./store-helpers.mjs";

const { sealMcpCredential } = await import("../dist/store/index.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { cliRunSpecFromLaunch } = await import("../dist/runner/cli-run-spec.js");
const host = await import("../dist/runner/run-child-host.js");
const { runFolder } = await import("../dist/workspace/paths.js");
const { heldRedactor, secretRedactor } = await import("../dist/runner/redact.js");
const { FakeArchilDisk } = await import("./fixtures/archil-fake.mjs");
const { MCP_CLIP } = await import("../dist/mcp-gateway.js");

const SEAL_KEY = Buffer.alloc(32, 7);
const TOKEN = "not-a-secret-acme-server-bearer-0001";
/** Held by the run's redactor alone, never by the acme server's own credentials. */
const HELD = "not-a-secret-run-held-value-7f3a91c2";
const SCHEMA = { type: "object", properties: {} };
const TOOLS = {
  echo: { description: "Echo a note.", text: `the note says ${HELD}` },
  // Lines of words, as a person's text is: a run with no whitespace past a piece is withheld whole by any redactor.
  echo_long: { description: "Echo a long note.", text: `${HELD}\n${Array.from({ length: Math.ceil(MCP_CLIP / 20) }, (_, i) => `line ${i} of the long note`).join("\n")}\n${HELD}` },
  echo_filed: { description: "Echo a filed note.", text: JSON.stringify({ id: "n1", note: HELD }) },
};
const GRANTS = Object.keys(TOOLS).map((tool) => `mcp:acme/${tool}`);
const PIN = (url) => ({ acme: { url, tools: Object.entries(TOOLS).map(([name, { description }]) => ({ name, description, inputSchema: SCHEMA })) } });
const SETTINGS = { "mcp:acme/echo_filed": { file: { folder: "acme-out", show: ["id"] } } };

/** The run's redactor, holding HELD. */
const runRedactor = () => heldRedactor(secretRedactor([HELD]));

async function fakeAcme(t) {
  const fake = await startFakeMcp({ token: TOKEN });
  t.after(() => fake.close());
  for (const [name, { description, text }] of Object.entries(TOOLS)) fake.tools[name] = { description, input: SCHEMA, run: () => ({ content: [{ type: "text", text }] }) };
  const register = (server) => server.mcp.put({ name: "acme", url: fake.url, auth: "bearer", tools: Object.entries(TOOLS).map(([name, { description }]) => ({ name, description, input_schema: SCHEMA })), sealed: sealMcpCredential(SEAL_KEY, "acme", { type: "headers", headers: { authorization: `Bearer ${TOKEN}` } }, fake.url) });
  return { fake, register };
}

/** Every file under `dir`, by its path there, with its text. */
function filesUnder(dir, at = "") {
  let names;
  try {
    names = readdirSync(join(dir, at));
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const path = at ? `${at}/${name}` : name;
    return statSync(join(dir, path)).isDirectory() ? filesUnder(dir, path) : [[path, readFileSync(join(dir, path), "utf8")]];
  });
}

/** Each of the three tools called through `call` (a tool by its catalog name), and the run's files under `folder` after:
 *  HELD reaches none of the model's answers, and no file the gateway filed. Every output is read before any is asserted,
 *  so a failure names each one that kept the value. */
async function assertCut(call, folder) {
  const said = {};
  for (const name of GRANTS) said[name] = await call(name);
  const files = filesUnder(folder).filter(([path]) => path.startsWith("acme-out/") || path.startsWith("evidence/mcp/acme/"));
  const kept = [
    ...Object.entries(said).filter(([, text]) => text.includes(HELD)).map(([name]) => `the model's answer of ${name}`),
    ...files.filter(([, text]) => text.includes(HELD)).map(([path]) => `the run's file ${path.replace(/-[0-9T-]+Z?-[0-9a-f]{8}/, "-<time>-<id>")}`),
  ];
  assert.deepEqual(kept, [], "nothing the gateway answers or files keeps the run's held value");
  for (const [name, text] of Object.entries(said)) assert.ok(text.length > 0, `${name} answered`);
  assert.match(said["mcp:acme/echo_filed"], /filed whole at acme-out\//, `the filed tool's answer is filed: ${said["mcp:acme/echo_filed"].slice(0, 300)}`);
  assert.match(said["mcp:acme/echo_long"], /evidence\/mcp\/acme\//, `the long answer's rest is filed: ${said["mcp:acme/echo_long"].slice(-300)}`);
  assert.ok(files.some(([path]) => path.startsWith("acme-out/")), `the filed answer is in the run's files: ${files.map(([path]) => path).join(", ")}`);
  assert.ok(files.some(([path]) => path.startsWith("evidence/mcp/acme/")), `the long answer's rest is in the run's files: ${files.map(([path]) => path).join(", ")}`);
}

const callOf = (tools, nameOf) => async (catalog) => {
  const tool = tools.find((one) => nameOf(one) === catalog);
  assert.ok(tool, `the run's ${catalog}`);
  const result = await tool.call({}, { callId: `c-${catalog}`, signal: new AbortController().signal, attempt: 0 });
  return result.text;
};

for (const [name, harness, build] of [["pi's spec", undefined, adapterRunSpecFromLaunch], ["the CLI spec (opencode)", "opencode", cliRunSpecFromLaunch]]) {
  test(`${name}: a tool's answer echoing a value the run's redactor holds is cut of it in the model's answer, the filed answer and the long answer's filed rest`, { timeout: 120_000 }, async (t) => {
    const { fake, register } = await fakeAcme(t);
    const run = await mode2Run(t, { harness, disk: new FakeArchilDisk(), mcp: { grants: GRANTS, pin: PIN(fake.url), toolSettings: SETTINGS, before: register, deps: { mcpLoopback: true } } });
    const redact = runRedactor();
    const { spec } = await run.claimNext((launch, given, deps, claim) => build(launch, { ...given, redact }, deps, claim));
    await assertCut(callOf(spec.mcp.tools, (one) => spec.mcp.catalogOf(one.name)), run.scratch);
  });
}

test("a run's own process (its runner's MCP, heldFor), Mode 1: the runner's redactor cuts the model's answer, the filed answer and the long answer's filed rest", { timeout: 120_000 }, async (t) => {
  const { fake, register } = await fakeAcme(t);
  const { store } = await storeOn(t);
  const data = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "mode1-mcp-run-redactor-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  await register(store);
  const revision = { kind: "agentic", body: { instructions: "Answer.", tools: GRANTS, toolSettings: SETTINGS }, mcpPin: PIN(fake.url) };
  await store.agents.create({ id: "agent-own", name: "Own" }, { id: "rev-own", ...revision });
  await store.runs.create({ id: "run-own", agentId: "agent-own", revisionId: "rev-own" });
  mkdirSync(runFolder(data, "agent-own", "run-own"), { recursive: true, mode: 0o700 });
  const reads = { claim: { runId: "run-own", epoch: 1 }, run: { agentId: "agent-own", revisionId: "rev-own", signInHanded: null }, launch: { input: { content: "Hello." } }, revision, claimed: {} };
  const redact = runRedactor();
  const side = host.heldFor({ store, sealKey: SEAL_KEY, env: {}, data, mcpLoopback: true }, reads, redact, () => {});
  t.after(() => side.release());
  assert.ok(redact(`the credential ${TOKEN}`).includes(TOKEN), "the server's credential is not the runner's before the claim opens it");
  const mcp = await side.held.mcp({ appendRoot: async () => {} });
  assert.ok(mcp, "the run's MCP");
  assert.ok(!redact(`the credential ${TOKEN}`).includes(TOKEN), "the credential the claim opened joins the runner's redactor (hold)");
  await assertCut(callOf(mcp.tools, (one) => one.catalog), runFolder(data, "agent-own", "run-own"));
});

test("the gateway itself: with the run's redactor, an error answer and an answer with a block that is not text (filed whole as JSON) are cut of its value; given none, it does not start", { timeout: 60_000 }, async (t) => {
  const { mcpGateway } = await import("../dist/mcp-gateway.js");
  const { localWorkspace } = await import("../dist/workspace/index.js");
  const fake = await startFakeMcp({ token: TOKEN });
  t.after(() => fake.close());
  fake.tools.fails = { description: "Fail, echoing the note.", input: SCHEMA, run: () => ({ isError: true, content: [{ type: "text", text: `refused: ${HELD} is not ours` }] }) };
  fake.tools.pictured = { description: "A picture and the note.", input: SCHEMA, run: () => ({ content: [{ type: "text", text: `see ${HELD}` }, { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }] }) };
  const pin = { acme: { url: fake.url, tools: ["fails", "pictured"].map((name) => ({ name, inputSchema: SCHEMA })) } };
  const credentials = { acme: { url: fake.url, headers: { authorization: `Bearer ${TOKEN}` } } };
  const said = async (redact) => {
    const work = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "mcp-gateway-run-redactor-"));
    t.after(() => rmSync(work, { recursive: true, force: true }));
    const gateway = mcpGateway({ pin, credentials, work: () => localWorkspace(work), redact });
    const failed = await gateway.call("acme", "fails", {}, { signal: new AbortController().signal });
    const pictured = await gateway.call("acme", "pictured", {}, { signal: new AbortController().signal });
    assert.equal(failed.isError, true);
    assert.match(pictured.content.map((block) => block.text).join(""), /evidence\/mcp\/acme\/pictured-[^ ]+\.json/);
    return [failed, pictured].map((result) => result.content.map((block) => block.text).join("")).concat(filesUnder(work).map(([, text]) => text));
  };
  const cut = await said(runRedactor());
  assert.equal(cut.length, 3, "two answers and the filed JSON");
  for (const text of cut) assert.ok(!text.includes(HELD), `cut of the run's value: ${text.slice(0, 200)}`);
  for (const text of cut) assert.ok(!text.includes(TOKEN));
  for (const redact of [undefined, "[redacted]"]) {
    assert.throws(() => mcpGateway({ pin, credentials, work: () => tmpdir(), ...(redact !== undefined ? { redact } : {}) }), (error) => {
      assert.match(error.message, /^An MCP gateway was given no redactor \(the run's\), so it does not start/);
      return true;
    }, `a gateway given ${redact === undefined ? "no redactor" : "a redactor that is no function"} does not start`);
  }
});

test("the gateway itself: a binary payload filed whole (a screenshot's image, a resource's blob) past a piece of the run's redactor is kept whole; one whose bytes hold a value the run holds is \"[redacted]\" alone", { timeout: 60_000 }, async (t) => {
  const { mcpGateway } = await import("../dist/mcp-gateway.js");
  const { localWorkspace } = await import("../dist/workspace/index.js");
  // 12 KB of bytes, so its base64 is one run of 16 KB with no whitespace: past the redactor's 8,192-character piece.
  const bytes = Buffer.from(Array.from({ length: 12_288 }, (_, i) => (i * 7) % 251));
  const picture = bytes.toString("base64");
  const leaking = Buffer.concat([bytes, Buffer.from(` ${HELD} `), bytes]).toString("base64");
  const fake = await startFakeMcp({ token: TOKEN });
  t.after(() => fake.close());
  fake.tools.shot = { description: "A screenshot.", input: SCHEMA, run: () => ({ content: [{ type: "text", text: `shot of ${HELD}` }, { type: "image", data: picture, mimeType: "image/png" }] }) };
  fake.tools.blob = { description: "A file.", input: SCHEMA, run: () => ({ content: [{ type: "resource", resource: { uri: "file:///shot.png", mimeType: "image/png", blob: picture } }] }) };
  fake.tools.leaks = { description: "A picture whose bytes hold the note.", input: SCHEMA, run: () => ({ content: [{ type: "image", data: leaking, mimeType: "image/png" }] }) };
  const pin = { acme: { url: fake.url, tools: ["shot", "blob", "leaks"].map((name) => ({ name, inputSchema: SCHEMA })) } };
  const credentials = { acme: { url: fake.url, headers: { authorization: `Bearer ${TOKEN}` } } };
  const work = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "mcp-gateway-binary-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const gateway = mcpGateway({ pin, credentials, work: () => localWorkspace(work), redact: runRedactor() });
  const filed = {};
  for (const tool of ["shot", "blob", "leaks"]) {
    const result = await gateway.call("acme", tool, {}, { signal: new AbortController().signal });
    const path = result.content.map((block) => block.text).join("").match(/evidence\/mcp\/acme\/[^ \]]+\.json/)?.[0];
    assert.ok(path, `${tool} filed whole: ${result.content.map((block) => block.text).join("")}`);
    filed[tool] = JSON.parse(readFileSync(join(work, path), "utf8"));
  }
  assert.equal(filed.shot.content[1].data, picture, "the screenshot's image is filed whole, as the server sent it");
  assert.ok(!filed.shot.content[0].text.includes(HELD), "and its text block is cut of the run's value");
  assert.equal(filed.blob.content[0].resource.blob, picture, "a resource's blob is filed whole");
  assert.equal(filed.leaks.content[0].data, "[redacted]", "a payload whose bytes hold the run's value is withheld");
  assert.equal(filed.leaks.content[0].mimeType, "image/png", "and the block around it kept");
});

// 12 KB of bytes, so a payload of them is base64 past the run's redactor's 8,192-character piece.
const BYTES = Buffer.from(Array.from({ length: 12_288 }, (_, i) => (i * 7) % 251));
const PICTURE = BYTES.toString("base64");
/** `inside` between two copies of BYTES, as base64. */
const bytesAround = (inside) => Buffer.concat([BYTES, Buffer.from(inside), BYTES]).toString("base64");
const b64url = (text) => Buffer.from(text).toString("base64url");
/** A JWT's shape, signed by no one and held by no redactor here. */
const JWT = [b64url('{"alg":"none"}'), b64url('{"sub":"not-a-secret"}'), b64url("not-a-signature")].join(".");
/** A private key block's shape, of no key, held by no redactor here. */
const PEM = [`-----BEGIN ${"PRIVATE KEY"}-----`, ...Array.from({ length: 3 }, (_, i) => `MIIE${String(i).repeat(60)}`), `-----END ${"PRIVATE KEY"}-----`].join("\n");

/** Each of `tools` (a tool's name, and the content blocks it answers) called once through a gateway with `redact`, and the
 *  JSON its answer was filed whole as, by tool. Every tool answers a block that is not text, so each is filed. */
async function filedWhole(t, tools, redact) {
  const { mcpGateway } = await import("../dist/mcp-gateway.js");
  const { localWorkspace } = await import("../dist/workspace/index.js");
  const fake = await startFakeMcp({ token: TOKEN });
  t.after(() => fake.close());
  for (const [name, content] of Object.entries(tools)) fake.tools[name] = { description: `The ${name} tool.`, input: SCHEMA, run: () => ({ content }) };
  const pin = { acme: { url: fake.url, tools: Object.keys(tools).map((name) => ({ name, inputSchema: SCHEMA })) } };
  const credentials = { acme: { url: fake.url, headers: { authorization: `Bearer ${TOKEN}` } } };
  const work = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "mcp-gateway-filed-whole-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const gateway = mcpGateway({ pin, credentials, work: () => localWorkspace(work), redact });
  const filed = {};
  for (const tool of Object.keys(tools)) {
    const result = await gateway.call("acme", tool, {}, { signal: new AbortController().signal });
    const path = result.content.map((block) => block.text).join("").match(/evidence\/mcp\/acme\/[^ \]]+\.json/)?.[0];
    assert.ok(path, `${tool} filed whole: ${result.content.map((block) => block.text).join("")}`);
    filed[tool] = JSON.parse(readFileSync(join(work, path), "utf8"));
  }
  return filed;
}

test("the gateway itself: a binary payload filed whole that carries a secret's shape no one holds (a JWT as the payload gives it, a private key or a JWT in the bytes it decodes to) is \"[redacted]\" alone, as the run's redactor cuts a shape in text; one with none is kept whole", { timeout: 60_000 }, async (t) => {
  const filed = await filedWhole(t, {
    as_given: [{ type: "image", data: `${PICTURE}\n${JWT}\n${PICTURE}`, mimeType: "image/png" }],
    key_in_bytes: [{ type: "resource", resource: { uri: "file:///notes.bin", mimeType: "application/octet-stream", blob: bytesAround(`\n${PEM}\n`) } }],
    jwt_in_bytes: [{ type: "image", data: bytesAround(` ${JWT} `), mimeType: "image/png" }],
    clean: [{ type: "image", data: PICTURE, mimeType: "image/png" }],
  }, runRedactor());
  const shown = {
    as_given: filed.as_given.content[0].data,
    key_in_bytes: filed.key_in_bytes.content[0].resource.blob,
    jwt_in_bytes: filed.jwt_in_bytes.content[0].data,
  };
  assert.deepEqual(Object.entries(shown).filter(([, payload]) => payload !== "[redacted]").map(([tool]) => tool), [], "each payload with a secret's shape is withheld");
  assert.equal(filed.key_in_bytes.content[0].resource.uri, "file:///notes.bin", "and the block around it kept");
  assert.equal(filed.clean.content[0].data, PICTURE, "a payload with no secret's shape is filed whole, as the server sent it");
});

test("a claim's MCP does not start without the run's held redactor: it throws, naming itself, before it opens or mints any key", { timeout: 60_000 }, async () => {
  const { mcpForClaim } = await import("../dist/runner/mcp-run.js");
  const reached = [];
  const store = new Proxy({}, { get: (_, name) => (reached.push(`store.${String(name)}`), undefined) });
  const options = { claim: { runId: "run-own", epoch: 1 }, store, sealKey: SEAL_KEY, grants: GRANTS, harness: { commit: async () => undefined }, work: () => tmpdir(), githubAppAccess: async () => void reached.push("githubAppAccess") };
  for (const [what, redact] of [["no redactor", undefined], ["a redactor that holds nothing more (secretRedactor)", secretRedactor([HELD])], ["a bare cut", (text) => text]]) {
    await assert.rejects(mcpForClaim({ ...options, ...(redact ? { redact } : {}) }), (error) => {
      assert.match(error.message, /^A claim's MCP was given no redactor that holds keys/, `${what}: ${error.message}`);
      return true;
    }, what);
  }
  assert.deepEqual(reached, [], "nothing was read or minted");
});

test("the gateway itself: a held value in a binary payload at each byte offset (0, 1 and 2 mod 3), in an audio block, and as hex that only the decoded bytes show is \"[redacted]\"; two payloads in one answer each go back to their own block", { timeout: 60_000 }, async (t) => {
  const { valueLeft } = await import("../dist/learn/secrets.js");
  const at = (shift) => bytesAround(`${"\u0000".repeat(shift)}${HELD}`);
  const hex = bytesAround(` ${Buffer.from(HELD).toString("hex")} `);
  assert.equal(valueLeft(hex, [HELD], []), false, "the base64 text of the hex form does not show the value: only the bytes it decodes to do");
  for (const shift of [0, 1, 2]) assert.equal((BYTES.length + shift) % 3, shift, `the value starts at a byte ${shift} mod 3`);
  const filed = await filedWhole(t, {
    offset_0: [{ type: "image", data: at(0), mimeType: "image/png" }],
    offset_1: [{ type: "image", data: at(1), mimeType: "image/png" }],
    offset_2: [{ type: "resource", resource: { uri: "file:///shot.png", mimeType: "image/png", blob: at(2) } }],
    audio: [{ type: "audio", data: at(1), mimeType: "audio/wav" }],
    audio_clean: [{ type: "audio", data: PICTURE, mimeType: "audio/wav" }],
    hex: [{ type: "image", data: hex, mimeType: "image/png" }],
    two: [{ type: "text", text: "two files" }, { type: "image", data: PICTURE, mimeType: "image/png" }, { type: "resource", resource: { uri: "file:///b.bin", blob: at(2) } }],
    two_turned: [{ type: "image", data: at(0), mimeType: "image/png" }, { type: "text", text: "two files" }, { type: "resource", resource: { uri: "file:///a.bin", blob: PICTURE } }],
  }, runRedactor());
  const leaked = Object.entries({
    offset_0: filed.offset_0.content[0].data,
    offset_1: filed.offset_1.content[0].data,
    offset_2: filed.offset_2.content[0].resource.blob,
    audio: filed.audio.content[0].data,
    hex: filed.hex.content[0].data,
    "two's resource": filed.two.content[2].resource.blob,
    "two_turned's image": filed.two_turned.content[0].data,
  }).filter(([, payload]) => payload !== "[redacted]").map(([where]) => where);
  assert.deepEqual(leaked, [], "every payload holding the run's value is withheld");
  assert.equal(filed.audio_clean.content[0].data, PICTURE, "a clean audio payload is filed whole");
  assert.equal(filed.two.content[1].data, PICTURE, "the clean image beside a leaking resource is kept byte for byte");
  assert.equal(filed.two.content[0].text, "two files");
  assert.equal(filed.two_turned.content[2].resource.blob, PICTURE, "the clean resource after a leaking image is kept byte for byte");
  assert.equal(filed.two_turned.content[2].resource.uri, "file:///a.bin");
});

test("the gateway itself: with a run's redactor that names none of its values (no heldValues), a binary payload past a piece is \"[redacted]\": cut as the rest is, never kept unread", { timeout: 60_000 }, async (t) => {
  const held = runRedactor();
  const bare = (text) => held(text);
  assert.equal(bare.heldValues, undefined);
  const filed = await filedWhole(t, { shot: [{ type: "image", data: PICTURE, mimeType: "image/png" }], small: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }] }, bare);
  assert.equal(filed.shot.content[0].data, "[redacted]", "a payload past a piece");
  assert.equal(filed.small.content[0].data, "iVBORw0KGgo=", "a payload within a piece is read as text is");
});
