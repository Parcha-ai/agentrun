# Changelog

## [Unreleased]

- `https(url, credential, { pushUrl? })` and `codeStorage({ origin, repo, token, hidden? })` make the remotes a host needs beyond `local`. `https` takes any https git host and a credential callback asked once for each git process, so a short-lived token is minted fresh each time; a URL with userinfo, a query or a fragment is refused before any git process starts. `codeStorage` builds `<origin>/<repo>.git` from a host-supplied origin (there is no default hostname) and sends the JWT `token()` returns as the Basic password of user `t`, over plain git with no SDK; with `hidden: true`, pushes go to `<repo>+ephemeral.git`, a namespace a normal clone does not see, while reads fetch `<repo>.git`. The tests run a TLS smart-HTTP server over `git http-backend` that requires the generated token and refuses `main` for the run's identity in a pre-receive hook: the token stays in the fd-3 file (never argv, the environment, a URL or a file), and a refused push is a `refused` error whose message holds `[credential]` where a server's reason repeats the token.
- New held package `@parcha/pi-git-remote`: a git repository a host keeps for its agent. `openRepo({ dir, remote })` opens
  the host's own bare repository and keeps it in step with a remote (`local(path)`, a bare repository on this machine, in
  this release; the `Remote` object takes an https URL, a push URL and a credential callback). `commitTo` builds one commit
  through plumbing on a temporary index and is idempotent by a `Run-Id` trailer found here or on the remote, so a restarted
  host commits nothing twice; `push` sends a commit by sha and is never forced; `merge` and `revert` use `git merge-tree`
  and change nothing on a conflict; `checkout` copies regular files only, never executable; `read`, `list`, `resolve` and
  `log` read. No hook, filter, merge driver, fsmonitor or credential helper of either repository runs, an https credential
  reaches git only on file descriptor 3 (never argv, the environment, a URL or a file), and a URL with userinfo is refused.
  A `.git` segment in any spelling, `..`, symlinks, submodules, case collisions and files over the caps are refused or
  skipped and named. Every failure is a `GitRemoteError` with a `code`. Needs git 2.40 or later.

  The package is also a pi package: its `./coding-agent` subpath, `createGitRemoteExtension`, is a pi coding-agent extension
  that gives a session a repository it commits to at the end, with the host holding git and the model getting no tool. On
  `session_start` it checks a ref out into a directory outside the session's working directory with no `.git` in it, and pi loads
  the repository's `.agents/skills` (through `resources_discover`) and its `AGENTS.md` (through `before_agent_start`, as the seeded
  commit has it). On `session_shutdown` it commits the changes an allowlist of globs names to `sessions/{sessionId}`, built on the
  seeded commit with `Session-Id` and `Seeded-From` trailers, and pushes by sha; it never pushes `main`, refuses the whole end for a
  symlink or anything the package's limits refuse, compares the directory with what it held at the last save, and commits nothing
  the second time. Options, `--git-remote`, `--git-ref`,
  `--git-allow`, `--git-branch` and `--git-checkout-dir`, or the `gitRemote` key of pi's settings configure it.
