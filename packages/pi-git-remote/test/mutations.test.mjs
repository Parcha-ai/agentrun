// Each safety mechanism is load-bearing: remove it from a copy of dist/ and the named test in a copy of test/ fails.
// A control run of the unchanged copy passes the same tests, so the failure is the mutation's.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { rawGit, scratch } from "./support.mjs";

const PACKAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const MUTATIONS = [
  {
    removes: "core.hooksPath=/dev/null from the flags on every call",
    file: "dist/git.js", from: '"-c", "core.hooksPath=/dev/null",', to: "",
    fails: ["safety.test.mjs", "hooks planted in the host repository never fire through fetch, checkout, commitTo, merge, revert and push"],
  },
  {
    removes: "the receive-pack override on a push to a local remote",
    file: "dist/repo.js", from: 'packArgs("receive")', to: "[]",
    fails: ["safety.test.mjs", "hooks planted in a local remote never fire on push or fetch"],
  },
  {
    removes: "--no-filters from hash-object",
    file: "dist/repo.js", from: '"--no-filters", ', to: "",
    fails: ["safety.test.mjs", "a planted info/attributes cannot change the bytes commitTo stores or run a clean filter"],
  },
  {
    removes: "the refusal of a remote URL with userinfo",
    file: "dist/remotes.js", from: 'parsed.username !== "" || parsed.password !== ""', to: "false",
    fails: ["credential.test.mjs", "openRepo refuses a remote URL with userinfo and never repeats it"],
  },
  {
    removes: "the Run-Id trailer lookup in commitTo",
    file: "dist/repo.js", from: "const existing = await findTrailer(branch, RUN_ID_TRAILER, runId);", to: "const existing = undefined;",
    fails: ["repo.test.mjs", "commitTo is idempotent by Run-Id after a restart: a fresh host with an empty local repo finds the commit on the remote and commits nothing"],
  },
  {
    removes: "the attr.tree pin to the empty tree",
    file: "dist/git.js", from: '"-c", `attr.tree=${EMPTY_TREE}`,', to: "",
    fails: ["safety.test.mjs", "a .gitattributes in the remote's tree changes nothing: bytes stay as stored and a conflict stays a conflict"],
    unlessGit: async () => ((await bareReadsHeadAttributes()) ? undefined : "does not read HEAD's .gitattributes in a bare repository, so the pin has nothing to defend on it"),
  },
  {
    removes: "the reset of credential helpers before the fd-3 helper",
    file: "dist/git.js", from: '"-c", "credential.helper=",', to: "",
    fails: ["credential.test.mjs", "real git reads the credential through the fd-3 helper, and never runs a helper from the repository's config"],
  },
  {
    removes: "the refusal of a symlink the allowlist reaches",
    file: "dist/session.js", from: 'if (reaches(p))', to: "if (false)",
    fails: ["session.test.mjs", "a symlink the allowlist reaches refuses the whole end, and nothing is pushed"],
  },
  {
    removes: "the allowlist's match on a file",
    file: "dist/session.js", from: "else if (allow.matches(p)) {", to: "else if (true) {",
    fails: ["session.test.mjs", "a change that no pattern names is never committed"],
  },
  {
    removes: "the check that an existing session branch carries this session's trailer",
    file: "dist/session.js", from: "if (mine.length === 0)", to: "if (false)",
    fails: ["session.test.mjs", "a branch of the session's name that carries no Session-Id trailer is never added to"],
  },
  {
    removes: "the refusal of main, master and HEAD as a session branch",
    file: "dist/session.js", from: "PROTECTED.has(bare) ||", to: "false ||",
    fails: ["session.test.mjs", "the session branch holds the id exactly once and is never a protected name or the seed's own branch"],
  },
  {
    removes: "building a later end on the session branch's own tip",
    file: "dist/session.js", from: "parent: tip ?? seededAt.sha,", to: "parent: seededAt.sha,",
    fails: ["session.test.mjs", "a second end for the same session commits nothing"],
  },
  {
    removes: "the seed record's list of the files the checkout copied",
    file: "dist/session.js", from: "for (const p of seededAt.files)", to: "for (const p of entries.keys())",
    fails: ["session.test.mjs", "a seeded entry the checkout skipped is not seen as a deletion"],
  },
];

/** Whether this git, with no attr.tree, reads HEAD's .gitattributes in a bare repository: a union merge it names then
 *  hides a conflict. */
async function bareReadsHeadAttributes() {
  const gitDir = path.join(await scratch(), "probe.git");
  await rawGit(["init", "-q", "--bare", "--template=", "-b", "main", gitDir]);
  const blob = async (text) => (await rawGit(["hash-object", "-w", "--stdin"], { gitDir, input: text })).toString().trim();
  const tree = async (notes) => (await rawGit(["mktree"], { gitDir, input: `100644 blob ${await blob("* merge=union\n")}\t.gitattributes\n100644 blob ${await blob(notes)}\tnotes\n` })).toString().trim();
  const commit = async (notes, parent) => (await rawGit(["commit-tree", await tree(notes), ...(parent ? ["-p", parent] : []), "-m", "probe"], { gitDir })).toString().trim();
  const base = await commit("a\nb\nc\n");
  const ours = await commit("a\nours\nc\n", base);
  const theirs = await commit("a\ntheirs\nc\n", base);
  await rawGit(["update-ref", "refs/heads/main", ours], { gitDir });
  return rawGit(["merge-tree", "--write-tree", ours, theirs], { gitDir }).then(() => true, () => false);
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function copyPackage() {
  const dir = await scratch();
  await cp(path.join(PACKAGE, "dist"), path.join(dir, "dist"), { recursive: true });
  await cp(path.join(PACKAGE, "test"), path.join(dir, "test"), { recursive: true });
  return dir;
}

/** Runs the named tests of one file in `dir`; resolves with the exit code and the TAP output. */
function runTests(dir, file, titles) {
  return new Promise((resolve, reject) => {
    const args = ["--test", "--test-reporter=tap", "--test-concurrency=1", ...titles.map((t) => `--test-name-pattern=^${escape(t)}$`), path.join(dir, "test", file)];
    const { NODE_TEST_CONTEXT, ...env } = process.env;
    const child = spawn(process.execPath, args, { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
    const out = [];
    child.stdout.on("data", (c) => out.push(c));
    child.stderr.on("data", (c) => out.push(c));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out: Buffer.concat(out).toString("utf8") }));
  });
}

const verdict = (out, title) => (new RegExp(`^not ok \\d+ - ${escape(title)}$`, "m").test(out) ? "fail" : new RegExp(`^ok \\d+ - ${escape(title)}$`, "m").test(out) ? "pass" : "absent");

test("control: an unchanged copy of the package passes every test a mutation must fail", async () => {
  const dir = await copyPackage();
  const byFile = Map.groupBy(MUTATIONS, (m) => m.fails[0]);
  for (const [file, mutations] of byFile) {
    const titles = mutations.map((m) => m.fails[1]);
    const { code, out } = await runTests(dir, file, titles);
    assert.equal(code, 0, out.slice(-3000));
    for (const title of titles) assert.equal(verdict(out, title), "pass", title);
  }
});

for (const mutation of MUTATIONS) {
  test(`mutation: without ${mutation.removes}, "${mutation.fails[1]}" fails`, async (t) => {
    const unless = await mutation.unlessGit?.();
    if (unless) {
      t.skip(`${(await rawGit(["version"])).toString().trim()} ${unless}`);
      return;
    }
    const dir = await copyPackage();
    const file = path.join(dir, mutation.file);
    const source = await readFile(file, "utf8");
    assert.equal(source.split(mutation.from).length, 2, `${mutation.file} holds the mutated text exactly once`);
    await writeFile(file, source.replace(mutation.from, mutation.to));
    const { code, out } = await runTests(dir, mutation.fails[0], [mutation.fails[1]]);
    assert.notEqual(code, 0, out.slice(-2000));
    assert.equal(verdict(out, mutation.fails[1]), "fail", out.slice(-2000));
  });
}
