# @parcha/pi-git-remote

A git repository a host keeps for its agent. The host commits files to branches, pushes them, merges and reverts, and
checks a branch out into a directory the agent reads. Commits are built with git's plumbing on a temporary index, so no
working tree is involved. No hook, filter, merge driver, fsmonitor or credential helper from either repository ever
runs. A credential stays in the host's memory and reaches git only on file descriptor 3.

The core is plain Node over the git CLI. It does not import pi, so any host can use it. It is the base for agents that
learn in a repository: a run proposes on `runs/<id>`, a curator merges to `main`, a bad lesson is reverted.

This package is held: it is built and tested in this repository and not published yet.

## Quickstart (no key, no network)

Node 22.19 or later and git 2.40 or later. In a checkout of this repository, run `npm ci --ignore-scripts` and
`npm run build -w @parcha/pi-git-remote`, save this as `quickstart.mjs` at the repository root, and run
`node quickstart.mjs`:

```js
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { local, openRepo } from "@parcha/pi-git-remote";

const root = mkdtempSync(path.join(tmpdir(), "acme-"));
const remoteDir = path.join(root, "acme.git");
execFileSync("git", ["init", "-q", "--bare", "--template=", "-b", "main", remoteDir]);

const repo = await openRepo({ dir: path.join(root, "host"), remote: local(remoteDir) });
const seed = await repo.commitTo("main", { files: { "AGENTS.md": "# Rules\n\nCite every claim.\n" }, message: "seed" });
await repo.push(seed.sha, "main");

// A run proposes on its own branch. A second call with the same Run-Id commits nothing.
const files = { "inbox/run-1.md": "Registries match the legal name without the suffix.\n" };
const run = await repo.commitTo("runs/run-1", { files, message: "run-1 proposes", trailers: { "Run-Id": "run-1" } });
await repo.push(run.sha, "runs/run-1");
console.log("again:", await repo.commitTo("runs/run-1", { files, message: "retry", trailers: { "Run-Id": "run-1" } }).then((c) => c.created));

const merged = await repo.merge("runs/run-1", "main");
await repo.push(merged.sha, "main");
const out = await repo.checkout("main", { into: path.join(root, "work") });
console.log("checked out:", out.files.join(", "));
console.log("log:", (await repo.log()).map((c) => `${c.subject} ${JSON.stringify(c.trailers)}`).join(" | "));
```

```
again: false
checked out: AGENTS.md, inbox/run-1.md
log: run-1 proposes {"Run-Id":["run-1"]} | seed {}
```

## The repository

`openRepo({ dir, remote })` opens the host's own repository at `dir`, a bare repository it creates when the directory is
empty or absent, and fetches the remote. Every method that reads a branch fetches first. Writes change local branches
only, and only if the branch has not moved since the write began; `push` sends a commit to the remote. Calls on one
`Repo` run one at a time.

| Method | What it does |
|---|---|
| `resolve(ref)` | The commit a branch or a full sha names. A local commit not yet pushed wins, unless the remote moved past it or away from it: the remote is the source of truth. With a push URL, the newer of the two remote tips counts. |
| `checkout(ref, { into })` | Copies the regular files of `ref` into the empty directory `into`, never executable. It skips symlinks, submodules, paths git's index refuses, both spellings of a case collision, and files over the size cap, and names each one in `skipped`. A tree over `maxTreeEntries` files is refused whole. `into` may not be inside the host repository. |
| `read(path, ref)`, `list(prefix, ref)` | A file's text at a commit; the entries under a prefix (`""` for the whole tree). A branch is fetched first; a full sha reads locally. |
| `commitTo(branch, { files, message, trailers, parent })` | One commit with `files` applied (`null` deletes a path), built on the branch's tip, or on main for a new branch. `parent` names the commit to build on; a branch whose tip is elsewhere fails with `conflict`. A branch that already holds a commit with the same `Run-Id` trailer, locally or on the remote, gets no new commit, so a restarted host with an empty repository commits nothing twice. No change, no commit. |
| `push(sha, branch)` | Sends a commit by sha to `refs/heads/<branch>`. Never forced. A remote that moved is a `conflict`; a remote that refuses the ref is `refused`. |
| `merge(from, into)` | A fast-forward when possible, else a merge commit from `git merge-tree`. A conflict names the paths and moves nothing. |
| `revert(sha, on)` | A commit on `on` that undoes `sha`, an older commit included. Reverting twice changes nothing the second time; a conflict moves nothing. |
| `log({ ref, path, trailer, max })` | Commits newest first, with their trailers; filter by path or by a trailer key and value. |

## What never runs

Every git call gets an environment built from nothing (no system or global config, a scratch `HOME`, no prompts) and these
flags before the command: `core.hooksPath=/dev/null`, `core.fsmonitor=false`, `credential.helper=` (then the fd-3 helper when
there is a credential), `core.askPass=`, `attr.tree` pinned to the empty tree, and `protocol.allow=never` with only `file`
and `https` allowed. Blobs are written with `hash-object --no-filters` and read with `cat-file` without filters. Pushes
pass `--no-verify`, and on a local remote, `--receive-pack` and `--upload-pack` turn hooks off on the receiving side too,
since our flags do not cross a local push. `merge-tree` runs from an empty directory. Checkout reads and writes blobs in bounded batches, so its memory does not grow with the tree.

The tests plant every hook git has in the host repository and in the remote, a `.gitattributes` naming filters, a union
merge and `eol`/`ident` conversions, and a repository config that names hooks, fsmonitor, a credential helper and askpass,
and show that none of it runs or changes a byte. A control shows the same hooks fire under plain git. A hostile-repository
corpus (34 cases in `test/hostile/`, with its own control) does the same for symlinks, submodules, `..` and `.git` paths
in every spelling, case collisions, a 51 MiB file, a 100,000-file tree, a newline in a name and a name that reads as an
option.

**The one thing flags cannot do:** git always reads the host repository's own config and `info/attributes`. A host
repository that someone else can write runs that person's merge driver whatever the flags say (a pinned test shows it).
Keep `dir`, and a local remote's directory, out of an agent's reach: never inside a run's working directory.

## Limits

A path is relative, `/`-separated and canonical, with no control character, no backslash, and no `.git` segment in any
spelling git or a case-insensitive file system treats as `.git` (case, ignorable Unicode characters, trailing dots and
spaces, an NTFS stream suffix, the 8.3 short name), nor one that reads as `.git` after compatibility normalization.
`commitTo` refuses such a path, more than `maxFiles` paths, a file over `maxFileBytes`, a path that is both a file and a
directory, and two paths that differ only in case. `merge` and `revert` refuse a result that brings in a symlink, a
submodule, a file over `maxFileBytes` or any of these paths. Defaults: `maxFileBytes` 1 MiB, `maxFiles` 256, `maxTreeEntries` 10,000; pass `limits`
to `openRepo` to change them.

## Remotes and credentials

`local(path)` is a bare repository on this machine. A remote is a small object, so other kinds can be added:

```ts
type Remote = {
  kind: "local" | "https";
  url: string;            // fetched from, and pushed to unless pushUrl is set
  pushUrl?: string;       // where pushes go when it differs (a namespace hidden from clones); fetched too
  credential?: () => GitCredential | undefined | Promise<GitCredential | undefined>;
};
```

A URL with userinfo is refused, and the refusal never repeats it. An https remote's credential is a callback, asked once
for each git process that talks to the remote. The host writes `username` and `password` into an unlinked file opened for
that one process and hands it to git on file descriptor 3; git's only credential helper prints it. It never appears in
argv, the environment, a URL or a file left on disk, and an error message replaces it with `[credential]`. The tests
check this with a recording git. A local remote takes no credential.

## A repository for a pi coding-agent session

`@parcha/pi-git-remote/coding-agent` is a pi extension that gives a session a git repository it commits to at the end.
The model gets no tool and never touches git: on start the extension checks a ref out into a directory with no `.git` in
it, and on shutdown it commits the paths an allowlist names to the session's own branch and pushes that commit by sha.

```sh
npm ci --ignore-scripts && npm run build -w @parcha/pi-git-remote    # in a checkout of this repository
PKG=$PWD/packages/pi-git-remote; cd "$(mktemp -d)"
git init -q --bare -b main acme.git
git clone -q acme.git seed 2>/dev/null && (cd seed && mkdir notes && echo "Cite every claim." > AGENTS.md && echo hello > notes/hello.md \
  && git add -A && git commit -qm seed && git push -q origin main)
pi -e "$PKG" --git-remote ./acme.git --git-allow 'notes/**'
# ask pi to add a file under the checkout it names (the path is in its AGENTS.md context), then quit
git -C acme.git branch --list 'sessions/*'    # one branch, one commit on top of main, with a Session-Id trailer
```

Until the package is published, `pi -e <path to this package>` loads it; once it is, `pi -e npm:@parcha/pi-git-remote` or
`pi install npm:@parcha/pi-git-remote` will. The session's context carries the repository's `AGENTS.md` and its
`.agents/skills/`, so the instructions for where to write belong in the repository.

| Setting | Flag | Default |
|---|---|---|
| `remote`: a local bare repository, or an https URL | `--git-remote` | none: with no remote the extension does nothing |
| `ref`: the branch or commit to start from | `--git-ref` | `main` |
| `allow`: globs of paths that may be committed (`*`, `?` and `**` only) | `--git-allow notes/**,skills/**` | required: with a remote and no allowlist the session does not start |
| `branch`: the session branch, `{sessionId}` once in it | `--git-branch` | `sessions/{sessionId}` |
| `checkoutDir`: where the files go, `{sessionId}` replaced | `--git-checkout-dir` | `<stateDir>/checkouts/{sessionId}` |
| `stateDir`: the host repository, checkouts and seed records | | `git-remote` in pi's agent directory |

An embedding host passes the same names as options, which win over the flags, which win over the `gitRemote` key of pi's
`settings.json`. It can also pass a `Remote` with a credential callback, `limits` for package A's caps, and `onEnd` to hear how
each end went:

```ts
import { createGitRemoteExtension } from "@parcha/pi-git-remote/coding-agent";
import { local } from "@parcha/pi-git-remote";

const extension = createGitRemoteExtension({ remote: local("/srv/acme.git"), allow: ["notes/**"], onEnd: (report) => console.log(report) });
// createAgentSessionServices({ resourceLoaderOptions: { extensionFactories: [extension] } })
```

**How pi gets the repository.** `session_start` seeds the directory. `resources_discover`, the hook that adds resource
roots, returns the checkout's `.agents/skills`, since skills, prompts and themes are all it can add. `AGENTS.md` is not a
resource root in pi, so `before_agent_start` adds the repository's `AGENTS.md` to the context files, as the seeded commit has
it: an edit to the working file in the middle of a session changes nothing the model is shown, so the prompt cache holds.
`--no-context-files` does not stop it: configuring a remote asked for its instructions.

**What the end commits.** `session_shutdown` for `quit`, `new`, `resume` and `fork` ends the session; a `reload` does not, and
the new runtime keeps the directory. The end reads the files the allowlist can reach, never through a symlink, and commits
the ones that differ from the seeded commit, and the deletions, with `commitTo` on `sessions/<id>`, built on the seeded
commit, with `Session-Id` and `Seeded-From` trailers, then pushes it by sha. Nothing outside the allowlist is read, and
nothing but that branch is written: the branch must hold the id, must not be `main`, `master` or the ref the session
started from, and an existing branch that does not carry this session's trailer is refused.

Refusal is for the whole end, never a partial commit: a symlink, a device or any non-regular file at a path the allowlist
reaches, a `.git` segment in any spelling, a file over `limits.maxFileBytes`, more than `limits.maxFiles` changes. Nothing
is pushed, pi reports the error, and the directory stays, so fixing it and ending again works. A symlink where the
allowlist does not reach is ignored like any other file there. An end repeated for the same session finds its commit and
commits nothing; it pushes the commit again, so a push that failed is retried. A session resumed later adds a commit on
top of its branch and never removes what an earlier end committed. A forked session starts from the ref, not from its
parent's directory.

**What this does not do.** Pi's own `bash` tool has your permissions, so on a plain pi session the model can reach the host
repository and the state directory like any other file of yours. The extension keeps git away from the model's tools, not from
a model that is not sandboxed. Keep `stateDir` out of an agent's reach (a sandboxed `bash`, or a host that does not run the
model as you), and do not put `AGENTS.md`, rules or credentials in the allowlist. The allowlist limits paths, not contents: nothing here reads a file for a secret.

## Errors

Every failure is a `GitRemoteError` with a `code`: `refused` (a rule says no), `conflict` (a merge or revert conflicts, or
the remote moved), `missing` (no such ref, commit or path), or `git` (git itself failed). `paths` names the paths a
refusal or conflict is about.
