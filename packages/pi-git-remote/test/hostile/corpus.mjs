// Hostile-repo corpus for @parcha/pi-git-remote. Each case's build(dir) writes one hostile setup under dir with
// plain git (no safety flags) and returns the paths a runner is given, `marker` (the file a successful attack would
// create) and `globalConfig` (the operator-level config plain git should read for that case). build() never runs
// anything it plants. Expectations: "no-marker" (nothing planted may run), "refused" (the runner must refuse to check
// out or build on the entry), "limit" (documented: it runs when .git itself is writable).
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const IDENT = { GIT_AUTHOR_NAME: "corpus", GIT_AUTHOR_EMAIL: "corpus@corpus.invalid", GIT_COMMITTER_NAME: "corpus", GIT_COMMITTER_EMAIL: "corpus@corpus.invalid" };
const DIR_MODE = "40000";
const STD_FILES = { "README.md": "# Hostile fixture\n", "notes.txt": "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\n" };

/** Plain git environment: no system config, one operator-level global config file, no prompts, no hook hardening. */
export function envFor(globalConfig) {
  return { PATH: process.env.PATH, HOME: path.dirname(globalConfig), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: globalConfig, GIT_TERMINAL_PROMPT: "0", ...IDENT };
}

export async function setup(root, { globalConfig = "" } = {}) {
  await mkdir(root, { recursive: true });
  const global = path.join(root, "operator.gitconfig");
  await writeFile(global, globalConfig);
  return { env: envFor(global), globalConfig: global };
}

/** Runs git with the given env; resolves stdout, rejects with stderr on a non-zero exit. */
export function run(env, args, { cwd, gitDir, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, env: gitDir ? { ...env, GIT_DIR: gitDir } : env, stdio: ["pipe", "pipe", "pipe"] });
    const out = [];
    const err = [];
    child.stdout.on("data", (c) => out.push(c));
    child.stderr.on("data", (c) => err.push(c));
    child.stdin.on("error", () => {}); // git may exit before it reads stdin; the exit code is the result
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`git ${args.join(" ")} exited ${code}: ${Buffer.concat(err)}`))));
    child.stdin.end(input ?? "");
  });
}

export const blob = async (env, gitDir, content) => (await run(env, ["hash-object", "-w", "--stdin"], { gitDir, input: content })).toString().trim();

/** Streams `bytes` of blob content into hash-object -w: the object is written once, with no temp file on disk. */
export function streamBlob(env, gitDir, head, bytes) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["hash-object", "-w", "--stdin"], { env: { ...env, GIT_DIR: gitDir }, stdio: ["pipe", "pipe", "pipe"] });
    const out = [];
    const err = [];
    child.stdout.on("data", (c) => out.push(c));
    child.stderr.on("data", (c) => err.push(c));
    child.stdin.on("error", () => {});
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(Buffer.concat(out).toString().trim()) : reject(new Error(`hash-object: ${Buffer.concat(err)}`))));
    (async () => {
      child.stdin.write(head);
      const chunk = Buffer.alloc(1 << 20, 0x23); // '#' lines, 1023 bytes each, so the file stays a readable shell script
      for (let i = 1023; i < chunk.length; i += 1024) chunk[i] = 0x0a;
      let left = bytes - Buffer.byteLength(head);
      while (left > 0) {
        const n = Math.min(left, chunk.length);
        const ok = child.stdin.write(n === chunk.length ? chunk : chunk.subarray(0, n));
        left -= n;
        if (!ok) await once(child.stdin, "drain");
      }
      child.stdin.end();
    })().catch(reject);
  });
}

const sortKey = (e) => Buffer.from(e.mode === DIR_MODE ? `${e.name}/` : e.name);

/** A raw tree object, built from entries with hash-object --literally so each name is stored as given. treeOf splits nested paths; mktree would refuse a slash inside a name. */
export async function rawTree(env, gitDir, entries) {
  const sorted = [...entries].sort((a, b) => Buffer.compare(sortKey(a), sortKey(b)));
  const body = Buffer.concat(sorted.map((e) => Buffer.concat([Buffer.from(`${e.mode} ${e.name}\0`), Buffer.from(e.sha, "hex")])));
  return (await run(env, ["hash-object", "-t", "tree", "--literally", "-w", "--stdin"], { gitDir, input: body })).toString().trim();
}

/** Nested trees from flat entries [{ path, mode, sha }]. Each path is split on "/", so every component is one tree name. */
export async function treeOf(env, gitDir, files) {
  const write = async (items) => {
    const direct = [];
    const dirs = new Map();
    for (const it of items) {
      if (it.parts.length === 1) direct.push({ mode: it.mode, name: it.parts[0], sha: it.sha });
      else {
        const [head, ...rest] = it.parts;
        if (!dirs.has(head)) dirs.set(head, []);
        dirs.get(head).push({ ...it, parts: rest });
      }
    }
    for (const [name, sub] of dirs) direct.push({ mode: DIR_MODE, name, sha: await write(sub) });
    return rawTree(env, gitDir, direct);
  };
  return write(files.map((f) => ({ parts: f.path.split("/"), mode: f.mode, sha: f.sha })));
}

export async function commit(env, gitDir, tree, message, parents = []) {
  const args = ["commit-tree", tree, "-m", message];
  for (const p of parents) args.push("-p", p);
  return (await run(env, args, { gitDir })).toString().trim();
}

/** Entries for plain files: { "a/b.txt": "text" } becomes [{ path, mode, sha }]. */
export async function fileEntries(env, gitDir, files, mode = "100644") {
  const out = [];
  for (const [p, text] of Object.entries(files)) out.push({ path: p, mode, sha: await blob(env, gitDir, text) });
  return out;
}

/** Creates a bare repo whose main holds `files` plus whatever `extra(env, bare)` returns. Refs are set before any hook is planted. */
export async function seedBare(env, bare, { files = {}, extra, message = "seed" } = {}) {
  await run(env, ["init", "-q", "--bare", "--template=", "-b", "main", bare]);
  const entries = [...(await fileEntries(env, bare, files)), ...(extra ? await extra(env, bare) : [])];
  const tree = await treeOf(env, bare, entries);
  const sha = await commit(env, bare, tree, message);
  await run(env, ["update-ref", "refs/heads/main", sha], { gitDir: bare });
  return sha;
}

/** An executable hook (or any script) that touches the marker when git runs it. */
export async function plantHook(file, marker, body = "") {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `#!/bin/sh\ntouch '${marker}'\n${body}`);
  await chmod(file, 0o755);
}

/** Bare remote with main = STD_FILES, a clone, and a local-only side branch with one extra commit. Hooks are not planted yet. */
export async function hostBase(env, dir) {
  const bare = path.join(dir, "remote.git");
  const workdir = path.join(dir, "host");
  await seedBare(env, bare, { files: STD_FILES });
  await run(env, ["clone", "-q", "--template=", bare, workdir]);
  await run(env, ["checkout", "-q", "-b", "side"], { cwd: workdir });
  await writeFile(path.join(workdir, "side.txt"), "side\n");
  await run(env, ["add", "side.txt"], { cwd: workdir });
  await run(env, ["commit", "-q", "-m", "side"], { cwd: workdir });
  await run(env, ["checkout", "-q", "main"], { cwd: workdir });
  return { bare, workdir };
}

// Hooks. Host hooks live in the clone's .git/hooks (a hostile checkout); remote hooks live in the bare repo's hooks/
// and run on push into it. The runner defends both with hooksPath overrides and a push-side receive-pack override.
// Plain git runs each one; the control test shows it.
export const HOST_HOOKS = ["post-checkout", "post-commit", "post-merge", "reference-transaction", "pre-push", "pre-commit"];
export const REMOTE_HOOKS = ["pre-receive", "update", "post-receive", "post-update", "reference-transaction"];

const hostHookCases = HOST_HOOKS.map((name) => ({
  id: `host-hook-${name}`,
  describe: `.git/hooks/${name} planted in the host clone, which is the hostile repo's own checkout.`,
  expect: "no-marker",
  async build(dir) {
    const { env, globalConfig } = await setup(dir);
    const { bare, workdir } = await hostBase(env, dir);
    const marker = path.join(dir, `marker-${name}`);
    await plantHook(path.join(workdir, ".git", "hooks", name), marker);
    return { bare, workdir, marker, globalConfig };
  },
}));

const remoteHookCases = REMOTE_HOOKS.map((name) => ({
  id: `remote-hook-${name}`,
  describe: `hooks/${name} in the bare remote; it runs when a push lands on that remote.`,
  expect: "no-marker",
  async build(dir) {
    const { env, globalConfig } = await setup(dir);
    const bare = path.join(dir, "remote.git");
    await seedBare(env, bare, { files: STD_FILES });
    const workdir = path.join(dir, "host");
    await run(env, ["clone", "-q", "--template=", bare, workdir]);
    const marker = path.join(dir, `marker-${name}`);
    await plantHook(path.join(bare, "hooks", name), marker);
    return { bare, workdir, marker, globalConfig };
  },
}));

// Attributes and config-named blobs. The tree can name a filter or merge driver, but the command behind the name lives in
// the operator's global config (think filter=lfs on a host that has git-lfs). The tree must not pick the command.
const attributeCases = [
  {
    id: "attr-filter-operator-driver",
    describe: "Tree .gitattributes says filter=evil; the clean command for evil is in the operator's global config.",
    expect: "no-marker",
    async build(dir) {
      const marker = path.join(dir, "marker");
      const { env, globalConfig } = await setup(dir, { globalConfig: `[filter "evil"]\n\tclean = touch '${marker}'; cat\n\tsmudge = cat\n` });
      const bare = path.join(dir, "remote.git");
      await seedBare(env, bare, { files: { ".gitattributes": "* filter=evil\n", "notes.txt": STD_FILES["notes.txt"] } });
      const workdir = path.join(dir, "host");
      await run(env, ["clone", "-q", "--template=", bare, workdir]);
      return { bare, workdir, marker, globalConfig };
    },
  },
  {
    id: "attr-merge-operator-driver",
    describe: "Tree .gitattributes says merge=evil; the merge driver is in the operator's global config. main and side both edit notes.txt.",
    expect: "no-marker",
    async build(dir) {
      const marker = path.join(dir, "marker");
      const { env, globalConfig } = await setup(dir, { globalConfig: `[merge "evil"]\n\tdriver = touch '${marker}'; false\n` });
      const bare = path.join(dir, "remote.git");
      await seedBare(env, bare, { files: { ".gitattributes": "* merge=evil\n", "notes.txt": STD_FILES["notes.txt"] } });
      const workdir = path.join(dir, "host");
      await run(env, ["clone", "-q", "--template=", bare, workdir]);
      const edit = async (from, to) => {
        const file = path.join(workdir, "notes.txt");
        await writeFile(file, (await readFile(file, "utf8")).replace(from, to));
        await run(env, ["add", "notes.txt"], { cwd: workdir });
        await run(env, ["commit", "-q", "-m", `edit ${to}`], { cwd: workdir });
      };
      await run(env, ["checkout", "-q", "-b", "side"], { cwd: workdir });
      await edit("line 1", "line 1 (side)");
      await run(env, ["checkout", "-q", "main"], { cwd: workdir });
      await edit("line 6", "line 6 (main)");
      await run(env, ["push", "-q", "origin", "main", "side"], { cwd: workdir });
      return { bare, workdir, marker, globalConfig };
    },
  },
  {
    id: "gitconfig-blob-bait",
    describe: "A committed .gitconfig with fsmonitor and an alias that touch the marker. Git never reads a tree's .gitconfig, so it is only bait.",
    expect: "no-marker",
    async build(dir) {
      const marker = path.join(dir, "marker");
      const { env, globalConfig } = await setup(dir);
      const bare = path.join(dir, "remote.git");
      const files = { ...STD_FILES, ".gitconfig": `[core]\n\tfsmonitor = touch '${marker}'\n[alias]\n\tst = !touch '${marker}'\n` };
      await seedBare(env, bare, { files });
      return { bare, marker, globalConfig };
    },
  },
];

// Symlink entries (mode 120000) that point outside the checkout. A checkout accepts them; a writer that follows one escapes.
// The marker is the file a write through the link would create.
const symlinkCases = [
  {
    id: "symlink-absolute-outside",
    describe: "Entry escape (mode 120000) points at an absolute directory outside the checkout; a write through it lands there.",
    expect: "refused",
    async build(dir) {
      const { env, globalConfig } = await setup(dir);
      const outside = path.join(dir, "outside");
      await mkdir(outside, { recursive: true });
      const bare = path.join(dir, "remote.git");
      await seedBare(env, bare, { files: STD_FILES, extra: async (e, b) => [{ path: "escape", mode: "120000", sha: await blob(e, b, outside) }] });
      return { bare, marker: path.join(outside, "planted"), globalConfig };
    },
  },
  {
    id: "symlink-relative-escape",
    describe: "Entry up (mode 120000) is a relative link, ../outside, that leaves the checkout directory; a write through it lands in the outside directory.",
    expect: "refused",
    async build(dir) {
      const { env, globalConfig } = await setup(dir);
      const outside = path.join(dir, "outside");
      await mkdir(outside, { recursive: true });
      const bare = path.join(dir, "remote.git");
      await seedBare(env, bare, { files: STD_FILES, extra: async (e, b) => [{ path: "up", mode: "120000", sha: await blob(e, b, "../outside") }] });
      return { bare, marker: path.join(outside, "planted"), globalConfig };
    },
  },
];

// Submodule gitlinks (mode 160000). The .gitmodules URL is an ext:: helper, which runs a command, or a file:// repo whose
// config sets uploadpack.packObjectsHook, which runs one when the repo is fetched. Plain git refuses both by default.
async function superproject(env, bare, { gitlink, parent, url }) {
  const gitmodules = `[submodule "evil"]\n\tpath = evil\n\turl = ${url}\n`;
  const entries = [...(await fileEntries(env, bare, { ...STD_FILES, ".gitmodules": gitmodules })), { path: "evil", mode: "160000", sha: gitlink }];
  const sha = await commit(env, bare, await treeOf(env, bare, entries), "gitlink", [parent]);
  await run(env, ["update-ref", "refs/heads/main", sha], { gitDir: bare });
  return sha;
}

const submoduleCases = [
  {
    id: "submodule-ext-url",
    describe: "Gitlink at evil; .gitmodules url is ext::sh -c touch% <marker>, the transport helper form that runs a command.",
    expect: "refused",
    async build(dir) {
      const { env, globalConfig } = await setup(dir);
      const marker = path.join(dir, "marker");
      const bare = path.join(dir, "remote.git");
      const base = await seedBare(env, bare, { files: STD_FILES });
      await superproject(env, bare, { gitlink: base, parent: base, url: `ext::sh -c touch% ${marker}` });
      const workdir = path.join(dir, "host");
      await run(env, ["clone", "-q", "--template=", bare, workdir]);
      return { bare, workdir, marker, globalConfig };
    },
  },
  {
    id: "submodule-file-url",
    describe: "Gitlink at evil; .gitmodules url is file:// to a local repository on this host. A checkout that follows it copies that repository's files out, so the marker is the file it pulls in. (uploadpack.packObjectsHook is not read by git 2.43 upload-pack, so it is not used here.)",
    expect: "refused",
    async build(dir) {
      const { env, globalConfig } = await setup(dir);
      const workdir = path.join(dir, "host");
      const subBare = path.join(dir, "local-only.git");
      const subCommit = await seedBare(env, subBare, { files: { "local-only.txt": "a file from a local repository the tree names\n" } });
      const bare = path.join(dir, "remote.git");
      const base = await seedBare(env, bare, { files: STD_FILES });
      await superproject(env, bare, { gitlink: subCommit, parent: base, url: `file://${subBare}` });
      await run(env, ["clone", "-q", "--template=", bare, workdir]);
      return { bare, workdir, marker: path.join(workdir, "evil", "local-only.txt"), globalConfig };
    },
  },
];

// Tree paths that name the metadata directory, its case or Unicode variants, an NTFS short name, or a parent directory.
// Git's own index refuses most of these; a bare remote stores them. Each file touches the marker.
const TREE_PATHS = [
  ["tree-dotdot", "a '..' component: ../hooks/post-checkout climbs out of the checkout", "../hooks/post-checkout", "script"],
  ["tree-dot-git-hooks", ".git/hooks/post-checkout: a hook inside the metadata directory", ".git/hooks/post-checkout", "script"],
  ["tree-dot-GIT-config", ".GIT/config: a case variant of the metadata config", ".GIT/config", "config"],
  ["tree-dot-git-config", ".git/config: the metadata config itself", ".git/config", "config"],
  ["tree-dot-git-dot-x", ".git./x: a trailing dot, which Windows strips to .git", ".git./x", "script"],
  ["tree-dot-Git-space-x", ".Git /x: a trailing space, which Windows strips to .Git", ".Git /x", "script"],
  ["tree-ntfs-short-name", "GIT~1/hooks/post-checkout: the NTFS 8.3 short name of .git", "GIT~1/hooks/post-checkout", "script"],
  ["tree-lookalike-fullwidth", "U+FF0E followed by git, a fullwidth full stop, under hooks/", "\uff0egit/hooks/post-checkout", "script"],
  ["tree-lookalike-dotless-i", ".g U+0131 t (dotless i) under hooks/, which looks like .git", ".g\u0131t/hooks/post-checkout", "script"],
];

const treeCases = TREE_PATHS.map(([id, describe, entryPath, kind]) => ({
  id,
  describe,
  expect: "refused",
  async build(dir) {
    const { env, globalConfig } = await setup(dir);
    const marker = path.join(dir, "marker");
    const bare = path.join(dir, "remote.git");
    const body = kind === "config" ? `[core]\n\tfsmonitor = touch '${marker}'\n` : `#!/bin/sh\ntouch '${marker}'\n`;
    const mode = kind === "config" ? "100644" : "100755";
    await seedBare(env, bare, { files: STD_FILES, extra: async (e, b) => [{ path: entryPath, mode, sha: await blob(e, b, body) }] });
    return { bare, marker, globalConfig };
  },
}));

// Two names that differ only by case: distinct on Linux, one directory on a case-folding filesystem. The second is hostile.
const collisionCases = [
  {
    id: "collide-case-fold",
    describe: ".husky/pre-commit (safe) and .HUSKY/pre-commit (touches the marker). They are one path after case folding.",
    expect: "refused",
    async build(dir) {
      const { env, globalConfig } = await setup(dir);
      const marker = path.join(dir, "marker");
      const bare = path.join(dir, "remote.git");
      await seedBare(env, bare, {
        files: STD_FILES,
        extra: async (e, b) => [
          { path: ".husky/pre-commit", mode: "100755", sha: await blob(e, b, "#!/bin/sh\nexit 0\n") },
          { path: ".HUSKY/pre-commit", mode: "100755", sha: await blob(e, b, `#!/bin/sh\ntouch '${marker}'\n`) },
        ],
      });
      return { bare, marker, globalConfig };
    },
  },
];

const scriptBody = (marker) => `#!/bin/sh\ntouch '${marker}'\n`;

const shapeCases = [
  {
    id: "file-over-50mib",
    describe: "A 51 MiB executable hooks/post-checkout whose first line touches the marker. Streamed into hash-object, so it is written once and never on disk as a temp file.",
    expect: "refused",
    async build(dir) {
      const { env, globalConfig } = await setup(dir);
      const marker = path.join(dir, "marker");
      const bare = path.join(dir, "remote.git");
      await seedBare(env, bare, {
        files: STD_FILES,
        extra: async (e, b) => [{ path: "hooks/post-checkout", mode: "100755", sha: await streamBlob(e, b, scriptBody(marker), 51 * 1024 * 1024) }],
      });
      return { bare, marker, globalConfig };
    },
  },
  {
    id: "tree-100k-entries",
    describe: "One tree with 100,000 entries (f000000 to f099999, all one blob) plus hooks/post-checkout. Must finish inside the time bound, so nothing may scale badly.",
    expect: "refused",
    async build(dir) {
      const { env, globalConfig } = await setup(dir);
      const marker = path.join(dir, "marker");
      const bare = path.join(dir, "remote.git");
      await run(env, ["init", "-q", "--bare", "--template=", "-b", "main", bare]);
      const same = await blob(env, bare, "x\n");
      const hooks = await rawTree(env, bare, [{ mode: "100755", name: "post-checkout", sha: await blob(env, bare, scriptBody(marker)) }]);
      const entries = [{ mode: "100644", name: "README.md", sha: await blob(env, bare, STD_FILES["README.md"]) }, { mode: DIR_MODE, name: "hooks", sha: hooks }];
      for (let i = 0; i < 100000; i += 1) entries.push({ mode: "100644", name: `f${String(i).padStart(6, "0")}`, sha: same });
      const sha = await commit(env, bare, await rawTree(env, bare, entries), "100k entries");
      await run(env, ["update-ref", "refs/heads/main", sha], { gitDir: bare });
      return { bare, marker, globalConfig };
    },
  },
  {
    id: "path-newline",
    describe: "Entry name 'notes.md' LF 'hook' (a newline inside one name). A line-based parser of ls-tree output sees two paths.",
    expect: "refused",
    async build(dir) {
      const { env, globalConfig } = await setup(dir);
      const marker = path.join(dir, "marker");
      const bare = path.join(dir, "remote.git");
      await seedBare(env, bare, {
        files: STD_FILES,
        extra: async (e, b) => [{ path: "notes.md\nhook", mode: "100755", sha: await blob(e, b, scriptBody(marker)) }],
      });
      return { bare, marker, globalConfig };
    },
  },
  {
    id: "path-leading-dash",
    describe: "Entry name '--output=marker-dash'. Any git call that takes paths without a -- separator reads it as an option and writes marker-dash in the working directory.",
    expect: "no-marker",
    async build(dir) {
      const { env, globalConfig } = await setup(dir);
      const bare = path.join(dir, "remote.git");
      await seedBare(env, bare, { files: STD_FILES, extra: async (e, b) => [{ path: "--output=marker-dash", mode: "100644", sha: await blob(e, b, "a file named like an option\n") }] });
      const workdir = path.join(dir, "host");
      await run(env, ["clone", "-q", "--template=", bare, workdir]);
      return { bare, workdir, marker: path.join(workdir, "marker-dash"), globalConfig };
    },
  },
];

// Documented limits: the driver or filter is defined in the clone's own .git/config. A writable .git runs commands whatever the
// flags are, so these are not defended by flags. The runner must keep .git out of the agent's reach.
const limitCases = [
  {
    id: "limit-git-config-merge-driver",
    describe: "Tree .gitattributes says merge=evil; the clone's .git/config defines the driver. Runs when .git is writable.",
    expect: "limit",
    async build(dir) {
      const { env, globalConfig } = await setup(dir);
      const marker = path.join(dir, "marker");
      const bare = path.join(dir, "remote.git");
      await seedBare(env, bare, { files: { ".gitattributes": "* merge=evil\n", "notes.txt": STD_FILES["notes.txt"] } });
      const workdir = path.join(dir, "host");
      await run(env, ["clone", "-q", "--template=", bare, workdir]);
      await run(env, ["config", "merge.evil.driver", `touch '${marker}'; false`], { cwd: workdir });
      // side and main both edit notes.txt, so a merge of side into main has to call the driver.
      await run(env, ["checkout", "-q", "-b", "side"], { cwd: workdir });
      await writeFile(path.join(workdir, "notes.txt"), STD_FILES["notes.txt"].replace("line 1", "line 1 (side)"));
      await run(env, ["commit", "-q", "-am", "side edit"], { cwd: workdir });
      await run(env, ["checkout", "-q", "main"], { cwd: workdir });
      await writeFile(path.join(workdir, "notes.txt"), STD_FILES["notes.txt"].replace("line 6", "line 6 (main)"));
      await run(env, ["commit", "-q", "-am", "main edit"], { cwd: workdir });
      return { bare, workdir, marker, globalConfig };
    },
  },
  {
    id: "limit-git-config-filter",
    describe: "Tree .gitattributes says filter=evil; the clone's .git/config defines the clean filter. Runs when .git is writable.",
    expect: "limit",
    async build(dir) {
      const { env, globalConfig } = await setup(dir);
      const marker = path.join(dir, "marker");
      const bare = path.join(dir, "remote.git");
      await seedBare(env, bare, { files: { ".gitattributes": "* filter=evil\n", "notes.txt": STD_FILES["notes.txt"] } });
      const workdir = path.join(dir, "host");
      await run(env, ["clone", "-q", "--template=", bare, workdir]);
      await run(env, ["config", "filter.evil.clean", `touch '${marker}'; cat`], { cwd: workdir });
      return { bare, workdir, marker, globalConfig };
    },
  },
];

// Verified by control.test.mjs on git 2.43: plain git refuses these on its own (checkout path validation, or the default
// transport policy for submodules). They stay in the corpus with expect "refused" and plainGitRefuses true.
const PLAIN_GIT_REFUSES = new Set([
  "submodule-ext-url", "submodule-file-url",
  "tree-dotdot", "tree-dot-git-hooks", "tree-dot-GIT-config", "tree-dot-git-config", "tree-dot-git-dot-x", "tree-dot-Git-space-x", "tree-ntfs-short-name",
]);

export const cases = [...hostHookCases, ...remoteHookCases, ...attributeCases, ...symlinkCases, ...submoduleCases, ...treeCases, ...collisionCases, ...shapeCases, ...limitCases]
  .map((c) => ({ ...c, plainGitRefuses: PLAIN_GIT_REFUSES.has(c.id) }));
