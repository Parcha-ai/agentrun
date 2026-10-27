import assert from "node:assert/strict";
import { test } from "node:test";
import { CAPS, checkRun, defaultTools } from "../dist/index.js";
import { BRANCH, FORK, NOTE_ID, OLD_NOTE, RUN, check, cleanFiles, index, memo, note, piNote, readme, rules, skill, workflow } from "./support.mjs";

const NOTE = `learnings/${NOTE_ID}.md`;
const MEMO = `memos/${RUN}.md`;
const DRAFT = "workflows/find-policies/workflow.json";
const SKILL = ".agents/skills/find-policies/SKILL.md";

const withFiles = (files) => ({ ...cleanFiles(), ...files });
/** The memo of the clean branch, also naming `paths` under Proposed changes. */
const listing = (...paths) => ({ [MEMO]: memo({ proposed: ["learnings/L-7c21e0a4b9d3.md (new)", ".agents/skills/find-policies/ (new)", "workflows/find-policies/ (new draft)", ...paths] }) });
const hexId = (n) => `L-${n.toString(16).padStart(12, "0")}`;

// ---------------------------------------------------------------- planted controls

test("a clean run's branch passes", () => {
  assert.deepEqual(check(cleanFiles()), []);
});

test("a note the Pi learning loop wrote is a valid note, with its extra fields", () => {
  assert.deepEqual(check(withFiles({ [NOTE]: piNote() })), []);
});

test("a note in the design's neutral form, with a quoted run list, passes", () => {
  assert.deepEqual(check(withFiles({ [NOTE]: note({ runs: `["${RUN}"]` }) })), []);
});

test("a change to an existing note that confirms it passes", () => {
  const files = withFiles({ [`learnings/${OLD_NOTE}.md`]: note({ id: OLD_NOTE, runs: `[2026-10-20-0100-ffff, ${RUN}]` }), ...listing(`learnings/${OLD_NOTE}.md (confirmed)`) });
  assert.deepEqual(check(files), []);
});

// ---------------------------------------------------------------- the branch

test("a branch that is not runs/<run id> is refused", () => {
  assert.deepEqual(rules(check(cleanFiles(), { branch: "main" })), ["branch"]);
  assert.deepEqual(rules(check(cleanFiles(), { branch: "runs/..x" })), ["branch"]);
  assert.deepEqual(rules(check(cleanFiles(), { branch: `run/${RUN}` })), ["branch"]);
});

// ---------------------------------------------------------------- the layout

test("a changed path outside the layout is refused, by file", () => {
  for (const path of ["notes.txt", "learnings/sub/L-7c21e0a4b9d3.md", "learnings/L-7C21E0A4B9D3.md", "learnings/note.md", ".agents/skills/find-policies/run.sh", ".agents/skills/Find/SKILL.md", "workflows/find-policies/other.json", "workflows/Find/README.md", "memos/x/y.md", ".git/config", ".pi/agentrun/workflows/x/latest"]) {
    const problems = check(withFiles({ [path]: "text\n", ...listing(path) }));
    assert.deepEqual(rules(problems), ["outside_layout"], path);
    assert.equal(problems[0].path, path);
  }
});

test("AGENTS.md and agent.json are never touched, in any spelling or depth", () => {
  for (const path of ["AGENTS.md", "agent.json", "Agents.MD", "AGENTS.md.", "learnings/agents.md", "workflows/agent.json/README.md", "AGENTS​.md", "ＡＧＥＮＴＳ.md"]) {
    const problems = check(withFiles({ [path]: "new rules\n", ...listing(path) }));
    assert.deepEqual(rules(problems), ["untouched"], path);
  }
  assert.deepEqual(rules(check(withFiles({ "AGENTS.md": null, ...listing("AGENTS.md") }))), ["untouched"]);
});

test("a symlink, an executable or a submodule is refused", () => {
  for (const mode of ["120000", "100755", "160000"]) assert.deepEqual(rules(check(cleanFiles(), { mode: { [SKILL]: mode } })), ["file_mode"], mode);
  assert.deepEqual(check(cleanFiles(), { mode: { [SKILL]: "100644" } }), []);
});

test("a note, the index or a memo is never deleted; a whole skill or draft may be", () => {
  assert.deepEqual(rules(check(withFiles({ [`learnings/${OLD_NOTE}.md`]: null, ...listing(`learnings/${OLD_NOTE}.md`) }))), ["deleted"]);
  assert.deepEqual(rules(check(withFiles({ "learnings/INDEX.md": null }))), ["deleted"]);
  assert.deepEqual(rules(check(withFiles({ "memos/2026-10-20-0100-ffff.md": null }), { main: ["memos/2026-10-20-0100-ffff.md"] })), ["deleted", "other_memo"]);
  const gone = { [DRAFT]: null, "workflows/find-policies/README.md": null, [SKILL]: null };
  assert.deepEqual(check(withFiles(gone), { main: [DRAFT, "workflows/find-policies/README.md", SKILL, "learnings/INDEX.md"] }), []);
});

test("a file that is not UTF-8 is refused", () => {
  assert.deepEqual(rules(check(withFiles({ [SKILL]: Buffer.from([0x2d, 0x2d, 0x2d, 0x0a, 0xff, 0xfe, 0x0a]) }))), ["encoding"]);
});

// ---------------------------------------------------------------- the caps

test("a note over 4096 bytes is refused, and one at 4096 passes", () => {
  const pad = (size) => { const base = note({ body: "" }); return note({ body: "x".repeat(size - Buffer.byteLength(base)) }); };
  assert.equal(Buffer.byteLength(pad(4096)), 4096);
  assert.deepEqual(check(withFiles({ [NOTE]: pad(4096) })), []);
  const problems = check(withFiles({ [NOTE]: pad(4097) }));
  assert.deepEqual(rules(problems), ["too_large"]);
  assert.equal(problems[0].path, NOTE);
  assert.equal(CAPS.note, 4096);
});

test("an index over 4096 bytes is refused", () => {
  const big = `# Learnings\n${"\n".repeat(4100)}- ${NOTE_ID}: Shopify stores keep their policies at /policies/.\n`;
  assert.deepEqual(rules(check(withFiles({ "learnings/INDEX.md": big }))), ["too_large"]);
});

test("a memo over 16384 bytes, or a skill over 32768, is refused", () => {
  assert.deepEqual(rules(check(withFiles({ [MEMO]: memo({ extra: `- ${"y".repeat(16384)}\n` }) }))), ["too_large"]);
  assert.deepEqual(rules(check(withFiles({ [SKILL]: skill() + "z".repeat(32768) }))), ["too_large"]);
});

test("a ninth new note in one run is refused; eight pass", () => {
  const files = (count) => {
    const ids = Array.from({ length: count }, (_, n) => hexId(n + 1));
    return { ...cleanFiles(), [NOTE]: note({ id: hexId(1) }), ...Object.fromEntries(ids.map((id) => [`learnings/${id}.md`, note({ id })])), "learnings/INDEX.md": index(ids), [MEMO]: memo({ proposed: [...ids.map((id) => `learnings/${id}.md`), ".agents/skills/find-policies/", "workflows/find-policies/"] }) };
  };
  const eight = files(8);
  delete eight[NOTE];
  assert.deepEqual(check(eight), []);
  const nine = files(9);
  delete nine[NOTE];
  assert.deepEqual(rules(check(nine)), ["too_many_notes"]);
});

// ---------------------------------------------------------------- the memo

test("the branch must carry its own memo", () => {
  const files = cleanFiles();
  delete files[MEMO];
  assert.deepEqual(rules(check(files)), ["memo_missing"]);
});

test("a memo whose run is not the branch's is refused", () => {
  assert.deepEqual(rules(check(withFiles({ [MEMO]: memo({ run: "2026-10-27-0412-ffff" }) }))), ["memo_run"]);
});

test("a memo whose base is not the commit the branch starts from is refused", () => {
  assert.deepEqual(rules(check(withFiles({ [MEMO]: memo({ base: "aaaaaaa" }) }))), ["memo_base"]);
  assert.deepEqual(check(withFiles({ [MEMO]: memo({ base: FORK }) })), []);
});

test("a change to another run's memo is refused", () => {
  const other = "memos/2026-10-20-0100-ffff.md";
  assert.deepEqual(rules(check(withFiles({ [other]: memo({ run: "2026-10-20-0100-ffff" }), ...listing(other) }))), ["other_memo"]);
});

test("a memo out of shape is refused", () => {
  const sections = memo();
  const cases = {
    "no front matter": sections.replace(/^---[\s\S]*?---\n/, ""),
    "an unknown outcome": memo({ outcome: "great" }),
    "a missing section": sections.replace("## What could be better\n", ""),
    "sections out of order": sections.replace("## What happened", "## TMP").replace("## What I learned", "## What happened").replace("## TMP", "## What I learned"),
    "an extra section": sections.replace("## Proposed changes", "## Thoughts\nnone\n\n## Proposed changes"),
    "an empty What happened": sections.replace("Looked up the refund policy of a store and found it on the third try.\n", ""),
    "an unknown key": sections.replace("harness: codex", "harness: codex\nmood: fine"),
    "a missing base": sections.replace(/^base: .*\n/m, ""),
    "a negative cost": sections.replace("cost_usd: 0.42", "cost_usd: -1"),
  };
  for (const [name, text] of Object.entries(cases)) assert.deepEqual(rules(check(withFiles({ [MEMO]: text }))), ["memo"], name);
});

test("a changed file the memo does not propose is refused", () => {
  const problems = check(withFiles({ [MEMO]: memo({ proposed: ["learnings/L-7c21e0a4b9d3.md (new)", "workflows/find-policies/ (new draft)"] }) }));
  assert.deepEqual(rules(problems), ["memo_unlisted"]);
  assert.equal(problems[0].path, SKILL);
});

// ---------------------------------------------------------------- notes and the index

test("a note out of shape is refused", () => {
  const cases = {
    "no front matter": "Shopify stores keep their policies at /policies/.\n",
    "an unknown type": note({ type: "hunch" }),
    "an unknown status": note({ status: "maybe" }),
    "no runs": note().replace(/^runs: .*\n/m, ""),
    "a bad run id": note({ runs: "[../x]" }),
    "a bad supersedes": note({ supersedes: "[L-xyz]" }),
    "supersedes itself": note({ supersedes: `[${NOTE_ID}]` }),
    "an empty body": note({ body: "" }),
    "an unknown key": note().replace("status: active", "status: active\nmood: fine"),
    "a key twice": note().replace("status: active", "status: active\nstatus: active"),
    "a carriage return": note({ body: "line one\r\nline two" }),
  };
  for (const [name, text] of Object.entries(cases)) assert.deepEqual(rules(check(withFiles({ [NOTE]: text }))), ["note"], name);
});

test("a note whose id is not its file name is refused", () => {
  const problems = check(withFiles({ [NOTE]: note({ id: OLD_NOTE }) }));
  assert.deepEqual(rules(problems), ["note"]);
  assert.match(problems[0].detail, /file name/);
});

test("a new note that does not name this run is refused", () => {
  assert.deepEqual(rules(check(withFiles({ [NOTE]: note({ runs: "[2026-10-20-0100-ffff]" }) }))), ["note_run"]);
});

test("an index out of shape, or naming a note that is not there, is refused", () => {
  assert.deepEqual(rules(check(withFiles({ "learnings/INDEX.md": "Shopify stores keep their policies at /policies/.\n" }))), ["index"]);
  assert.deepEqual(rules(check(withFiles({ "learnings/INDEX.md": index([NOTE_ID, NOTE_ID]) }))), ["index"]);
  assert.deepEqual(rules(check(withFiles({ "learnings/INDEX.md": index([NOTE_ID, "L-ffffffffffff"]) }))), ["index_note"]);
  assert.deepEqual(check(withFiles({ "learnings/INDEX.md": index([NOTE_ID, OLD_NOTE]) })), []);
});

// ---------------------------------------------------------------- skills

test("a skill out of shape is refused", () => {
  assert.deepEqual(rules(check(withFiles({ [SKILL]: "# Find policies\n" }))), ["skill"]);
  assert.deepEqual(rules(check(withFiles({ [SKILL]: skill({ name: "other" }) }))), ["skill"]);
  assert.deepEqual(rules(check(withFiles({ [SKILL]: skill({ description: "" }) }))), ["skill"]);
});

// ---------------------------------------------------------------- workflow drafts

test("a workflow draft that calls a Codex-only tool is refused", () => {
  const problems = check(withFiles({ [DRAFT]: workflow({ tools: ["fetch_page", "exec_command"] }) }));
  assert.deepEqual(rules(problems), ["harness_tool"]);
  assert.equal(problems[0].path, DRAFT);
  assert.match(problems[0].detail, /exec_command/);
  assert.match(problems[0].detail, /codex/);
  assert.deepEqual(rules(check(withFiles({ [DRAFT]: workflow({ tools: ["apply_patch"] }) }))), ["harness_tool"]);
});

test("a workflow draft that calls a Pi-only tool is refused", () => {
  const problems = check(withFiles({ [DRAFT]: workflow({ tools: ["bash"] }) }));
  assert.deepEqual(rules(problems), ["harness_tool"]);
  assert.match(problems[0].detail, /\bpi\b/);
  assert.deepEqual(rules(check(withFiles({ [DRAFT]: workflow({ tools: ["read"] }) }))), ["harness_tool"]);
});

test("a workflow draft that calls a Claude Code tool is refused, in any case", () => {
  assert.deepEqual(rules(check(withFiles({ [DRAFT]: workflow({ tools: ["WebFetch"] }) }))), ["harness_tool"]);
  assert.deepEqual(rules(check(withFiles({ [DRAFT]: workflow({ tools: ["webfetch"] }) }))), ["harness_tool"]);
});

test("a workflow draft that names a tool outside the shared layer is refused", () => {
  assert.deepEqual(rules(check(withFiles({ [DRAFT]: workflow({ tools: ["send_email"] }) }))), ["unknown_tool"]);
});

test("a call node's tool is checked like a model node's", () => {
  const draft = JSON.parse(workflow());
  draft.root = { node: "call", label: "find", via: "tool", tool: "shell", args: {}, out: "Policies", as: "policies", deadline_s: 5 };
  assert.deepEqual(rules(check(withFiles({ [DRAFT]: JSON.stringify(draft) }))), ["harness_tool"]);
});

test("a host's shared list replaces the default, and never admits a built-in name", () => {
  const tools = { shared: ["send_email", "read"] };
  assert.deepEqual(check(withFiles({ [DRAFT]: workflow({ tools: ["send_email"] }) }), { tools }), []);
  assert.deepEqual(rules(check(withFiles({ [DRAFT]: workflow({ tools: ["fetch_page"] }) }), { tools })), ["unknown_tool"]);
  assert.deepEqual(rules(check(withFiles({ [DRAFT]: workflow({ tools: ["read"] }) }), { tools })), ["harness_tool"]);
  assert.deepEqual(rules(check(withFiles({ [DRAFT]: workflow({ tools: ["fetch_page"] }) }), { tools: { harnesses: { mine: ["fetch_page"] } } })), ["harness_tool"]);
  assert.ok(defaultTools().harnesses.codex.includes("exec_command") && defaultTools().harnesses.pi.includes("bash"));
});

test("a workflow draft that does not parse, validate or match its folder is refused", () => {
  assert.deepEqual(rules(check(withFiles({ [DRAFT]: "{ not json" }))), ["workflow"]);
  assert.deepEqual(rules(check(withFiles({ [DRAFT]: "[]" }))), ["workflow"]);
  assert.deepEqual(rules(check(withFiles({ [DRAFT]: workflow({ node: "shell" }) }))), ["workflow"]);
  assert.deepEqual(rules(check(withFiles({ [DRAFT]: workflow({ name: "other" }) }))), ["workflow"]);
});

test("a workflow folder holds both its files, and a README that is not empty", () => {
  const files = cleanFiles();
  delete files["workflows/find-policies/README.md"];
  assert.deepEqual(rules(check(files)), ["workflow"]);
  assert.deepEqual(rules(check(withFiles({ "workflows/find-policies/README.md": "\n" }))), ["workflow"]);
  assert.deepEqual(check(withFiles({ "workflows/find-policies/README.md": readme })), []);
});

// ---------------------------------------------------------------- secrets

const SHAPED = {
  "AWS access key id": "AKIAABCDEFGHIJKLMNOP",
  "GitHub token": `ghp_${"a1B2".repeat(9)}`,
  "sk- key": `sk-ant-api03-${"Zx9".repeat(10)}`,
  "Slack token": "xoxb-1234567890-abcdefghij",
  "Google API key": `AIza${"B".repeat(35)}`,
  "private key block": ["-----BEGIN", "RSA PRIVATE KEY-----"].join(" "),
};

test("text shaped like a secret is refused in any file, by kind, and never printed", () => {
  for (const [kind, value] of Object.entries(SHAPED)) {
    for (const [path, text] of [[NOTE, note({ body: `Use the key ${value} for the store.` })], [SKILL, `${skill()}\n${value}\n`], ["workflows/find-policies/README.md", `${readme}\n${value}\n`]]) {
      const problems = check(withFiles({ [path]: text }));
      assert.deepEqual(rules(problems), ["secret_shape"], `${kind} in ${path}`);
      assert.equal(problems[0].path, path);
      assert.match(problems[0].detail, new RegExp(kind));
      assert.ok(!JSON.stringify(problems).includes(value), "the value is never printed");
    }
  }
});

test("a value the host names as secret is refused, plain or encoded, and never printed", () => {
  const value = "s3cret-store-pass-7731";
  for (const text of [value, Buffer.from(value).toString("base64"), value.split("").join("\n")]) {
    const problems = check(withFiles({ [NOTE]: note({ body: `The admin password is ${text} here.` }) }), { refuseValues: [value] });
    assert.deepEqual(rules(problems), ["secret_value"], text);
    assert.ok(!JSON.stringify(problems).includes(value));
  }
  assert.deepEqual(check(cleanFiles(), { refuseValues: [value] }), []);
});

test("checkRun is structural: it reports and never changes what it was given", () => {
  const changes = [{ path: NOTE, status: "added", bytes: Buffer.from(note({ body: "x".repeat(5000) })) }];
  const before = Buffer.from(changes[0].bytes);
  checkRun({ branch: BRANCH, changes, forkPoint: FORK });
  assert.deepEqual(changes[0].bytes, before);
});
