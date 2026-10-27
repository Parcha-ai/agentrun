# @parcha/agentrun-learn

Self-learning on any harness, as files. An agent keeps its own git repository: its rules, plus the notes, skills and
workflow drafts it has learned. After a run it writes a memo and commits what it learned to that run's own branch,
`runs/<run id>`. A review step merges what passes into `main`, and the next run reads `main`. Codex, Claude Code and Pi
already edit files and run git, so the loop needs no integration with a harness: it is a layout, a memo format and a
note format, in [SPEC.md](SPEC.md).

This package is that contract plus the one piece of code it needs: a checker that validates a run's branch before any
merge. The checker is structural. It checks the layout and the locked paths (the agent's rules, the loop's own review
skill, hooks, CI, package scripts, the spec), the formats, the caps, the run's memo, hidden characters and text shaped
like a secret. A branch that passes goes on to an injection screen and the review, and what passes them merges
automatically; [SPEC.md](SPEC.md#the-merge-policy) sets the order. Whether a note is any good is the review's judgment.

Anything an agent learns on any harness must run on the workflow DSL, so a workflow draft must pass the DSL's own
`validateWorkflow`, given the host's tool list as its `tools` option. With no list, a draft that names a tool is
refused. A draft merges without a person, so a node that runs code (a `code` node, or a call via shell or executor)
is refused.

Install it from npm with `npm install @parcha/agentrun-learn@beta`. For a version that is not on npm yet, pack it from a
checkout (`npm pack -w @parcha/agentrun-learn`) and install the tarball.

## The two skills

`skills/reflect/SKILL.md` and `skills/review/SKILL.md` are the loop itself, written for any harness that can edit files
and run git:

- **reflect**, after every run: write the memo on `runs/<run id>`, add or update notes and the index, add a skill or a
  workflow draft when the work repeats, run the checker, push the branch.
- **review**, before a merge: run the checker, require the injection screen, ask the checklist of each new or changed
  item, drop what fails with its reason in the memo's `## Review` section, and merge the rest with a merge commit.

To use them outside AgentRun, copy both folders into the agent's repository as `.agents/skills/reflect/` and
`.agents/skills/review/` (both are locked: no run may change them), and run the checker in a pre-push hook or CI, as
below. Outside AgentRun there is no injection screen, so the review merges only when a person has read the branch's new
and changed files and says so.

## Check a run's branch

Node 22.19 or later and git. On the run's branch, in the agent's repository:

```sh
agentrun-learn check --base main --tools host-tools.json
```

It prints `runs/<run id>: ok` and exits 0, or it names each problem by rule and file and exits 1. A bad command line, or a ref that names no commit, exits 2.

| Option | What it does |
| --- | --- |
| `--base <ref>` | the ref the run's branch merges into, such as `main` or `origin/main` |
| `--head <ref>` | the run's commit; `HEAD` by default |
| `--branch runs/<run id>` | the branch the run pushes; by default the branch `--head` names |
| `--run-base <ref>` | the commit the host started the run from; the memo's `base` must be it (default: the branch's fork point from `--base`) |
| `--tools <file.json>` | the host's tool list, a JSON array of names or `{"tools": [...]}`. Without it, a draft that names a tool is refused. A list kept inside the repository is locked against the run |
| `--refuse-values-from-env NAME,...` | refuse any file that holds the value of one of these variables; a value is never printed |
| `--json` | print `{ok, run, branch, forkPoint, problems}` |

The checker reads git objects with plumbing only. It never checks anything out, so no hook, filter, smudge or merge
driver of the repository runs.

### As a pre-push hook

`.git/hooks/pre-push`:

```sh
#!/bin/sh
while read -r local_ref local_sha remote_ref remote_sha; do
  case "$remote_ref" in
    refs/heads/runs/*) agentrun-learn check --base origin/main --head "$local_sha" --branch "${remote_ref#refs/heads/}" --tools "$HOME/.config/agentrun/tools.json" || exit 1 ;;
    refs/heads/main) echo "a run never pushes to main" >&2; exit 1 ;;
  esac
done
```

### In CI

```sh
git fetch origin main
agentrun-learn check --base origin/main --head "$GITHUB_SHA" --branch "$GITHUB_HEAD_REF" --tools host-tools.json --refuse-values-from-env STORE_API_KEY
```

## From code

```js
import { checkBranch, checkRun } from "@parcha/agentrun-learn";

// A git repository: the changes from where the branch starts on base to head.
const { ok, problems } = await checkBranch({ cwd: "agent-repo", base: "main", tools: ["fetch_page", "browser"] });

// Or changes you already hold: path, status, git mode and the file's bytes at the branch's head.
const found = checkRun({
  branch: "runs/2026-10-27-0412-a1b2",
  tools: ["fetch_page", "browser"],
  changes: [{ path: "learnings/L-7c21e0a4b9d3.md", status: "added", bytes: Buffer.from(noteText) }],
});
```

Each returns `{ ok, problems }`, and each problem is `{ rule, path?, detail }`. [SPEC.md](SPEC.md#what-the-checker-reports) lists the rules.
