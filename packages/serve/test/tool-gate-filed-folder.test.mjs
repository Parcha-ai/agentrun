// The folder a tool's file setting files its answers in (filed-tool.ts) is kept from the agent's own file tools: the tool
// gate refuses a call of read, write or edit (pi's and the kernel's `path`, claude-agent's Read, Write and Edit
// `file_path`, a computer script's files ops held as read or write, a screenshot's save_as) whose path is at or under a
// folder the revision's own `mcp:<server>/<tool>` setting names, in that run, in words that name the setting. The check is
// lexical, against the run's folder by every name of it (this machine's path, the computer's /workspace, and each other
// name the run's file tools take, such as a CLI's scratch folder): `..` and `./`
// spellings that land inside are refused; a sibling, a folder whose name only starts the same, an ancestor, and a skill
// file (read_skill_file reads the agent's skill, not the run's files) are not. The path is held as given and as pi's file
// tools take it (one leading @ dropped), each segment folded as a disk that folds names takes it (Stripe/Pages), and
// web_save's and browser_upload's paths are held alike. No file is read, so a link is not followed.
// bash is not gated by path (no word check on shell text holds: a glob, cd, a variable or a link gets around one).
import assert from "node:assert/strict";
import { test } from "node:test";
import { runnerGate, verdictOf } from "./gate-support.mjs";

const RUN = "/nonexistent/run";
const KEY = "mcp:stripe/list_charges";
/** The agent's own settings: list_charges files its answers in stripe/pages. */
const FILED = { [KEY]: { file: { folder: "stripe/pages", show: ["has_more"] } } };
const ALLOW = { read: { permission: "allow" }, write: { permission: "allow" }, edit: { permission: "allow" }, bash: { permission: "allow" }, desktop: { permission: "allow" } };
const NOT_RUN = "It was not run: nothing was sent and nothing was charged.";
/** The refusal of `tool` at `given`. */
const refusal = (tool, given) => `${tool} can't be called: ${given} is in stripe/pages/, the folder this agent's setting for ${KEY} files that tool's answers in (its file setting), so the agent's own file tools are refused there. ${NOT_RUN}`;

const gateOn = (harness, overrides = FILED, names) => runnerGate({ settings: ALLOW, overrides, harness, root: RUN, tools: ["read", "write", "edit", "bash"], ...(names ? { names } : {}) });
/** A CLI's working folder on this machine: another name of the run's folder its file tools take (run-tools.ts aliases). */
const SCRATCH = "/nonexistent/scratch/agent/run";

test("read, write and edit (path) are refused at or under a filed folder, in words that name the setting; `..`, ./ and absolute spellings that land inside are refused", async () => {
  const gate = gateOn("pi");
  for (const given of ["stripe/pages/list_charges-1.json", "stripe/pages", "stripe/pages/", "./stripe/pages/a.json", "notes/../stripe/pages/a.json", "stripe/./pages/sub/a.json", `${RUN}/stripe/pages/a.json`, "/workspace/stripe/pages/a.json", "/workspace/notes/../stripe/pages"]) {
    assert.equal(await verdictOf(gate, "read", { path: given }), refusal("read", given), `read ${given}`);
  }
  assert.equal(await verdictOf(gate, "edit", { path: "stripe/pages/a.json", edits: [] }), refusal("edit", "stripe/pages/a.json"));
  assert.equal(await verdictOf(gate, "write", { path: "./stripe/pages/a.json", content: "x" }), refusal("write", "./stripe/pages/a.json"));
});

test("claude-agent's Read, Write and Edit (file_path) are refused alike", async () => {
  const gate = gateOn("claude-agent");
  assert.equal(await verdictOf(gate, "Read", { file_path: "/workspace/stripe/pages/a.json" }), refusal("read", "/workspace/stripe/pages/a.json"));
  assert.equal(await verdictOf(gate, "Edit", { file_path: "stripe/pages/a.json", old_string: "a", new_string: "b" }), refusal("edit", "stripe/pages/a.json"));
  assert.equal(await verdictOf(gate, "Write", { file_path: `${RUN}/stripe/pages/b.json`, content: "x" }), refusal("write", `${RUN}/stripe/pages/b.json`));
});

test("a computer script's files ops held as read or write, and a screenshot's save_as, are refused in the folder; a listing of an ancestor is not", async () => {
  const gate = gateOn("pi");
  assert.equal(await verdictOf(gate, "computer_op", { op: "files.read", args: { path: "stripe/pages/a.json" } }), refusal("read", "stripe/pages/a.json"));
  assert.equal(await verdictOf(gate, "computer_op", { op: "files.list", args: { path: "/workspace/stripe/pages" } }), refusal("read", "/workspace/stripe/pages"));
  assert.equal(await verdictOf(gate, "computer_op", { op: "files.list", args: { path: "stripe" } }), "allow", "an ancestor's listing names files, never their text");
  const shot = await verdictOf(gate, "computer_screenshot", { save_as: "stripe/pages/shot.png" });
  assert.ok(shot.startsWith(refusal("write", "stripe/pages/shot.png")), shot);
});

test("every name the run's file tools take for its folder is held: the folder by a CLI's scratch path is refused, a sibling by that path is not", async () => {
  const gate = gateOn("claude-agent", FILED, ["/workspace", SCRATCH]);
  for (const given of [`${SCRATCH}/stripe/pages/a.json`, `${SCRATCH}/stripe/pages`, `${SCRATCH}/notes/../stripe/pages/b.json`]) {
    assert.equal(await verdictOf(gate, "read", { path: given }), refusal("read", given), `read ${given}`);
    assert.equal(await verdictOf(gate, "Read", { file_path: given }), refusal("read", given), `Read ${given}`);
  }
  assert.equal(await verdictOf(gate, "Write", { file_path: `${SCRATCH}/stripe/pages/c.json`, content: "x" }), refusal("write", `${SCRATCH}/stripe/pages/c.json`));
  for (const given of [`${SCRATCH}/stripe/other.json`, `${SCRATCH}/stripe/pages-old/a.json`, `${SCRATCH}/notes.md`]) {
    assert.equal(await verdictOf(gate, "read", { path: given }), "allow", `read ${given}`);
  }
  assert.equal(await verdictOf(gate, "read", { path: "stripe/pages/a.json" }), refusal("read", "stripe/pages/a.json"), "the run's own names still hold");
});

test("a sibling, a folder whose name only starts the same, an ancestor, the rest of the run's files, a path outside the run's folder and a skill file are not refused", async () => {
  const gate = gateOn("pi");
  for (const given of ["stripe/other.json", "stripe/pages-old/a.json", "stripe/pagesX", "stripe", ".", "notes.md", "stripe/pages/../summary.json", "/tmp/stripe/pages/a.json", `${RUN}/stripe/notes.md`]) {
    assert.equal(await verdictOf(gate, "read", { path: given }), "allow", `read ${given}`);
  }
  assert.equal(await verdictOf(gate, "read_skill_file", { path: "stripe/pages/SKILL.md" }), "allow", "a skill file is the agent's, not the run's files");
});

test("with no file setting, or one on the server's settings alone, nothing is refused for a folder; bash is not gated by path", async () => {
  const plain = gateOn("pi", {});
  assert.equal(await verdictOf(plain, "read", { path: "stripe/pages/a.json" }), "allow");
  const serverOnly = runnerGate({ settings: { ...ALLOW, [KEY]: { permission: "allow" } }, overrides: {}, harness: "pi", root: RUN });
  assert.equal(await verdictOf(serverOnly, "read", { path: "stripe/pages/a.json" }), "allow");
  assert.equal(await verdictOf(gateOn("pi"), "bash", { command: "cat stripe/pages/a.json" }), "allow", "bash is held to its permission alone");
});

test("two filed tools: each folder is refused, and the words name the setting whose folder it is", async () => {
  const gate = gateOn("pi", { ...FILED, "mcp:stripe/list_customers": { file: { folder: "customers", show: [] } } });
  assert.equal(await verdictOf(gate, "read", { path: "customers/a.json" }), `read can't be called: customers/a.json is in customers/, the folder this agent's setting for mcp:stripe/list_customers files that tool's answers in (its file setting), so the agent's own file tools are refused there. ${NOT_RUN}`);
  assert.equal(await verdictOf(gate, "read", { path: "stripe/pages/a.json" }), refusal("read", "stripe/pages/a.json"));
});

test("a path with one leading @ is the path the file tools open (pi's read, write and edit strip it): @ spellings in the folder are refused, by every name of it, for read, write and edit and claude-agent's Read, Write and Edit", async () => {
  const gate = gateOn("pi", FILED, ["/workspace", SCRATCH]);
  const inside = ["@stripe/pages/a.json", "@/workspace/stripe/pages/a.json", `@${RUN}/stripe/pages/a.json`, `@${SCRATCH}/stripe/pages/a.json`, "@./stripe/pages/a.json", "@notes/../stripe/pages/a.json", "@stripe/pages", "@/../stripe/pages/a.json"];
  for (const given of inside) {
    assert.equal(await verdictOf(gate, "read", { path: given }), refusal("read", given), `read ${given}`);
    assert.equal(await verdictOf(gate, "write", { path: given, content: "x" }), refusal("write", given), `write ${given}`);
    assert.equal(await verdictOf(gate, "edit", { path: given, edits: [] }), refusal("edit", given), `edit ${given}`);
  }
  const claude = gateOn("claude-agent", FILED, ["/workspace", SCRATCH]);
  for (const given of ["@stripe/pages/a.json", "@/workspace/stripe/pages/a.json", `@${SCRATCH}/stripe/pages/a.json`]) {
    assert.equal(await verdictOf(claude, "Read", { file_path: given }), refusal("read", given), `Read ${given}`);
    assert.equal(await verdictOf(claude, "Write", { file_path: given, content: "x" }), refusal("write", given), `Write ${given}`);
    assert.equal(await verdictOf(claude, "Edit", { file_path: given, old_string: "a", new_string: "b" }), refusal("edit", given), `Edit ${given}`);
  }
  for (const given of ["@notes/a.json", "@stripe/other.json", "@stripe/pages-old/a.json", "@stripe", "@/tmp/stripe/pages/a.json", "@@stripe/pages/a.json"]) {
    assert.equal(await verdictOf(gate, "read", { path: given }), "allow", `read ${given}`);
  }
});

test("the folder in another spelling a disk that folds names opens as the same folder (case, fullwidth, a compatibility letter, a default-ignorable code point) is refused; a sibling in any case is not", async () => {
  const gate = gateOn("pi", FILED, ["/workspace", SCRATCH]);
  const inside = ["Stripe/pages/a.json", "stripe/Pages/a.json", "STRIPE/PAGES", "stripe/ＰＡＧＥＳ/a.json", "ſtripe/pages/a.json", "/workspace/Stripe/Pages/a.json", `${SCRATCH}/STRIPE/pages/a.json`, "@Stripe/Pages/a.json", "stri\u200Bpe/pages/a.json", "stripe/pa\u00ADges/a.json", "stripe/pages\u2060/a.json", "\uFEFFStripe/pages"];
  for (const given of inside) {
    assert.equal(await verdictOf(gate, "read", { path: given }), refusal("read", given), `read ${given}`);
    assert.equal(await verdictOf(gate, "write", { path: given, content: "x" }), refusal("write", given), `write ${given}`);
  }
  const claude = gateOn("claude-agent");
  assert.equal(await verdictOf(claude, "Edit", { file_path: "Stripe/PAGES/a.json", old_string: "a", new_string: "b" }), refusal("edit", "Stripe/PAGES/a.json"));
  // A folder with a k: the Kelvin sign (U+212A) folds to it.
  const kyc = gateOn("pi", { "mcp:verify/list_checks": { file: { folder: "kyc", show: [] } } });
  for (const given of ["Kyc/a.json", "KYC/a.json", "Kyc"]) {
    assert.equal(await verdictOf(kyc, "read", { path: given }), `read can't be called: ${given} is in kyc/, the folder this agent's setting for mcp:verify/list_checks files that tool's answers in (its file setting), so the agent's own file tools are refused there. ${NOT_RUN}`, `read ${given}`);
  }
  for (const given of ["Stripe/pages-old/a.json", "STRIPE/other.json", "Stripe-old/a.json", "stripe-old/a.json", "Stripe", "KYC-old/a.json"]) {
    assert.equal(await verdictOf(gate, "read", { path: given }), "allow", `read ${given}`);
  }
});

/** A gate whose agent is also given web_save and the browser, each allowed. */
const hostGate = (overrides = FILED) => runnerGate({ settings: { ...ALLOW, web_save: { permission: "allow" }, browser: { permission: "allow" } }, overrides, harness: "pi", root: RUN, tools: ["read", "write", "edit", "bash", "web_save", "browser"] });

test("web_save's path is where it writes a file in the run's files: in the folder (a bare name under media/ when the folder is media) it is refused; a sibling is not", async () => {
  const gate = hostGate();
  for (const given of ["stripe/pages/x.json", "Stripe/Pages/x.json", "./stripe/pages/x.json"]) {
    assert.equal(await verdictOf(gate, "web_save", { url: "https://example.com/x.json", path: given }), refusal("web_save", given), `web_save ${given}`);
  }
  for (const given of ["stripe/x.json", "stripe-old/x.json", "notes/x.png", "x.png"]) {
    assert.equal(await verdictOf(gate, "web_save", { url: "https://example.com/x", path: given }), "allow", `web_save ${given}`);
  }
  const media = hostGate({ "mcp:files/list": { file: { folder: "media", show: [] } } });
  assert.equal(await verdictOf(media, "web_save", { url: "https://example.com/x.png", path: "x.png" }), `web_save can't be called: media/x.png is in media/, the folder this agent's setting for mcp:files/list files that tool's answers in (its file setting), so the agent's own file tools are refused there. ${NOT_RUN}`);
  assert.equal(await verdictOf(media, "web_save", { url: "https://example.com/x.png", path: "pictures/x.png" }), "allow");
});

test("browser_upload's path is a run file it reads into a page: in the folder it is refused; a sibling is not", async () => {
  const gate = hostGate();
  for (const given of ["stripe/pages/a.json", "STRIPE/pages/a.json"]) {
    assert.equal(await verdictOf(gate, "browser_upload", { path: given, selector: "input[type=file]" }), refusal("browser_upload", given), `browser_upload ${given}`);
  }
  assert.equal(await verdictOf(gate, "browser_upload", { path: "reports/q3.pdf", selector: "input[type=file]" }), "allow");
});

test("the gate's spelling of a path is pi's own: piToolPath answers what pi's read, write and edit resolve (pi-durable's resolveToolPath), so a pi upgrade that changes it fails here", async () => {
  const { piToolPath } = await import("../dist/workspace/paths.js");
  // pi's path-utils is not among its package's exports: loaded by its file, beside the tools module the exports name.
  const { resolveToolPath } = await import(new URL("./path-utils.js", import.meta.resolve("@earendil-works/pi-durable/tools")).href);
  const env = { absolutePath: async (path) => ({ ok: true, value: path }) };
  const spaces = [" ", ...Array.from({ length: 11 }, (_, i) => String.fromCharCode(0x2000 + i)), " ", " ", "　"];
  const cases = ["stripe/pages/a.json", "@stripe/pages/a.json", "@@stripe/pages/a.json", "@/workspace/stripe/a.json", " @stripe/a.json", " @stripe/a.json", "@ stripe/a.json", "stripe/ pages/a.json", "@", "", "~/a.json", "​stripe/a.json", "＠stripe/a.json", ...spaces.map((space) => `stripe${space}pages/a.json`), ...spaces.map((space) => `${space}@a.json`)];
  for (const given of cases) assert.equal(piToolPath(given), await resolveToolPath(env, given, {}), JSON.stringify(given));
  assert.equal(piToolPath("@stripe/pages/a.json"), "stripe/pages/a.json");
  assert.equal(piToolPath("stripe　pages/a.json"), "stripe pages/a.json");
});

// A computer that mounts the run's folder holds the filed folder too, under /workspace, and its kernel reaches a file by
// names no lexical check can follow: a proc or fd link, or any link the computer already holds. So while a folder is filed,
// a script's file op there must name a path inside /workspace (or another name of the run's folder): anything else is
// refused, whatever it names.
/** The refusal of a script's `op` at `given` outside /workspace, in a run whose list_charges files in stripe/pages. */
const outside = (op, given) => `computer_op ${op} can't be called: ${given} is outside /workspace, and while this agent's setting for ${KEY} files that tool's answers in stripe/pages/ (its file setting), a script's file ops are kept in /workspace, the run's folder on the computer. ${NOT_RUN}`;
const OPS = { "files.read": {}, "files.list": {}, "files.write": { data: "x" }, "files.stat": {} };
/** A run's gate on a computer that mounts its folder (`computer: true`) or one that does not (`false`). */
const mountedGate = (computer, overrides = FILED, names) => runnerGate({ settings: ALLOW, overrides, harness: "pi", root: RUN, tools: ["read", "write", "edit", "bash"], computer, ...(names ? { names } : {}) });
const LINKS = ["/proc/self/root/workspace/stripe/pages/x", "/proc/self/cwd/stripe/pages/x", "/dev/fd/3/stripe/pages/x", "/proc/1/root/workspace/stripe/pages/x"];
const DOWNLOADS = "/home/agentrun-tool/Downloads/x";

test("on a computer that mounts the run's folder, while a folder is filed, a script's file op outside /workspace is refused in words: a proc or fd link to the folder, and any other path", async () => {
  const gate = mountedGate(true);
  for (const [op, extra] of Object.entries(OPS)) {
    for (const given of [...LINKS, DOWNLOADS, "/", "/workspace-old/x", "~/x", "file:///workspace/x"]) {
      assert.equal(await verdictOf(gate, "computer_op", { op, args: { path: given, ...extra } }), outside(op, given), `${op} ${given}`);
    }
  }
});

test("on that computer, a path inside /workspace or another name of the run's folder still runs, and the filed folder itself is refused as before", async () => {
  const gate = mountedGate(true, FILED, ["/workspace", SCRATCH]);
  for (const [op, extra] of Object.entries(OPS)) {
    for (const given of ["/workspace/other/x", "/workspace", "notes/a.json", "/workspace/stripe/x", `${SCRATCH}/notes/a.json`]) {
      assert.equal(await verdictOf(gate, "computer_op", { op, args: { path: given, ...extra } }), "allow", `${op} ${given}`);
    }
  }
  assert.equal(await verdictOf(gate, "computer_op", { op: "files.read", args: { path: "/workspace/stripe/pages/a.json" } }), refusal("read", "/workspace/stripe/pages/a.json"));
  assert.equal(await verdictOf(gate, "computer_op", { op: "files.write", args: { path: "/workspace/notes/../stripe/pages/a.json", data: "x" } }), refusal("write", "/workspace/notes/../stripe/pages/a.json"));
});

test("with no folder filed, or on a computer that does not mount the run's folder, a script's file op outside /workspace runs as before", async () => {
  for (const [label, gate] of [["mounted, nothing filed", mountedGate(true, {})], ["not mounted, filed", mountedGate(false)], ["shell unknown, filed", gateOn("pi")]]) {
    for (const [op, extra] of Object.entries(OPS)) {
      for (const given of [DOWNLOADS, ...LINKS]) {
        assert.equal(await verdictOf(gate, "computer_op", { op, args: { path: given, ...extra } }), "allow", `${label}: ${op} ${given}`);
      }
    }
  }
  // A script's shell is not a file op: on the mounted computer with a folder filed, its command runs as bash's setting says.
  assert.equal(await verdictOf(mountedGate(true), "computer_op", { op: "shell.run", args: { command: "cat /proc/self/cwd/stripe/pages/x" } }), "allow");
});
