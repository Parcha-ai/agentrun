// The provider conformance suite, proved on the fake provider: a provider and a twin that agree pass every case, run
// through pi-durable's own Node environment as the environment port; a twin that disagrees, a render 2 px off, a
// result that names the wrong version, a declared capability with no method and a detect that throws each fail the
// case they break; a provider that cannot run here skips with its reason, or fails when availability is required.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { fakeProvider, fixtureDir, providerConformance, registerProviderConformance } from "@parcha/pi-vision/testing";

const DOC = { pages: [{ text: "Invoice   number\n 1042", width: 612, height: 792 }, { text: "Total due 31.50", width: 595, height: 842 }] };
const dir = await fixtureDir("pi-vision-conformance-");
const bytes = Buffer.from(JSON.stringify(DOC));
const source = { path: await dir.file("letter.fake.json", bytes), kind: "pdf", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
test.after(() => dir.remove());

const env = () => new NodeExecutionEnv({ cwd: dir.path });
const fixtures = [{
  name: "two-page letter",
  source,
  expect: {
    text: [{ page: 1, contains: ["Invoice number 1042"] }, { page: 2, contains: ["Total due 31.50"] }],
    render: [{ page: 1, dpi: 72, width: 612, height: 792 }, { page: 2, dpi: 181, width: 1496, height: 2117 }],
  },
}];
const options = (provider, twin, more = {}) => ({ provider, ...(twin ? { twin } : {}), env, fixtures, requireAvailable: false, ...more });
const byName = (cases, part) => {
  const found = cases.filter((c) => c.name.includes(part));
  assert.ok(found.length > 0, `a case named like ${part}`);
  return found;
};

// A provider and a twin that agree: every case registered as a test of this file, and every one passes.
registerProviderConformance(options(fakeProvider({ name: "fake-js" }), fakeProvider({ name: "fake-bin", version: "24.02.0", text: (t) => t.replace(/ +/g, "  ") })));

test("the suite has a case per capability and fixture, and one for agreement", () => {
  const names = providerConformance(options(fakeProvider(), fakeProvider({ name: "twin" }))).map((c) => c.name);
  assert.deepEqual(names, [
    "detect() resolves to a detection and never throws",
    "every capability it declares has its method",
    "two-page letter: text",
    "two-page letter: render page 1 at 72 dpi",
    "two-page letter: render page 2 at 181 dpi",
    "two-page letter: fake and twin agree",
  ]);
});

test("a twin whose text differs fails the agreement case", async () => {
  const cases = providerConformance(options(fakeProvider(), fakeProvider({ name: "twin", text: (t) => t.replace("1042", "1O42") })));
  await assert.rejects(byName(cases, "agree")[0].run(), /text, whitespace collapsed/);
});

test("a render 2 px off fails its render cases and the agreement case; 1 px is within tolerance", async () => {
  const off = providerConformance(options(fakeProvider({ widthError: 2 }), fakeProvider({ name: "twin" })));
  for (const c of byName(off, "render")) await assert.rejects(c.run(), /within 1 px/);
  await assert.rejects(byName(off, "agree")[0].run(), /within 1 px/);
  for (const c of providerConformance(options(fakeProvider({ widthError: 1 }), fakeProvider({ name: "twin" })))) await c.run();
});

test("a result that does not name the provider and version detect() found fails", async () => {
  const provider = fakeProvider();
  const lying = { ...provider, async text(...args) { const out = await provider.text(...args); return { ...out, madeBy: { provider: "fake", version: "0.0.1" } }; } };
  await assert.rejects(byName(providerConformance(options(lying)), ": text")[0].run(), /names the provider and the version/);
});

test("a capability declared without its method, or with no method in this release, or a detect that throws, fails", async () => {
  const noRender = { ...fakeProvider(), render: undefined };
  await assert.rejects(byName(providerConformance(options(noRender)), "has its method")[0].run(), /declares render without its render\(\)/);
  const noPrepare = { ...fakeProvider(), capabilities: ["text", "render", "fit"] };
  await assert.rejects(byName(providerConformance(options(noPrepare)), "has its method")[0].run(), /declares fit without its prepare\(\)/);
  await byName(providerConformance(options({ ...noPrepare, prepare: async () => undefined })), "has its method")[0].run();
  for (const capability of ["positions", "ocr"]) {
    await assert.rejects(byName(providerConformance(options({ ...fakeProvider(), capabilities: ["text", capability] })), "has its method")[0].run(), new RegExp(`declares ${capability}, which has no method in this release`));
  }
  const throwing = { ...fakeProvider(), detect: async () => { throw new Error("probe crashed"); } };
  await assert.rejects(byName(providerConformance(options(throwing)), "never throws")[0].run(), /probe crashed/);
});

test("a provider that cannot run here skips every case with its reason, and fails each when availability is required", async () => {
  const detection = { available: false, needs: "pdftoppm", reason: "not on PATH" };
  const missing = fakeProvider({ name: "poppler-like", detection });
  for (const c of providerConformance(options(missing, fakeProvider()))) {
    const result = await c.run();
    if (c.name.includes("detect") || c.name.includes("method")) assert.equal(result, undefined, c.name);
    else assert.deepEqual(result, { skip: "poppler-like cannot run here: needs pdftoppm: not on PATH" }, c.name);
  }
  for (const c of providerConformance(options(missing, undefined, { requireAvailable: true })).filter((c) => !/detect|method/.test(c.name))) {
    await assert.rejects(c.run(), /poppler-like cannot run here: needs pdftoppm: not on PATH/);
  }
});

test("every case removes the directories its provider calls were given, when it passes and when it fails", async () => {
  const made = [];
  const recording = () => {
    const env = new NodeExecutionEnv({ cwd: dir.path });
    const createTempDir = env.createTempDir.bind(env);
    env.createTempDir = async (...args) => { const r = await createTempDir(...args); if (r.ok) made.push(r.value); return r; };
    return env;
  };
  const passing = providerConformance({ ...options(fakeProvider(), fakeProvider({ name: "twin" })), env: recording });
  const failing = providerConformance({ ...options(fakeProvider({ widthError: 5 }), fakeProvider({ name: "twin" })), env: recording });
  for (const c of passing) await c.run();
  for (const c of failing) await c.run().catch(() => undefined);
  assert.ok(made.length >= 8, `the cases made directories (${made.length})`);
  assert.deepEqual(made.filter((path) => existsSync(path)), [], "none is left");
});

test("in an agreement case, a provider that fails does not have the other's directory removed under it", async () => {
  const fake = fakeProvider();
  let stillThere = null;
  const slow = { ...fake, async text(source, request, call) { await new Promise((resolve) => setTimeout(resolve, 50)); stillThere = existsSync(call.tempDir); return fake.text(source, request, call); } };
  const failing = { ...fakeProvider({ name: "twin" }), async text() { throw new Error("twin crashed"); } };
  await assert.rejects(byName(providerConformance(options(slow, failing)), "agree")[0].run(), /twin crashed/);
  assert.equal(stillThere, true, "the slow provider's directory was there until its call settled");
});
