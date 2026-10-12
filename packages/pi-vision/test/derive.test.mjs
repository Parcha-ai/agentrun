import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { after, test } from "node:test";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { ProviderMiss, derivations, derivedName, viaProviders, visionContext } from "@parcha/pi-vision";
import { fixtureDir } from "@parcha/pi-vision/testing";

const dir = await fixtureDir("pi-vision-derive-");
after(() => dir.remove());
const env = new NodeExecutionEnv({ cwd: dir.path });
const sha256 = "ab".repeat(32);

const provider = (name, { kinds = ["pdf"], capabilities = ["text"], detect = { available: true, version: "1.0" }, calls } = {}) => ({
  name, kinds, capabilities, detect: async () => { calls?.push(`detect ${name}`); return detect; },
});
const run = (providers, job, attempt, extra = {}) => viaProviders({ env, providers, ...extra }, { kind: "pdf", capability: "text", what: "the text of a PDF", ...job }, attempt);
const failing = (message) => async () => { throw typeof message === "string" ? new Error(message) : message; };

test("a derivation is named by the source's hash prefix, the provider, its version and the part, and by nothing else", () => {
  assert.equal(derivedName({ sha256 }, { name: "poppler" }, "24.02.0"), "abababababababab.poppler-24.02.0");
  assert.equal(derivedName({ sha256 }, { name: "pdfium" }, "2.1.13", "-p3-150dpi"), "abababababababab-p3-150dpi.pdfium-2.1.13");
  assert.equal(derivedName({ sha256: `${"cd".repeat(8)}${"ef".repeat(24)}` }, { name: "poppler" }, "24.02.0"), "cdcdcdcdcdcdcdcd.poppler-24.02.0");
  assert.equal(derivedName({ sha256 }, { name: "a/b c" }, "1.0 beta/2"), "abababababababab.a_b_c-1.0_beta_2", "a name is one path segment");
  const names = new Set([derivedName({ sha256 }, { name: "a" }, "1"), derivedName({ sha256 }, { name: "b" }, "1"), derivedName({ sha256 }, { name: "a" }, "2"), derivedName({ sha256 }, { name: "a" }, "1", "-p2")]);
  assert.equal(names.size, 4, "a different provider, version or part is a different file");
});

test("a host that keeps nothing keeps nothing: no path, nothing read, nothing written", async () => {
  const none = derivations({ env });
  assert.deepEqual([none.path("x"), await none.read("x"), await none.keep("x", new Uint8Array([1]))], [null, null, null]);
});

test("a kept derivation is whole under its final name, replaces an older one, and leaves no temp name", async () => {
  const deriveDir = `${dir.path}/kept`;
  const kept = derivations({ env, deriveDir });
  assert.equal(await kept.read("a.bin"), null, "nothing kept yet");
  assert.equal(await kept.keep("a.bin", new Uint8Array([1, 2, 3])), `${deriveDir}/a.bin`);
  assert.equal(kept.path("a.bin"), `${deriveDir}/a.bin`);
  assert.deepEqual([...(await kept.read("a.bin"))], [1, 2, 3]);
  await kept.keep("a.bin", new Uint8Array([9]));
  assert.deepEqual([...(await kept.read("a.bin"))], [9]);
  assert.deepEqual(await readdir(deriveDir), ["a.bin"]);
});

test("derivations kept at once under one name leave one whole file", async () => {
  const deriveDir = `${dir.path}/raced`;
  const kept = derivations({ env, deriveDir });
  const payloads = Array.from({ length: 8 }, (_, i) => new Uint8Array(200_000).fill(i + 1));
  await Promise.all(payloads.map((bytes) => kept.keep("same.bin", bytes)));
  const read = await kept.read("same.bin");
  assert.ok(payloads.some((bytes) => Buffer.compare(bytes, read) === 0), "the file is one writer's bytes, never a mix");
  assert.deepEqual(await readdir(deriveDir), ["same.bin"]);
});

test("a derivation that cannot be written is not kept and leaves nothing behind", async () => {
  const blocked = await dir.file("blocker", "a file where a directory should be");
  const kept = derivations({ env, deriveDir: `${blocked}/inside` });
  assert.equal(await kept.keep("x", new Uint8Array([1])), null);
  assert.equal(await kept.read("x"), null);
});

test("providers are tried in order and the first that answers is the only one asked after it", async () => {
  const asked = [];
  const providers = ["a", "b", "c"].map((name) => provider(name));
  const out = await run(providers, {}, async (p, version, call) => {
    asked.push(p.name);
    assert.equal(version, "1.0");
    assert.equal(call.env, env);
    assert.ok((await env.fileInfo(call.tempDir, visionContext())).ok, "the call's scratch directory exists while it runs");
    asked.push(call.tempDir);
    if (p.name === "a") throw new Error("a cannot");
    return `from ${p.name}`;
  });
  assert.deepEqual(out, { ok: true, value: "from b" });
  assert.deepEqual([asked[0], asked[2]], ["a", "b"]);
  assert.equal(asked.length, 4, "c was never asked");
  assert.equal((await env.fileInfo(asked[1], visionContext())).ok, false, "the scratch directory is removed when the call ends");
});

test("a provider of another kind or without the capability is neither detected nor asked, and a detection is made once per environment", async () => {
  const calls = [];
  const providers = [provider("video", { kinds: ["video"], calls }), provider("render-only", { capabilities: ["render"], calls }), provider("text", { calls })];
  assert.equal((await run(providers, {}, async (p) => p.name)).value, "text");
  assert.equal((await run(providers, {}, async (p) => p.name)).value, "text");
  assert.deepEqual(calls, ["detect text"]);
});

test("every distinct cause is named once with the providers that gave it, and the first failure's code is the miss's", async () => {
  const providers = ["a", "b", "c"].map((name) => provider(name));
  const causes = { a: new ProviderMiss("over_budget", "too heavy\nsecond line"), b: new Error("too heavy"), c: new Error("not a document") };
  const out = await run(providers, {}, async (p) => { throw causes[p.name]; });
  assert.deepEqual(out, { ok: false, miss: { code: "over_budget", detail: "too heavy (a, b); not a document (c)" } });
  const plain = await run(providers.slice(1).concat(providers[0]), {}, async (p) => { throw causes[p.name]; });
  assert.equal(plain.miss.code, "unreadable", "an error that is not a ProviderMiss is unreadable, and the first failure decides");
  for (const code of ["unsupported", "needs"]) {
    assert.equal((await run([provider("a")], {}, failing(new ProviderMiss(code, "x")))).miss.code, code);
  }
});

test("providers that cannot run here say what they need; one that runs and fails decides the code instead", async () => {
  const absent = (name, needs, reason) => provider(name, { detect: { available: false, needs, reason } });
  const none = await run([absent("a", "poppler-utils", "not on the PATH"), absent("b", "unpdf", "not installed")], {}, async () => "never");
  assert.deepEqual(none, { ok: false, miss: { code: "needs", detail: "reading the text of a PDF needs poppler-utils (not on the PATH) or unpdf (not installed)" } });
  const nobody = await run([provider("video", { kinds: ["video"] })], { what: "the frames of a video" }, async () => "never");
  assert.deepEqual(nobody, { ok: false, miss: { code: "needs", detail: "reading the frames of a video needs a provider for it in the host's providers" } });
  const mixed = await run([absent("a", "poppler-utils", "missing"), provider("b")], {}, failing("damaged"));
  assert.deepEqual(mixed.miss, { code: "unreadable", detail: "damaged (b)" });
});

test("a caller that has stopped waiting gets its own error, no other provider is asked, and the scratch directory is gone", async () => {
  const stop = new AbortController();
  const asked = [];
  let scratch;
  await assert.rejects(run([provider("a"), provider("b")], {}, async (p, _version, call) => {
    asked.push(p.name);
    scratch = call.tempDir;
    stop.abort(new Error("the run was cancelled"));
    throw new Error("a was cut");
  }, { signal: stop.signal }), /a was cut/);
  assert.deepEqual(asked, ["a"]);
  assert.equal((await env.fileInfo(scratch, visionContext())).ok, false);
});

test("an environment that gives no scratch directory is an unreadable miss naming why, and no provider is asked", async () => {
  const broken = new Proxy(env, { get: (target, key) => (key === "createTempDir" ? async () => ({ ok: false, error: Object.assign(new Error("no space\nleft"), { code: "io" }) }) : Reflect.get(target, key)?.bind?.(target) ?? Reflect.get(target, key)) });
  const calls = [];
  const out = await viaProviders({ env: broken, providers: [provider("a", { calls })] }, { kind: "pdf", capability: "text", what: "the text of a PDF" }, async () => "never");
  assert.deepEqual(out, { ok: false, miss: { code: "unreadable", detail: "no scratch directory in the environment (no space)" } });
  assert.deepEqual(calls, []);
});
