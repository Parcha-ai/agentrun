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
only; `push` sends a commit to the remote. Calls on one `Repo` run one at a time.

| Method | What it does |
|---|---|
| `resolve(ref)` | The commit a branch or a full sha names. A local commit not yet pushed wins, unless the remote moved past it or away from it: the remote is the source of truth. |
| `checkout(ref, { into })` | Copies the regular files of `ref` into the empty directory `into`, never executable. It skips symlinks, submodules, paths git's index refuses, both spellings of a case collision, and files over the size cap, and names each one in `skipped`. A tree over `maxTreeEntries` files is refused whole. `into` may not be inside the host repository. |
| `read(path, sha)`, `list(prefix, sha)` | A file's text at a commit; the entries under a prefix (`""` for the whole tree). |
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
since our flags do not cross a local push. `merge-tree` runs from an empty directory.

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
submodule or any of these paths. Defaults: `maxFileBytes` 1 MiB, `maxFiles` 256, `maxTreeEntries` 10,000; pass `limits`
to `openRepo` to change them.

## Remotes and credentials

A remote is a small object, and three constructors make one:

| Constructor | The remote |
|---|---|
| `local(path)` | A bare repository on this machine. For development, tests and offline hosts. |
| `https(url, credential, { pushUrl? })` | Any https git host: GitHub, GitLab, Gitea, code.storage. |
| `codeStorage({ origin, repo, token, hidden? })` | A code.storage repository over plain git and https, with no SDK. |

```ts
type Remote = {
  kind: "local" | "https";
  url: string;            // fetched from, and pushed to unless pushUrl is set
  pushUrl?: string;       // where pushes go when it differs (a namespace hidden from clones); fetched too
  credential?: () => GitCredential | undefined | Promise<GitCredential | undefined>;
};
```

A URL with userinfo, a query or a fragment is refused, and the refusal never repeats it: `https` and `codeStorage` throw
before any git process starts. An https remote's credential is a callback, asked once for each git process that talks to
the remote, so a short-lived token can be minted fresh each time. The host writes `username` and `password` into an
unlinked file opened for that one process and hands it to git on file descriptor 3; git's only credential helper prints
it. It never appears in argv, the environment, a URL or a file left on disk, and an error message replaces it with
`[credential]`, a server's refusal reason included. A local remote takes no credential.

`https(url, credential, options)` takes the credential callback as its second argument and an optional `pushUrl` for a
separate push target.

`codeStorage` builds `<origin>/<repo>.git` and sends HTTP Basic as user `t` with the JWT `token()` returns, which is how
code.storage takes a git token. `origin` is the git host's base URL from the host's configuration; there is no default
hostname, and a path prefix is kept for a proxy mounted under one. `repo` is the repository id, such as `agents/<id>`.
Minting the JWT, its scopes and its ref policies stay with the host: the package only passes the token to git.

With `hidden: true`, every push goes to `<repo>+ephemeral.git`, a namespace a normal clone does not see, so a run's
branch stays out of the agent's clones. Reads fetch `<repo>.git`, and the ephemeral URL too, so a branch pushed there is
found again (`commitTo` stays idempotent by `Run-Id`). The flag applies to every push of that remote: a host that pushes
`main` uses a second remote without it. When the service refuses a ref, `push` throws `refused`; the tests run a server
whose ref policy refuses `refs/heads/main` for the run's identity.

### The same host code, offline and on code.storage

Only the remote changes. This runs with no network: the `codeStorage` remote is built and printed but never used, and the
push goes to a bare repository on this machine.

```js
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { codeStorage, local, openRepo } from "@parcha/pi-git-remote";

// In production: the host's git origin and a callback that mints a short-lived token. Nothing connects until a repo is opened.
const production = codeStorage({
  origin: "https://git.example.com",
  repo: "agents/acme",
  token: async () => "a-short-lived-jwt-from-your-minter",
  hidden: true,
});
console.log(production.url);
console.log(production.pushUrl);

// In development and tests: the same code over a bare repository on this machine.
const root = mkdtempSync(path.join(tmpdir(), "acme-"));
const bare = path.join(root, "acme.git");
execFileSync("git", ["init", "-q", "--bare", "--template=", "-b", "main", bare]);

async function propose(remote, dir) {
  const repo = await openRepo({ dir, remote });
  const run = await repo.commitTo("runs/run-1", {
    files: { "inbox/run-1.md": "Registries match the legal name without the suffix.\n" },
    message: "run-1 proposes",
    trailers: { "Run-Id": "run-1" },
  });
  await repo.push(run.sha, "runs/run-1");
  return (await repo.resolve("runs/run-1")) === run.sha;
}
console.log("pushed:", await propose(local(bare), path.join(root, "host")));
```

```
https://git.example.com/agents/acme.git
https://git.example.com/agents/acme+ephemeral.git
pushed: true
```

## Errors

Every failure is a `GitRemoteError` with a `code`: `refused` (a rule says no), `conflict` (a merge or revert conflicts, or
the remote moved), `missing` (no such ref, commit or path), or `git` (git itself failed). `paths` names the paths a
refusal or conflict is about.
