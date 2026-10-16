// Spec changes, not edits to make code pass (rulings 11 to 14 of 2026-10-16): the curator writes learnings/L-<12 hex>.md
// only (learnings/INDEX.md is refused: the index is derived, never stored) and SKILL.md and trial.json in a skill folder
// (no subfolders); ZWJ and ZWNJ between letters pass only in scripts that use them; the curator may write the DSL store's
// records, a run may not. Eleven corpus cases that expected a plain name or a skill subfolder to pass now expect refuse,
// and their text sits in allow.moved.* cases on the run's own inbox path (test/fixtures/guard-corpus.mjs).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CAPS, createGuard, guard, LEARN_TYPES } from "../dist/index.js";
import { cases, RUN_ID } from "./fixtures/guard-corpus.mjs";
import { cases as workflowCases } from "./fixtures/guard-workflow-corpus.mjs";

const refusals = (role, input) => guard({ role, runId: RUN_ID, files: { [input.path]: input.text }, secrets: input.secrets ?? [] });
const reasonsOf = (list) => new Set(list.map((r) => r.reason));
// A case names no role: it is allowed when the run role or the curate role allows it, and each role's allowlist is strict.
const verdict = (input) => {
  const asRun = refusals("run", input);
  const asCurate = refusals("curate", input);
  return { allowed: asRun.length === 0 || asCurate.length === 0, asRun, asCurate };
};
const ownRole = (path) => (path.startsWith("inbox/") || path.startsWith("uses/") ? "run" : "curate");
const FAMILY = {
  secret: ["secret_value", "secret_shape"],
  unicode: ["invisible_unicode"],
  size: ["too_large"],
  path: ["rules_locked", "path_not_allowed", "invisible_unicode"],
};

test("the corpus holds 190 cases and the 11 that carry the content of closed paths, with unique ids", () => {
  assert.equal(cases.length, 201);
  assert.equal(cases.filter((c) => c.id.startsWith("allow.moved.")).length, 11);
  assert.equal(cases.filter((c) => c.id.startsWith("path.strict.")).length, 11);
  assert.equal(new Set(cases.map((c) => c.id)).size, cases.length);
  for (const c of cases) {
    assert.ok(["secret", "path", "unicode", "size", "allow"].includes(c.kind), c.id);
    assert.ok(["refuse", "allow"].includes(c.expect), c.id);
    assert.equal(typeof c.input.path, "string", c.id);
    assert.equal(typeof c.input.text, "string", c.id);
  }
});

test("the corpus source holds no literal secret shape", () => {
  const source = readFileSync(new URL("./fixtures/guard-corpus.mjs", import.meta.url), "utf8");
  const shapes = [
    ["AWS key id", /\b(?:AKIA|ASIA|AIDA|AROA)[0-9A-Z]{16}\b/],
    ["Google API key", /AIza[0-9A-Za-z_-]{35}/],
    ["PEM header", /-----BEGIN[ A-Z0-9]*-----/],
    ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}/],
    ["sk- key", /\bsk-[A-Za-z0-9_-]{20,}/],
    ["Slack token", /\bxox[abposre]-[A-Za-z0-9-]{10,}|\bxapp-[A-Za-z0-9-]{10,}/],
    ["JWT", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
    ["URL with userinfo", /\b[a-z][a-z0-9+.-]*:\/\/[^\s/?#@]+@/i],
  ];
  for (const [name, re] of shapes) assert.doesNotMatch(source, re, `the corpus holds a literal ${name}`);
});

for (const c of [...cases, ...workflowCases]) {
  test(`corpus ${c.id} (${c.kind}, expect ${c.expect})`, () => {
    const v = verdict(c.input);
    const got = v.allowed ? "allow" : "refuse";
    const summary = (list) => list.map((r) => `${r.reason}: ${r.detail}`).join("; ") || "none";
    assert.equal(got, c.expect, `${c.reason}. As run: ${summary(v.asRun)}. As curate: ${summary(v.asCurate)}.`);
    if (c.expect !== "refuse") return;
    // Refused for the right reason, judged under the role that owns the path.
    const own = ownRole(c.input.path) === "run" ? v.asRun : v.asCurate;
    const reasons = reasonsOf([...own, ...v.asRun, ...v.asCurate]);
    assert.ok(FAMILY[c.kind].some((reason) => reasons.has(reason)), `${c.id} was refused for ${[...reasons].join(", ")}`);
    // A refusal never repeats the secret it matched, or a name that held it.
    const shown = JSON.stringify([...v.asRun, ...v.asCurate]);
    for (const secret of c.input.secrets ?? []) assert.ok(!shown.includes(secret), `${c.id}: a refusal repeats a planted value`);
    for (const token of c.input.text.split(/[\s"'`,=:]+/).filter((t) => t.length >= 16)) assert.ok(!shown.includes(token), `${c.id}: a refusal repeats matched text`);
  });
}

const candidate = (over = {}) => ({ callId: "call-1", type: "lesson", text: "Search registries by the legal name without the suffix.", evidence: ["a 404 on the full name"], ...over });

test("a run with candidates only needs no run id and no files", () => {
  assert.deepEqual(guard({ role: "run", candidates: [candidate(), candidate({ callId: "c2", type: "used", id: "L-0123456789ab", text: "", evidence: [] })] }), []);
});

test("every role refuses AGENTS.md and agent.json, and each role keeps to its own paths", () => {
  for (const role of ["run", "curate"]) {
    for (const file of ["AGENTS.md", "agent.json", "learnings/agents.md", ".agents/skills/x/Agent.JSON"]) {
      assert.ok(reasonsOf(guard({ role, runId: RUN_ID, files: { [file]: "x" } })).has("rules_locked"), `${role} ${file}`);
    }
  }
  assert.ok(reasonsOf(guard({ role: "run", runId: RUN_ID, files: { "learnings/L-0123456789ab.md": "x" } })).has("path_not_allowed"));
  assert.ok(reasonsOf(guard({ role: "curate", files: { "inbox/b2-run.md": "x" } })).has("path_not_allowed"));
  assert.ok(reasonsOf(guard({ role: "curate", files: { "uses/b2-run.json": "{}" } })).has("path_not_allowed"));
});

test("trial.json is written by the curator inside a skill folder only", () => {
  assert.deepEqual(guard({ role: "curate", files: { ".agents/skills/kyb/trial.json": "{}" } }), []);
  for (const file of ["learnings/trial.json", "trial.json", ".agents/skills/kyb/deep/trial.json"]) {
    assert.ok(reasonsOf(guard({ role: "curate", files: { [file]: "{}" } })).has("path_not_allowed"), file);
  }
  assert.ok(reasonsOf(guard({ role: "run", runId: RUN_ID, files: { ".agents/skills/kyb/trial.json": "{}" } })).has("path_not_allowed"));
});

test("the curator may write DSL workflow records and nothing else under .pi", () => {
  const digest = "a".repeat(64);
  assert.deepEqual(guard({ role: "curate", files: { [`.pi/agentrun/workflows/kyb/${digest}.json`]: "{}", ".pi/agentrun/workflows/kyb/latest": digest } }), []);
  for (const file of [".pi/agentrun/workflows/kyb/notes.md", ".pi/agentrun/workflows/kyb/x/latest", ".pi/settings.json", `.pi/agentrun/workflows/../${digest}.json`]) {
    assert.ok(guard({ role: "curate", files: { [file]: "{}" } }).length > 0, file);
  }
});

test("a .git segment is refused for every role in any spelling", () => {
  for (const role of ["run", "curate"]) {
    for (const file of [".git/config", ".GIT/config", "learnings/.Git/x.md", "learnings/\uff0egit/x.md", "learnings/.git /x.md", ".agents/skills/x/.git/HEAD", "learnings/GIT~1/x.md"]) {
      const out = guard({ role, runId: RUN_ID, files: { [file]: "x" } });
      assert.ok(reasonsOf(out).has("path_not_allowed"), `${role} ${JSON.stringify(file)}`);
    }
  }
});

test("a name that holds a secret is never echoed back in a refusal", () => {
  const secret = ["Zinnia", "?>", "q7Rk2Mw"].join("");
  const out = guard({ role: "curate", files: { [`learnings/${secret}.md`]: "ordinary" }, secrets: [secret] });
  assert.ok(reasonsOf(out).has("secret_value"));
  assert.ok(!JSON.stringify(out).includes(secret));
  assert.ok(!JSON.stringify(out).includes("Zinnia"));
});

test("candidates: types, caps, secrets and hidden characters are refused with their field", () => {
  const out = guard({
    role: "run",
    candidates: [
      candidate({ type: "note" }),
      candidate({ callId: "c2", text: "x".repeat(CAPS.text + 1) }),
      candidate({ callId: "c3", evidence: ["e".repeat(CAPS.evidence), "one more"] }),
      candidate({ callId: "c4", evidence: "not a list" }),
      candidate({ callId: "c5", id: "not-an-id", type: "used" }),
      candidate({ callId: "c6", text: "a\u202eb" }),
      candidate({ callId: "c7", evidence: new Array(CAPS.evidenceItems + 1).fill("x") }),
    ],
  });
  const at = (field) => out.filter((r) => r.field === field).map((r) => r.reason);
  assert.deepEqual(at("candidates[0].type"), ["invalid"]);
  assert.deepEqual(at("candidates[1].text"), ["too_large"]);
  assert.deepEqual(at("candidates[2].evidence"), ["too_large"]);
  assert.deepEqual(at("candidates[3].evidence"), ["invalid"]);
  assert.deepEqual(at("candidates[4].id"), ["invalid"]);
  assert.deepEqual(at("candidates[5].text"), ["invisible_unicode"]);
  assert.deepEqual(at("candidates[6].evidence"), ["too_many"]);
  assert.deepEqual(guard({ role: "run", candidates: new Array(CAPS.perRun + 1).fill(candidate()) }).map((r) => r.reason), ["too_many"]);
  assert.deepEqual(guard({ role: "run", candidates: [candidate({ callId: "" })] }).map((r) => r.reason), ["invalid"]);
});

test("candidate text holding a host secret or a secret shape is refused", () => {
  const secret = ["Marigold", "!", "w4Tz9Qe"].join("");
  const key = ["AK", "IA", "ABCDEFGHIJKLMNOP"].join("");
  const out = guard({ role: "run", secrets: [secret], candidates: [candidate({ text: `the key was ${secret}` }), candidate({ callId: "c2", evidence: [`id ${key}`] })] });
  assert.deepEqual(out.map((r) => [r.field, r.reason]), [["candidates[0].text", "secret_value"], ["candidates[1].evidence[0]", "secret_shape"]]);
  assert.ok(!JSON.stringify(out).includes(secret) && !JSON.stringify(out).includes(key));
});

test("case data: a case value of 4 or more characters is refused in any case, split over lines, in text, files and names", () => {
  const caseValues = ["Acme Holdings GmbH", "xy", "12345"];
  const refused = (input) => reasonsOf(guard({ role: "run", runId: RUN_ID, caseValues, ...input }));
  assert.ok(refused({ candidates: [candidate({ text: "For acme holdings gmbh, use the registry." })] }).has("case_data"));
  assert.ok(refused({ candidates: [candidate({ text: "For ACME\n  HOLDINGS   GmbH only." })] }).has("case_data"));
  for (const text of ["12\n345", "1 2 3 4 5", "12\r\n   345", "For Ac\nme Holdings\tGmbH"]) {
    assert.ok(refused({ candidates: [candidate({ text })] }).has("case_data"), `a value split by whitespace: ${JSON.stringify(text)}`);
  }
  assert.ok(guard({ role: "run", caseValues: ["Acme"], candidates: [candidate({ text: "Ac\nme" })] }).some((r) => r.reason === "case_data"));
  assert.deepEqual(guard({ role: "run", caseValues: ["a b c"], candidates: [candidate({ text: "abc is short" })] }), [], "a value under 4 characters once its whitespace is gone is ignored");
  assert.ok(refused({ candidates: [candidate({ evidence: ["order 12345 failed"] })] }).has("case_data"));
  assert.ok(refused({ files: { [`inbox/${RUN_ID}.md`]: "see 12345" } }).has("case_data"));
  assert.ok(refused({ files: { [`inbox/${RUN_ID}.md`]: "ok", "learnings/12345.md": "ok" } }).has("case_data"));
  assert.ok(refused({ candidates: [candidate({ text: "\uff21cme Holdings GmbH" })] }).has("case_data"), "fullwidth letters fold to the value");
  assert.deepEqual([...refused({ candidates: [candidate({ text: "A rule with xy in it, and 1234 too." })] })], [], "a value under 4 characters or a near miss is not case data");
  const out = guard({ role: "run", caseValues, candidates: [candidate({ text: "Acme Holdings GmbH" })] });
  assert.ok(!JSON.stringify(out).toLowerCase().includes("acme"));
});

test("a secret too short to match without false hits refuses everything and says so", () => {
  const out = guard({ role: "run", secrets: ["short"], candidates: [candidate()] });
  assert.deepEqual(out.map((r) => [r.reason, r.field]), [["invalid", "secrets"]]);
  assert.deepEqual(guard({ role: "run", secrets: ["", "a\n b\tc d e f g"], candidates: [candidate()] }).map((r) => r.reason), ["invalid"]);
  assert.deepEqual(guard({ role: "run", secrets: [""], candidates: [candidate()] }), [], "an empty value is no secret");
  assert.deepEqual(guard({ role: "run", secrets: [7], candidates: [] }).map((r) => r.reason), ["invalid"]);
});

test("a run with files needs a valid run id", () => {
  assert.ok(reasonsOf(guard({ role: "run", files: { "inbox/x.md": "x" } })).has("path_not_allowed"));
  assert.ok(reasonsOf(guard({ role: "run", runId: "../x", files: { "inbox/../x.md": "x" } })).has("invalid"));
  assert.deepEqual(guard({ role: "run", runId: "run-1", files: { "inbox/run-1.md": "x" } }), []);
  assert.deepEqual(guard({ role: "chief", runId: "run-1" }).map((r) => r.reason), ["invalid"]);
});

test("the file count and byte caps are the defaults, frozen, and createGuard sets others", () => {
  assert.throws(() => { CAPS.files = 1; }, TypeError);
  assert.equal(CAPS.learning, 4096);
  const many = Object.fromEntries(Array.from({ length: CAPS.files + 1 }, (_, i) => [`learnings/n${i}.md`, "x"]));
  assert.deepEqual(guard({ role: "curate", files: many }).map((r) => r.reason), ["too_many"]);
  const small = createGuard({ inbox: 100, files: 1 });
  assert.deepEqual(small({ role: "run", runId: "r", files: { "inbox/r.md": "x".repeat(101) } }).map((r) => r.reason), ["too_large"]);
  assert.deepEqual(small({ role: "run", runId: "r", files: { "inbox/r.md": "x".repeat(100) } }), []);
  assert.throws(() => createGuard({ inbox: 0 }), TypeError);
  assert.throws(() => createGuard({ text: 1.5 }), TypeError);
});

test("emoji and the joiners of scripts that need them are text; nothing else invisible is", () => {
  const ok = [
    "ship it \u2764\ufe0f", "family \u{1f468}\u200d\u{1f469}\u200d\u{1f467}", "keycap 1\ufe0f\u20e3", "fire \u2764\ufe0f\u200d\u{1f525}",
    "coder \u{1f469}\u{1f3fd}\u200d\u{1f4bb}", "\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645", "\u0d28\u0d4d\u200d\u0d28", "\u0dc1\u0dca\u200d\u0dbb",
  ];
  for (const text of ok) assert.deepEqual(guard({ role: "run", candidates: [candidate({ text })] }), [], JSON.stringify(text));
  const bad = [
    "lea\u200drning", "lea\u200crning", "a\ufe0f", "7\ufe0e", "\u{1f600}\u200d", "\u200d\u{1f600}", "x\u200b", "x\u2060", "x\u{e0067}", "x\u{e0100}", "x\u202ey", "x\u200fy", "x\ufeff", "x\u2800y", "x\u0085y",
    "a\u200d\u{1f600}",
  ];
  for (const text of bad) assert.ok(reasonsOf(guard({ role: "run", candidates: [candidate({ text })] })).has("invisible_unicode"), JSON.stringify(text));
});

test("a secret inside a JSON string is found past its escapes", () => {
  const secret = ["Hy", "dran", "gea", '"quoted\\', "slash"].join("");
  const uses = JSON.stringify({ note: `key ${secret}` });
  assert.ok(!uses.includes(secret), "the escapes hide the secret from a plain search");
  assert.ok(reasonsOf(guard({ role: "run", runId: "r", files: { "uses/r.json": uses }, secrets: [secret] })).has("secret_value"));
});

function seeded(seed) {
  let state = seed >>> 0;
  return () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 0x100000000);
}

test("random secrets are found in every encoding at every alignment, and a near miss is not", () => {
  const rand = seeded(7);
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=?!&. ";
  const make = (n) => Array.from({ length: n }, () => alphabet[Math.floor(rand() * alphabet.length)]).join("").trim().padEnd(n, "x");
  const encoders = {
    raw: (s) => s,
    b64: (s) => Buffer.from(s).toString("base64"),
    b64u: (s) => Buffer.from(s).toString("base64url"),
    hex: (s) => Buffer.from(s).toString("hex"),
    hexUpper: (s) => Buffer.from(s).toString("hex").toUpperCase(),
    pct: (s) => encodeURIComponent(s),
    pctLower: (s) => encodeURIComponent(s).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()),
    form: (s) => encodeURIComponent(s).replace(/%20/g, "+"),
    wrapped: (s) => (Buffer.from(s).toString("base64").match(/.{1,6}/g) ?? []).join("\n"),
  };
  for (let n = 0; n < 40; n++) {
    const secret = make(8 + (n % 25));
    for (const [name, encode] of Object.entries(encoders)) {
      for (const prefix of ["", "q", "qr", "qrs"]) {
        const text = name === "raw" || name === "pct" || name === "pctLower" || name === "form" || name === "hex" || name === "hexUpper"
          ? `see ${prefix}${encode(secret)} end` : `blob ${encode(`${prefix}${secret}`)} end`;
        assert.ok(reasonsOf(guard({ role: "run", candidates: [candidate({ text })], secrets: [secret] })).has("secret_value"), `${name} ${JSON.stringify(prefix)} of secret ${n}`);
      }
    }
    // A change in the middle: the last and first bytes of a base64 needle are only partly covered, and a hit on those is a refusal, not a leak.
    const near = `${secret.slice(0, 4)}${secret[4] === "Z" ? "Y" : "Z"}${secret.slice(5)}`;
    assert.deepEqual(guard({ role: "run", candidates: [candidate({ text: `old ${near} and ${encoders.b64(near)}` })], secrets: [secret] }), [], `a near miss of secret ${n}`);
  }
});

test("workflow records belong to a run's inbox folder, and the DSL's store paths to the curator", () => {
  const digest = "0123456789abcdef".repeat(4);
  const inbox = `inbox/run-1/workflows/kyb/${digest}.json`;
  const store = `.pi/agentrun/workflows/kyb/${digest}.json`;
  assert.deepEqual(guard({ role: "run", runId: "run-1", files: { [inbox]: "{}", "inbox/run-1/workflows/kyb/latest": digest } }), []);
  assert.ok(reasonsOf(guard({ role: "run", runId: "run-1", files: { [store]: "{}" } })).has("path_not_allowed"));
  assert.ok(reasonsOf(guard({ role: "curate", files: { [inbox]: "{}" } })).has("path_not_allowed"));
  assert.ok(reasonsOf(guard({ role: "run", runId: "run-2", files: { [inbox]: "{}" } })).has("path_not_allowed"));
  assert.deepEqual(guard({ role: "curate", files: { [store]: "{}" } }), []);
});

test("a workflow candidate names a workflow, every other candidate a learning", () => {
  const named = (type, id) => guard({ role: "run", candidates: [candidate({ type, id })] }).map((r) => [r.field, r.reason]);
  assert.ok(LEARN_TYPES.includes("workflow"));
  assert.deepEqual(named("workflow", "kyb-us-registry"), []);
  assert.deepEqual(named("workflow", "L-0123456789ab"), [["candidates[0].id", "invalid"]], "a learning id is not a workflow name");
  for (const id of ["not a name", "../x", "Kyb", "my.flow"]) assert.deepEqual(named("workflow", id), [["candidates[0].id", "invalid"]], id);
  assert.deepEqual(named("used", "kyb-us-registry"), [["candidates[0].id", "invalid"]]);
  assert.deepEqual(named("used", "L-0123456789ab"), []);
});

test("the curator writes learnings/L-<12 hex>.md, SKILL.md and trial.json, and nothing else (rulings 11 and 12)", () => {
  const curate = (file) => guard({ role: "curate", files: { [file]: "x" } });
  for (const file of ["learnings/L-0123456789ab.md", ".agents/skills/kyb/SKILL.md", ".agents/skills/my.skill/trial.json"]) assert.deepEqual(curate(file), [], file);
  for (const file of [
    "learnings/INDEX.md", "learnings/notes.md", "learnings/L-0123456789AB.md", "learnings/L-0123456789a.md", "learnings/L-0123456789abc.md",
    "learnings/L-0123456789ab.txt", "learnings/sub/L-0123456789ab.md", "learnings/L-0123456789ab.md/x", "learnings/ L-0123456789ab.md",
    ".agents/skills/kyb/references/checklist.md", ".agents/skills/kyb/refs/checklist.md", ".agents/skills/kyb/notes.md", ".agents/skills/kyb/skill.md",
    ".agents/skills/SKILL.md", ".agents/skills/kyb/SKILL.md/x", ".agents/skills/not a name/SKILL.md", ".agents/config.toml",
  ]) {
    assert.ok(reasonsOf(curate(file)).has("path_not_allowed"), file);
  }
});
