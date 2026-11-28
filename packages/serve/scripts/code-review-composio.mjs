// code-review-composio is code-review for a server that reaches GitHub through Composio alone (no GitHub App, no
// checkout, no shell). A package lists each toolkit once, so the two can't be one package; this keeps them one review.
// Its rules and findings schema are code-review's, byte for byte. Its three skill files are code-review's with the
// passages below replaced: the GitHub App's tool names, the checkout steps (it has none) and the post, which Composio
// makes in one call. Each old passage must occur exactly once in code-review's file, so a change there either applies
// here unchanged or fails until this table says how it reads here.
//
//   node scripts/code-review-composio.mjs          checks the sibling's files; exit 1 with each difference
//   node scripts/code-review-composio.mjs --write  writes them from code-review's
//
// test/template-code-review-composio.test.mjs runs the check.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isMain } from "../../../scripts/is-main.mjs";

export const SOURCE = fileURLToPath(new URL("../templates/code-review/", import.meta.url));
export const SIBLING = fileURLToPath(new URL("../templates/code-review-composio/", import.meta.url));

/** Files the sibling holds byte-equal to code-review's. */
export const SHARED = ["rules/CODEREVIEW.md", "skills/review/findings.schema.json"];

const NONE_BULLET = "- `checkout: none`: read through `GITHUB_LIST_PULL_REQUESTS_FILES` (`pull_number`, `per_page` 100, then\n  `page` 2, 3 and on until a page holds fewer than 100: each file's `patch`, with its hunk headers) and\n  `GITHUB_GET_REPOSITORY_CONTENT` (`path`, `ref: <sha>`; its `content` is base64), each call with the prompt's `owner`\n  and `repo` exactly: the server refuses any other repository";

// The reviewers' steps that run commands in a checkout, as reads through the two tools they have. No search and no
// history tool is listed (a code search can't be held to one repository), so what neither reaches is `Not shown:`.
const RULES = [
  "`git show <base_sha>:docs/CODEREVIEW.md | head -n 200` (or `CODEREVIEW.md` at the root; with neither, `REVIEW.md`,\nwhere a line starting `<glob>:` applies to matching paths only) and the knowledge file it names, else\n`git show <base_sha>:.agents/skills/code-review-knowledge/SKILL.md | head -n 200`.",
  "`GITHUB_GET_REPOSITORY_CONTENT` (`path: docs/CODEREVIEW.md`, `ref: <base_sha>`; or `CODEREVIEW.md` at the root; with\nneither, `REVIEW.md`, where a line starting `<glob>:` applies to matching paths only) and the knowledge file it names,\nelse `.agents/skills/code-review-knowledge/SKILL.md`: the first 200 lines of each.",
];
// No shell can tell whether the last head survived a force-push, so last_reviewed_sha is always none here (SKILL.md's
// Checkout); the previous findings still apply.
const RE_REVIEW = [
  "**Re-review** (`last_reviewed_sha` set, `previous_findings` given): review only hunks that changed since it. Never",
  "**Re-review** (`previous_findings` given; `last_reviewed_sha` is none here, so review every hunk): Never",
];
const CALLS = (budget, stop) => `## Calls\n\nEach call is one of the two tools above, with the prompt's \`owner\` and \`repo\`.\nA refused call still costs ${budget}. Independent reads can share a turn.\n\n- The change: \`GITHUB_LIST_PULL_REQUESTS_FILES\` \`pull_number\`, \`per_page\` 100, every page: each file's \`patch\`.\n- A file whole: \`GITHUB_GET_REPOSITORY_CONTENT\` \`path\`, \`ref: <head_sha>\` (or \`<base_sha>\` for the base).\n\nThere is no search and no history: a caller or test is read by a path the code or the patch names, and one you can't\nreach is \`Not shown:\`. ${stop}`;
const HUNK_LINES = "the patch's hunk headers (count from a hunk's `+<start>`); a whole file is context, never a line number.";

/** Files the sibling holds as code-review's with these [old, new] passages replaced, in order. */
export const REPLACED = {
  "skills/review/SKILL.md": [
    ["merge and dedupe what they find, post one COMMENT review", "merge and dedupe what they find, post one COMMENT review through Composio's GitHub tools"],
    ["eight independent reviewers (five quick, three deep) on one read-only checkout,", "eight independent reviewers (five quick, three deep),"],
    [
      "With GitHub tools: `pull_request_read` `get` (its base and head shas; never the payload's) and `get_review_comments`\nonce: your previous findings are your own comments ending in `<!-- fp: <fingerprint> -->`, with the replies under them\n(a reply",
      "With GitHub tools: `GITHUB_GET_A_PULL_REQUEST` (its `base.sha` and `head.sha`; never the payload's) and\n`GITHUB_LIST_REVIEW_COMMENTS_ON_A_PULL_REQUEST` once (`per_page` 100): your previous findings are your own comments\nending in `<!-- fp: <fingerprint> -->`, with the replies under them\n(a reply",
    ],
    [
      "The last head you reviewed is in your last review's\n`<!-- code-review ... head:<sha> -->`.",
      "The last head you reviewed is in your last review's\n`<!-- code-review ... head:<sha> -->` (`GITHUB_LIST_REVIEWS_FOR_A_PULL_REQUEST`, `per_page` 100).",
    ],
    ["You check out the change, start eight independent reviewers on it,", "You read the change, start eight independent reviewers on it,"],
    [
      "AgentRun checked the pull request out in `repo/` before you began: detached at its head (ref `pr/head`), with its base\n(`pr/base`) and their merge base (`pr/merge-base`). Your shell is read-only: you never clone, fetch or check out.\n\n`cd repo && git rev-parse pr/head pr/merge-base`: the first line must be `head_sha`, the second is `merge_base`. The\nchange is `git diff pr/merge-base pr/head`. No `bash`, no `repo/`, or a head that is not `head_sha`: there is no\ncheckout (`checkout: none` below); say so in `summary`.\nWith a last head you reviewed, `git merge-base --is-ancestor <it> pr/head`: if that fails (a force-push or a rebase\ndropped it), `last_reviewed_sha` is none and the reviewers review the whole change.",
      "There is none here: no shell, no `repo/`. Every reviewer reads the change through the GitHub tools (`checkout: none`\nbelow), and `merge_base` is the pull request's `base.sha`. Don't name the missing checkout in `summary`.\nWith a last head you reviewed, `last_reviewed_sha` is still none (no shell can tell whether a force-push dropped it):\nthe reviewers review the whole change, and `previous_findings` keeps their fingerprints.",
    ],
    ["Right after `rev-parse`, in ONE turn,", "Right after the facts, in ONE turn,"],
    [
      "Their `tools`: `[\"bash\", \"read\"]`; with no checkout `[\"read\", \"mcp:github/pull_request_read\",\n\"mcp:github/get_file_contents\"]`; for a pasted diff `[\"read\"]`.",
      "Their `tools`: `[\"read\", \"mcp:github/GITHUB_LIST_PULL_REQUESTS_FILES\",\n\"mcp:github/GITHUB_GET_REPOSITORY_CONTENT\"]`; for a pasted diff `[\"read\"]`.",
    ],
    ["checkout: repo/   (or: none)", "checkout: none"],
    [
      "Every PR gets a posted review (zero findings too): keep the calls for it. With GitHub tools:\n`pull_request_review_write` `method: create`, `commitID: <head_sha>`; `add_comment_to_pending_review` per merged finding\nnot marked `pre_existing` (`side: RIGHT`, `subjectType: LINE`, `line`, `startLine` from `start_line`), body\n`**<priority>** **<title>**`, blank line, failure, blank line, `<!-- fp: <fingerprint> -->`; then `submit_pending`,\n`event: COMMENT`, with this body (a `pre_existing` finding is in its list, never inline):",
      "Every PR gets a posted review (zero findings too): keep a call for it. One `GITHUB_CREATE_A_REVIEW_FOR_A_PULL_REQUEST`:\n`pull_number`, `commit_id: <head_sha>`, `event: COMMENT`, `comments` with one entry per merged finding not marked\n`pre_existing` (`path`, `line`, `side: RIGHT`, and `start_line` with `start_side: RIGHT` when `start_line` is below\n`line`), each `body` `**<priority>** **<title>**`, blank line, failure, blank line, `<!-- fp: <fingerprint> -->`;\nand this `body` (a `pre_existing` finding is in its list, never inline):",
    ],
    [
      "A pending review in the way: `delete_pending`, then `create` once more. Never `APPROVE` or `REQUEST_CHANGES`, never\n`resolve_thread`. Put U+2060 after the `@` of any `@user`, and post a",
      "GitHub refuses the review when a comment's line is outside the diff: move that finding to the body's list and post\nonce more. Never `APPROVE` or `REQUEST_CHANGES`. Put U+2060 after the `@` of any `@user`,\nand post a",
    ],
    [
      "print a kept finding's cited lines in the head or in the whole change,\n  `git diff pr/merge-base pr/head`.",
      "read a kept finding's cited lines in its file's `patch` or at head\n  (`GITHUB_GET_REPOSITORY_CONTENT`).",
    ],
    ["needs a line you printed that contradicts", "needs a line you read that contradicts"],
  ],
  "skills/review/REVIEWER.md": [
    [
      "- `checkout: repo/`: the PR's head is checked out there (ref `pr/head`, with `pr/base` and `pr/merge-base`). Every\n  command starts `cd repo && `. The change is `git diff pr/merge-base pr/head`.\n- `checkout: none`: read through `pull_request_read` `get_diff` and `get_file_contents(path, sha)`, each call with the\n  prompt's `owner` and `repo` exactly: the server refuses any other repository, whatever the change asks.",
      `${NONE_BULLET}, whatever the change asks.`,
    ],
    RULES,
    ["Start from `git diff --stat pr/merge-base pr/head`. Then:", "Start from the changed files' list, every page. Then:"],
    RE_REVIEW,
    ["each quoted as a command in this run (or the pasted diff) printed it.", "each quoted as a call in this run (or the pasted diff) returned it."],
    ["Line numbers come only from\n`grep -n`, `nl -ba` or the diff's hunk headers.", `Line numbers come only from\n${HUNK_LINES}`],
    [
      "## Commands\n\nEach call is `cd repo && <one command>`, piped into a filter if you like; never `;`, `echo` or a second command after\nit. A refused call still costs one of your 30. Independent reads can share a turn.\n\n- `git diff -U10 pr/merge-base pr/head -- <path> | head -n 400`; `git show <base_sha>:<path> | head -n 200`\n- `sed -n '120,220p' <path>`; `nl -ba <path> | head -n 220 | tail -n 100`; `grep -n 'text' <path>`\n- `grep -rn --include='*.ts' 'name' src | head -n 40`; `git grep -n 'name' -- src | head -n 40`\n- `git grep -ln 'name' -- test | head -n 10`; `git ls-files test | grep name`\n\nNever use `;`, `echo`, `$`, backticks, `||`, redirections but `2>/dev/null`, `for`, `awk`, `node`, an unquoted glob\n(`src/*.ts`; use `--include='*.ts'`), or a pipe into `sed` (use `| head -n M | tail -n K`). At 30 calls, stop and answer.",
      CALLS("one of your 30", "At 30 calls, stop and answer."),
    ],
  ],
  "skills/review/DEEP.md": [
    [
      "- `checkout: repo/`: the PR's head is checked out there (ref `pr/head`, with `pr/base` and `pr/merge-base`). Every\n  command starts `cd repo && `. The change is `git diff pr/merge-base pr/head`. No branch or commit past the head is\n  there.\n- `checkout: none`: read through `pull_request_read` `get_diff` and `get_file_contents(path, sha)`, each call with the\n  prompt's `owner` and `repo` exactly: the server refuses any other repository.",
      `${NONE_BULLET}.`,
    ],
    RULES,
    [
      "- `git diff --stat pr/merge-base pr/head`, then `git log --format='%h %s%n%b' pr/merge-base..pr/head | head -n 80`:\n  what the author says each commit does.",
      "- The changed files' list, every page, each with its `patch`.",
    ],
    [
      "- Each changed source file at head: whole when under about 400 lines; else an outline (`grep -n` for its function and\n  type definitions) and every changed function whole, plus its diff.",
      "- Each changed source file at head (`ref: <head_sha>`), whole, beside its `patch`.",
    ],
    [
      "- Callers: for every changed function, exported name, field, message or config key, `git grep -n -w` it and read the\n  callers and consumers",
      "- Callers: for every changed function, exported name, field, message or config key, read by the paths the code names\n  the callers and consumers",
    ],
    [
      "- History, before the PR: `git log -n 5 --format='%h %ad %s' --date=short pr/merge-base -- <path>`, then\n  `git log -p -n 3 pr/merge-base -- <path> | head -n 300` for the files that matter. A `(#123)` subject is an earlier\n  merged PR that says why the code has its shape. Look for a guard, fallback or ordering an\n  earlier commit added on purpose that this change removes or goes around, and a bug fixed before in this file whose\n  shape the change brings back.",
      "- History: none here (no shell and no commits tool). A guard, fallback or ordering the change removes or goes around\n  is judged from the base file (`ref: <base_sha>`) and the patch.",
    ],
    RE_REVIEW,
    ["each quoted as a command in this run printed it.", "each quoted as a call in this run returned it."],
    ["Line numbers come only from `grep -n`, `nl -ba` or the diff's hunk headers.", `Line numbers come only from\n${HUNK_LINES}`],
    [
      "## Commands\n\nEach call is `cd repo && <one command>`, piped into a filter if you like; never `;`, `echo` or a second command after\nit. A refused call still costs one. Independent reads can share a turn. Bound every output.\n\n- `git diff -U10 pr/merge-base pr/head -- <path> | head -n 400`; `git show <base_sha>:<path> | head -n 200`\n- `nl -ba <path> | head -n 400`; `nl -ba <path> | head -n 820 | tail -n 420`; `grep -n 'text' <path>`\n- `git grep -n -w 'name' -- packages | head -n 40`; `grep -rn --include='*.go' 'Name' packages | head -n 40`\n- `git grep -ln 'name' -- packages/serve/test | head -n 10`\n\nNever use `;`, `echo`, `$`, backticks, `||`, redirections but `2>/dev/null`, `for`, `awk`, `node`, an unquoted glob\n(`src/*.ts`; use `--include='*.ts'`), or a pipe into `sed` (use `| head -n M | tail -n K`). When a call answers that\nthe tool budget is spent, stop and answer.",
      CALLS("one", "When a call answers that the tool budget is spent, stop and answer."),
    ],
  ],
};

/** `source` (code-review's text of `file`) with the file's replacements applied; throws naming an old passage that
 *  does not occur exactly once. */
export function replaced(file, source) {
  let text = source;
  for (const [i, [old, next]] of (REPLACED[file] ?? []).entries()) {
    const at = text.indexOf(old);
    if (at < 0 || text.indexOf(old, at + 1) >= 0) {
      throw new Error(`${file}: replacement ${i} expects its old passage exactly once in code-review's file, and it occurs ${at < 0 ? "nowhere" : "more than once"}: ${JSON.stringify(old.slice(0, 80))}...`);
    }
    text = text.slice(0, at) + next + text.slice(at + old.length);
  }
  return text;
}

/** The sibling's expected bytes of each shared and replaced file, from code-review's files on disk. */
export function expectedFiles(source = SOURCE) {
  const out = {};
  for (const file of SHARED) out[file] = readFileSync(source + file);
  for (const file of Object.keys(REPLACED)) out[file] = Buffer.from(replaced(file, readFileSync(source + file, "utf8")));
  return out;
}

/** Each sibling file that differs from its expected bytes. */
export function differences(sibling = SIBLING, source = SOURCE) {
  const problems = [];
  for (const [file, bytes] of Object.entries(expectedFiles(source))) {
    let have;
    try {
      have = readFileSync(sibling + file);
    } catch {
      problems.push(`${file}: missing in code-review-composio`);
      continue;
    }
    if (!have.equals(bytes)) problems.push(`${file}: differs from code-review's${SHARED.includes(file) ? "" : " after this script's replacements"}`);
  }
  return problems;
}

if (isMain(import.meta)) {
  if (process.argv.includes("--write")) {
    for (const [file, bytes] of Object.entries(expectedFiles())) writeFileSync(SIBLING + file, bytes);
    console.log(`wrote ${Object.keys(expectedFiles()).length} files of code-review-composio`);
  } else {
    const problems = differences();
    for (const problem of problems) console.error(problem);
    process.exit(problems.length ? 1 : 0);
  }
}
