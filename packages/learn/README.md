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

It is held: it is built, tested and verified with the other packages and is not on npm yet. Install it from a packed
tarball (`npm pack -w @parcha/agentrun-learn`).

## Check a run's branch

Node 22.19 or later and git. On the run's branch, in the agent's repository:

```sh
agentrun-learn check --base main --tools host-tools.json
```

It prints `runs/<run id>: ok` and exits 0, or it names each problem by rule and file and exits 1. A bad command line, or a ref that names no commit, exits 2. It gives the same verdict from any folder of the work tree. Everything it prints, text or JSON, is redacted: a value it refuses, or text shaped like a secret, reads `[redacted]` even in a file's name or the branch's name. A name or detail that holds one in a form it cannot cut out, percent encoded or split by whitespace, prints whole as `[redacted]`.

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

## Asking a run to reflect

```js
import { reflectBudget, reflectPrompt } from "@parcha/agentrun-learn";

const reserveUsd = reflectBudget(run.maxCostUsd); // a tenth of the cap, at most $0.25; $0.05 with no cap
const prompt = reflectPrompt({ run: run.id, dir: "/work/.agent/repo" });
```

Once a run has answered, a host sends `prompt` as one more turn in the same session. The repository is checked out in
`dir` on `runs/<run id>`, and the host has written the memo's front matter to `memos/<run id>.md`. The agent writes the
four sections under it and its notes with its own tools, as the reflect skill says, and commits them when it can run
git. The prompt names no harness's tool. `reflectPrompt` refuses a run id the layout would refuse and a `dir` that is
not an absolute path or holds a space or an unseen character. The turn's paid requests are held to `reserveUsd`, which
the host keeps back from the run's cap for it.

## Grade a run's branch

```js
import { gradePrompt, parseVerdict } from "@parcha/agentrun-learn";

// Once the checker and the injection screen have passed runs/<run id>:
const prompt = gradePrompt({ run: run.id, instructions: agent.instructions, index: mainIndex, notes: mainNotes, changes });
const verdict = parseVerdict(await grader(prompt), changes); // { merge, reason, items: [{ path, keep, question?, why }] }
```

`changes` are the branch's changed files against `main`, `{ path, status, text, before }`: `text` is the branch's, on
every change but a deletion, and `before` is `main`'s, on a modification. `index` is `main`'s `learnings/INDEX.md`,
`notes` (optional) the notes on `main` the branch does not change, `{ path, text }`, so the grader reads each rule in
full and not only its index line, and `instructions` the agent's standing instructions, as the host keeps them. The
prompt holds `GRADE_RUBRIC`, the rubric's one statement, and fences each file, the index, the notes and the
instructions as data to judge, never to follow: the fence's token is one no fenced text holds, so no text can close its
fence. It asks for one JSON verdict, with one item for each changed file but the memo, the index and the host's receipt
`uses/<run id>.json`, which never reaches `main`.

`parseVerdict` fails closed. It reads one JSON object, alone, in prose or in one fenced block. Two objects, a key
repeated in one object, a missing item, an item named twice or for a path the grader was not asked about, and `merge`
with an item not kept are each no merge; so is an answer it cannot read, with the reason "the grader's verdict could
not be read". An item for the receipt is ignored. The reason and each item's `why` come back as one line of at most
500 characters, with control and unseen characters gone. The branch merges only when `verdict.merge` is true, every
item kept; otherwise it stays unmerged, with the verdict. Neither function calls a model or runs git: the host does
both. `gradePrompt` throws on input no checked branch holds (a run id the layout refuses, a path outside the layout, an
unseen character), and `parseVerdict` never throws on the grader's answer.

## Notes in Claude Code's auto-memory format

A host that keeps what an agent learned as a folder of notes in Claude Code's auto-memory format reads and builds it
with these. Each note is `<slug>.md`: front matter with `name`, `description` and `type` (`user`, `feedback`, `project`
or `reference`), and optionally `status: superseded` or `retired` with `superseded_by` (no status: active), then its
text. `MEMORY.md` is the index, one line per active note.

```js
import { activeNotes, buildIndex, loadedIndex, parseNoteFile } from "@parcha/agentrun-learn";

const note = parseNoteFile("refund-policy-path.md", text); // { file, name, description, type, status, superseded_by, body }, or why not
const active = activeNotes(notes); // the active ones, by file name
const index = buildIndex(notes); // "- [name](file.md) — description\n" per active note; "" with none
const read = loadedIndex(index); // what a run reads: the first 200 lines, within 25 KB
```

`parseNoteFile` answers a list of problems for a note out of shape, or a file name that is `MEMORY.md`, hidden or under a
directory. Keys it does not know are left alone. The checker above still checks the older layout in [SPEC.md](SPEC.md).
