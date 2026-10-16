import assert from "node:assert/strict";
import { test } from "node:test";
import { CAPS, checkPreconditions, checkTrial, currentRevision, deriveWhen, fitTrial, LearnError, matches, parseTrial, pruneUses, renderTrial, skillName, TRIAL_LIMITS, trialPath, whenSize } from "../dist/index.js";

const sha = (c) => c.repeat(64);
const at = (n) => `2026-10-16T${String(n).padStart(2, "0")}:00:00.000Z`;
const trial = (over = {}) => ({
  name: "kyb-registry", status: "trial", when: [{ pointer: "/company", op: "exists" }],
  revisions: [{ sha256: sha("a"), status: "trial", since: at(1), run: "run-1", after: 0 }], uses: [], ...over,
});
const WHEN_ONE = [{ pointer: "/company", op: "exists" }];
const refused = (value, code = "format") => assert.throws(() => checkTrial(value), (e) => e instanceof LearnError && e.code === code);

test("a trial renders as stable JSON and parses back to exactly what was written", () => {
  const written = trial({ uses: [{ run: "run-2", sha256: sha("a"), outcome: "frozen", at: at(2) }] });
  const text = renderTrial(written);
  assert.equal(text, `${JSON.stringify(written, null, 2)}\n`);
  assert.deepEqual(parseTrial(text, "kyb-registry"), written);
  assert.equal(trialPath("kyb-registry"), ".agents/skills/kyb-registry/trial.json");
});

test("a trial that breaks its schema or its own invariants is refused, whichever way it breaks", () => {
  const live = { sha256: sha("b"), status: "active", since: at(2), run: "run-2", after: 0 };
  refused({ ...trial(), extra: 1 });
  refused(trial({ name: "Kyb_Registry" }));
  refused(trial({ status: "paused" }));
  refused(trial({ when: [{ pointer: "company", op: "exists" }] }));
  refused(trial({ when: [{ pointer: "/a", op: "gte", value: "3" }] }));
  refused(trial({ when: [{ pointer: "/a", op: "in", value: [] }] }));
  refused(trial({ when: [{ pointer: "/a", op: "matches", value: "x+" }] }));
  refused(trial({ when: [{ pointer: "/a", op: "eq" }] }));
  refused(trial({ when: [{ pointer: "/a", op: "eq", value: Array.from({ length: 12 }).reduce((inner) => ({ inner }), 1) }] }));
  refused(trial({ revisions: [] }));
  refused(trial({ revisions: [{ sha256: "abc", status: "trial", since: at(1), run: "run-1", after: 0 }] }));
  refused(trial({ revisions: [{ sha256: sha("a"), status: "trial", since: "yesterday", run: "run-1", after: 0 }] }));
  refused(trial({ revisions: [{ sha256: sha("a"), status: "trial", since: at(1), run: "run-1", after: 0 }, { sha256: sha("a"), status: "retired", since: at(1), run: "run-1", after: 0 }] }));
  refused(trial({ revisions: [{ sha256: sha("a"), status: "trial", since: at(1), run: "run-1", after: 0 }, live] }));
  refused(trial({ status: "active" }));
  refused(trial({ status: "demoted" }));
  refused(trial({ uses: [{ run: "run-2", sha256: sha("c"), outcome: "frozen", at: at(2) }] }));
  refused(trial({ uses: [{ run: "run-2", sha256: sha("a"), outcome: "clean", at: at(2) }] }));
  refused(trial({ uses: [{ run: "run-2", sha256: sha("a"), outcome: "frozen", at: "2026-10-16" }] }));
  refused(trial({ revisions: [{ sha256: sha("a"), status: "trial", since: at(1), run: "run-1", after: 1 }] }));
  refused(trial({ revisions: [{ sha256: sha("a"), status: "trial", since: at(1), run: "run-1", after: 0, description: "kept by a live revision" }] }));
  refused(trial({ revisions: [{ sha256: sha("a"), status: "trial", since: at(1), run: "run-1", after: 0, when: [] }] }));
  refused(trial({ when: Array.from({ length: 16 }, (_, i) => ({ pointer: `/field${i}`, op: "in", value: Array.from({ length: 32 }, (_, j) => `value-${j}`) })) }), "format");
  const superseded = (digest, extra = {}) => ({ sha256: sha(digest), status: "superseded", since: at(2), run: "run-2", after: 0, ...extra });
  refused(trial({ revisions: [{ sha256: sha("a"), status: "trial", since: at(1), run: "run-1", after: 0 }, superseded("b", { description: "  " })] }));
  refused(trial({ revisions: [{ sha256: sha("a"), status: "trial", since: at(1), run: "run-1", after: 0 }, ...["b", "c", "d", "e"].map((d) => superseded(d))] }));
  checkTrial(trial({ revisions: [{ sha256: sha("a"), status: "trial", since: at(1), run: "run-1", after: 0 }, ...["b", "c", "d"].map((d) => superseded(d, { when: WHEN_ONE, description: "when to use it" }))] }));
  assert.throws(() => parseTrial("{", "kyb-registry"), (e) => e.code === "format");
  assert.throws(() => parseTrial(renderTrial(trial()), "other-name"), (e) => e.code === "format");
  assert.throws(() => parseTrial(" ".repeat(CAPS.file + 1)), (e) => e.code === "too_large");
});

test("a name with no live revision is demoted, and the live one is whichever is a trial or active", () => {
  const demoted = trial({ status: "demoted", revisions: [{ sha256: sha("a"), status: "demoted", since: at(3), run: "run-1", after: 0 }] });
  checkTrial(demoted);
  assert.equal(currentRevision(demoted), undefined);
  assert.equal(currentRevision(trial())?.sha256, sha("a"));
});

test("a trial at every limit, with the longest run ids and the largest preconditions, still fits the curator's file cap", () => {
  const long = (i) => `run-${String(i).padStart(3, "0")}-${"x".repeat(128 - 8)}`;
  const biggest = [];
  for (let i = 0; i < TRIAL_LIMITS.preconditions; i += 1) {
    const next = [...biggest, { pointer: `/f${i}`, op: "in", value: Array.from({ length: TRIAL_LIMITS.inValues }, (_, j) => j % 10) }];
    if (whenSize(next) > TRIAL_LIMITS.whenChars) break;
    biggest.push(next.at(-1));
  }
  assert.ok(biggest.length > 3 && whenSize(biggest) <= TRIAL_LIMITS.whenChars);
  const revisions = Array.from({ length: TRIAL_LIMITS.revisions }, (_, i) => ({ sha256: sha("0123456789abcdef"[i % 16]).slice(0, 63) + String(i % 10), status: "retired", since: at(1), run: long(i), after: TRIAL_LIMITS.uses }));
  revisions[0] = { ...revisions[0], status: "trial" };
  for (let i = 1; i <= TRIAL_LIMITS.restorable; i += 1) revisions[i] = { ...revisions[i], status: "superseded", when: biggest, description: "d".repeat(CAPS.text) };
  const uses = Array.from({ length: TRIAL_LIMITS.uses }, (_, i) => ({ run: long(i), sha256: revisions[0].sha256, outcome: "escalated", at: at(2) }));
  const text = renderTrial(trial({ revisions, uses, when: biggest }));
  assert.ok(Buffer.byteLength(text) <= CAPS.file, `${Buffer.byteLength(text)} bytes`);
  assert.throws(() => checkTrial(trial({ when: [...biggest, { pointer: "/one-more", op: "in", value: Array.from({ length: 32 }, (_, j) => j % 10) }] })), (e) => e.code === "format");
});

test("the net under the limits: a trial over the cap loses its oldest uses first, never below the thresholds' reach, and the boundaries move with them", () => {
  const size = (t) => Buffer.byteLength(`${JSON.stringify(t, null, 2)}\n`);
  const uses = Array.from({ length: 200 }, (_, i) => ({ run: `run-${i}-${"x".repeat(100)}`, sha256: sha("a"), outcome: "frozen", at: at(2) }));
  const many = trial({ uses, revisions: [{ sha256: sha("a"), status: "trial", since: at(1), run: "run-1", after: 150 }] });
  assert.ok(size(many) > CAPS.file);
  const fitted = fitTrial(many);
  assert.ok(size(fitted) <= CAPS.file && fitted.uses.length >= TRIAL_LIMITS.threshold);
  const dropped = uses.length - fitted.uses.length;
  assert.deepEqual(fitted.uses, uses.slice(dropped), "the newest are the ones kept");
  assert.equal(fitted.revisions[0].after, 150 - dropped);
  const bulky = trial({ uses: uses.slice(0, TRIAL_LIMITS.threshold), when: Array.from({ length: 16 }, (_, i) => ({ pointer: `/f${i}`, op: "in", value: Array.from({ length: 32 }, (_, j) => `value-${j}`) })) });
  assert.equal(fitTrial(bulky).uses.length, TRIAL_LIMITS.threshold, "it stops at the floor");
});

test("workflow names are skill names: lowercase words joined by single hyphens", () => {
  for (const ok of ["a", "kyb-us-registry", "w2", "a1-b2-c3"]) assert.equal(skillName(ok), ok);
  for (const bad of ["", "Kyb", "kyb_us", "-kyb", "kyb-", "kyb--us", "kyb us", "../kyb", "x".repeat(65), undefined]) {
    assert.throws(() => skillName(bad), (e) => e instanceof LearnError && e.code === "invalid", String(bad));
  }
});

// Each row: the checks, the input, whether they hold. The expectations are written from what each operator means.
const CASES = [
  ["no checks match any input, even one that is not an object", [], "a task as prose", true],
  ["exists holds for a present field, whatever its value, null too", [{ pointer: "/a", op: "exists" }], { a: null }, true],
  ["exists fails for an absent field", [{ pointer: "/a", op: "exists" }], { b: 1 }, false],
  ["a pointer reaches into objects and arrays", [{ pointer: "/a/1/b", op: "eq", value: "x" }], { a: [{ b: "no" }, { b: "x" }] }, true],
  ["an array index past the end is absent, not undefined-equal", [{ pointer: "/a/2", op: "exists" }], { a: [1, 2] }, false],
  ["an array index with a leading zero is not an index", [{ pointer: "/a/01", op: "exists" }], { a: [1, 2] }, false],
  ["~1 is a slash and ~0 a tilde inside a key", [{ pointer: "/a~1b/c~0d", op: "eq", value: 1 }], { "a/b": { "c~d": 1 } }, true],
  ["the empty pointer is the whole input", [{ pointer: "", op: "eq", value: "paid" }], "paid", true],
  ["a pointer into a string finds nothing", [{ pointer: "/length", op: "exists" }], "abc", false],
  ["inherited names are not fields", [{ pointer: "/toString", op: "exists" }], {}, false],
  ["eq compares whole values, not their text", [{ pointer: "/n", op: "eq", value: 1 }], { n: "1" }, false],
  ["eq compares objects by content", [{ pointer: "/o", op: "eq", value: { x: [1, { y: 2 }] } }], { o: { x: [1, { y: 2 }] } }, true],
  ["in holds when the value is one of the listed", [{ pointer: "/c", op: "in", value: ["us", "ca"] }], { c: "ca" }, true],
  ["in fails for any other value", [{ pointer: "/c", op: "in", value: ["us", "ca"] }], { c: "mx" }, false],
  ["in fails for a missing field", [{ pointer: "/c", op: "in", value: ["us"] }], {}, false],
  ["gte holds at the bound", [{ pointer: "/n", op: "gte", value: 10 }], { n: 10 }, true],
  ["gte fails below it", [{ pointer: "/n", op: "gte", value: 10 }], { n: 9.99 }, false],
  ["lte holds at the bound and below", [{ pointer: "/n", op: "lte", value: 10 }], { n: -3 }, true],
  ["lte fails above it", [{ pointer: "/n", op: "lte", value: 10 }], { n: 11 }, false],
  ["gte never coerces a string", [{ pointer: "/n", op: "gte", value: 10 }], { n: "50" }, false],
  ["lte never coerces a string", [{ pointer: "/n", op: "lte", value: 10 }], { n: "1" }, false],
  ["a missing field fails a bound", [{ pointer: "/n", op: "lte", value: 10 }], {}, false],
  ["every check must hold", [{ pointer: "/a", op: "exists" }, { pointer: "/n", op: "gte", value: 1 }], { a: 1, n: 0 }, false],
  ["all checks holding is a match", [{ pointer: "/a", op: "exists" }, { pointer: "/n", op: "gte", value: 1 }], { a: 1, n: 1 }, true],
];
for (const [what, when, input, expected] of CASES) test(`preconditions: ${what}`, () => assert.equal(matches(when, input), expected));

test("deriveWhen states what a workflow's input schema requires, read from the document and never from prose", () => {
  const doc = (properties, required, extra = {}) => ({ input: { schemaId: "In" }, schemas: { In: { type: "object", properties, required, ...extra } } });
  assert.deepEqual(deriveWhen(doc({ sku: { type: "string" }, note: { type: "string" } }, ["sku"])), [{ pointer: "/sku", op: "exists" }]);
  assert.deepEqual(deriveWhen(doc({ c: { enum: ["us", "ca"] } }, ["c"])), [{ pointer: "/c", op: "exists" }, { pointer: "/c", op: "in", value: ["us", "ca"] }]);
  const states = Array.from({ length: 12 }, (_, i) => `s${i}`);
  assert.deepEqual(deriveWhen(doc({ c: { enum: states } }, ["c"])), [{ pointer: "/c", op: "exists" }, { pointer: "/c", op: "in", value: states }], "a longer enumeration keeps its check");
  const wide = Array.from({ length: 12 }, (_, i) => `${"w".repeat(44)}${String(i).padStart(1, "0")}`);
  assert.deepEqual(deriveWhen(doc({ c: { enum: wide } }, ["c"])), [{ pointer: "/c", op: "exists" }], "an enumeration too big for a trial to keep adds no check, and never an unwritable one");
  assert.deepEqual(deriveWhen(doc({ k: { const: "kyb" } }, ["k"])), [{ pointer: "/k", op: "exists" }, { pointer: "/k", op: "eq", value: "kyb" }]);
  assert.deepEqual(deriveWhen(doc({ n: { type: "number", minimum: 0, maximum: 5 } }, ["n"])), [{ pointer: "/n", op: "exists" }, { pointer: "/n", op: "gte", value: 0 }, { pointer: "/n", op: "lte", value: 5 }]);
  assert.deepEqual(deriveWhen(doc({ "a/b": { type: "string" } }, ["a/b"])), [{ pointer: "/a~1b", op: "exists" }]);
  assert.deepEqual(deriveWhen(doc({ n: { type: "number", minimum: 0 } }, [])), [], "a field the input may leave out adds no check");
  assert.deepEqual(deriveWhen(doc({ o: { enum: [{ nested: true }] } }, ["o"])), [{ pointer: "/o", op: "exists" }], "an enumeration of objects is not a membership check");
  assert.deepEqual(deriveWhen({ input: { schemaId: "In" }, schemas: { In: { type: "string" } } }), [], "a schema that is not an object gives none");
  assert.deepEqual(deriveWhen({ schemas: {} }), [], "no input schema, no checks");
  assert.deepEqual(deriveWhen(null), []);
  const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`f${i}`, { type: "string" }]));
  assert.equal(deriveWhen(doc(many, Object.keys(many))).length, TRIAL_LIMITS.preconditions);
});

test("checkPreconditions refuses what a trial cannot keep, so a host's own checks fail at admission, never at render", () => {
  checkPreconditions([{ pointer: "/a", op: "exists" }, { pointer: "/b", op: "in", value: ["x", "y"] }]);
  assert.throws(() => checkPreconditions([{ pointer: "/a", op: "eq", value: "x".repeat(513) }]), (e) => e.code === "format");
  assert.throws(() => checkPreconditions([{ pointer: "/a", op: "eq", value: undefined }]), (e) => e.code === "format");
  assert.throws(() => checkPreconditions(Array.from({ length: 16 }, (_, i) => ({ pointer: `/field-with-a-long-name-${i}`, op: "eq", value: "v".repeat(100) }))), (e) => e.code === "format");
});

test("pruneUses keeps the newest uses of the live revision's standing whatever else arrives, and moves every boundary", () => {
  const uses = [
    ...Array.from({ length: 5 }, (_, i) => ({ run: `old-${i}`, sha256: sha("a"), outcome: "frozen", at: at(2) })),
    ...Array.from({ length: 40 }, (_, i) => ({ run: `other-${i}`, sha256: sha("b"), outcome: "frozen", at: at(3) })),
    { run: "mine-1", sha256: sha("a"), outcome: "failed", at: at(4) },
  ];
  const t = trial({ revisions: [{ sha256: sha("a"), status: "trial", since: at(1), run: "run-1", after: 2 }, { sha256: sha("b"), status: "retired", since: at(1), run: "run-2", after: 30 }], uses });
  const cut = pruneUses(t, 20);
  assert.equal(cut.uses.length, 20);
  assert.deepEqual(cut.uses.filter((u) => u.sha256 === sha("a")).map((u) => u.run), ["old-2", "old-3", "old-4", "mine-1"], "the live revision's uses since its boundary stay; the ones before it go");
  assert.equal(cut.revisions[0].after, 0, "nothing of its before-boundary uses is left, so its boundary is the start");
  assert.ok(cut.revisions[1].after <= cut.uses.length);
  assert.equal(pruneUses(t, 100), t, "nothing to cut, nothing changed");
  checkTrial(cut);
});
