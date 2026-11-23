// What the server writes of a start or a message is cut of the values handed with it (handed-values.ts cutHanded), and a
// value a message replaces mid-turn stays sealed as `retired`, only to be cut, until the turn's end erases the seal; a
// message that seals over bytes that don't open, or past RETIRED_MAX values, marks the launch `lost`, whose values read
// as unreadable (the run withheld).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { cutHanded, handedSecretValues, launchValuesOf, RETIRED_MAX, retiredValues } from "../dist/handed-values.js";
import { launchSecrets } from "../dist/runner/store-secrets.js";
import { openRunLaunch, sealRunLaunch } from "../dist/store/seal.js";

const KEY = `not-a-secret-${"handed-unit-model-key"}-7c1e40`;
const TOOL = `not-a-secret-${"handed-unit-tool-key"}-19ab02`;
const ORIGIN = "https://gateway.example";

test("cutHanded cuts each handed value from every string in a body, nested and past multibyte text, and nothing else", () => {
  const values = handedSecretValues({ model: KEY, keys: { TOOL_KEY: TOOL } });
  assert.ok(values.includes(KEY) && values.includes(TOOL), "the model key and each tool key");
  const body = { input: { content: `ñandú → ${KEY} ✓`, parts: [`tool ${TOOL}`, 3, null, true] }, effort: "high", title_hint: `not-a-secret-${"never-handed-value"}-4d21aa` };
  assert.deepEqual(cutHanded(body, values), { input: { content: "ñandú → [redacted] ✓", parts: ["tool [redacted]", 3, null, true] }, effort: "high", title_hint: `not-a-secret-${"never-handed-value"}-4d21aa` }, "a value never handed is not cut: only what was handed");
  assert.equal(cutHanded(`as JSON: ${JSON.stringify(KEY)}`, values), "as JSON: \"[redacted]\"");
  assert.equal(cutHanded("unchanged", []), "unchanged", "nothing handed: as given");
  assert.deepEqual(handedSecretValues({}), [], "a start that hands nothing");
});

test("retiredValues lists what a message's seal no longer holds, earlier retired values too, and drops a value handed again", () => {
  const before = { model: { key: KEY, origin: ORIGIN }, keys: { TOOL_KEY: TOOL } };
  assert.deepEqual(retiredValues(before, { model: { key: "not-a-secret-the-next-key-000000", origin: ORIGIN }, keys: { TOOL_KEY: TOOL } }), [KEY]);
  assert.deepEqual(retiredValues({ ...before, retired: ["not-a-secret-older-key-111111"] }, before), ["not-a-secret-older-key-111111"], "an earlier retired value stays");
  assert.deepEqual(retiredValues({ retired: [KEY] }, before), [], "handed again: held, not retired");
  assert.equal(RETIRED_MAX, 256);
});

test("a launch seal keeps retired values and the lost mark: the runner's cut lists the retired ones, and a lost launch's values are unreadable", () => {
  const key = randomBytes(32);
  const sealed = sealRunLaunch(key, "run_1", { model: { key: "not-a-secret-the-next-key-000000", origin: ORIGIN }, retired: [KEY] });
  assert.deepEqual(openRunLaunch(key, "run_1", sealed).retired, [KEY]);
  assert.ok(launchValuesOf(key, "run_1", sealed).includes(KEY), "a served read cuts it");
  assert.ok(launchSecrets(JSON.stringify({ retired: [KEY] })).includes(KEY), "the runner's cut lists it");
  const lost = sealRunLaunch(key, "run_1", { model: { key: "not-a-secret-the-next-key-000000", origin: ORIGIN }, lost: true });
  assert.equal(openRunLaunch(key, "run_1", lost).lost, true);
  assert.equal(launchValuesOf(key, "run_1", lost), "unreadable", "what it held is not known: the run is withheld");
  assert.notEqual(sealRunLaunch(key, "run_1", { lost: true }), null, "a lost mark alone is still sealed");
  assert.equal(sealRunLaunch(key, "run_1", { retired: [] }), null, "nothing held, nothing retired: no seal");
});
