// The learning routes (serve's own, under /v2): a run's learning state, its memo and its diff, approve and refuse; an
// agent's learning at main, one file of it, its log of merges, and retire. Every read comes from the bare repository
// and passes through the host's secrets at read time. The faux model; a faux screen and a scripted judge.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { learningId, renderLearning } from "@parcha/pi-agent-learn";
import { local, openRepo } from "@parcha/pi-git-remote";
import { readRunState, writeRunState } from "../dist/learning.js";
import { agent, client, follow, scratch, serve, withEnv } from "./support.mjs";

/** The routes module, or nothing before it exists. */
const routes = await import("../dist/learning-routes.js").catch(() => ({}));
const RATE_LIMIT = "The state registry rate-limits at 1 request a second.";
const SCREEN = { classify: async () => 0.05, threshold: 0.6 };
const judge = async (params) => {
  const [q] = Object.keys(params.questions);
  return { answers: { [q]: { type: "noul", noul: { general: 0.95 }[q] ?? 0.02 } }, model: "fake", usage: null, cost_usd: 0.001 };
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const bareOf = (data, id) => join(data, "agents", id, "learning.git");
const git = (dir, ...args) => execFileSync("git", ["--git-dir", dir, ...args], { encoding: "utf8" }).trim();
const show = (dir, ref, path) => { try { return git(dir, "show", `${ref}:${path}`); } catch { return undefined; } };

async function stateOf(data, agentId, runId, pred, deadlineMs = 30_000) {
  for (const end = Date.now() + deadlineMs; ; await sleep(50)) {
    const state = await readRunState(data, agentId, runId);
    if (state && pred(state)) return state;
    assert.ok(Date.now() < end, `the run ${runId} reached its state; last ${JSON.stringify(state)}`);
  }
}
const reviewed = (s) => s.state !== "proposed" && (s.state !== "merged" || s.pruned === true);

/** A run of `id` that notes `text` (RATE_LIMIT by default), ended and reviewed. */
async function learned(api, data, id, text) {
  const content = text === undefined ? "Learn the rate limit." : `Learn the note: ${text}`;
  const { body: run } = await api("POST", `/agents/${id}/runs`, { input: { content } });
  await follow(api, run.run_id, ["completed"]);
  await stateOf(data, id, run.run_id, reviewed);
  return run.run_id;
}

/** Adds `files` to run `runId`'s branch of agent `id`, as a commit of the run's, and records the new tip. */
async function plant(t, data, id, runId, files) {
  const repo = await openRepo({ dir: join(await scratch(t), "planter"), remote: local(bareOf(data, id)) });
  const made = await repo.commitTo(`runs/${runId}`, { files, message: "plant", trailers: { "Run-Id": ["plant", runId] } });
  await repo.push(made.sha, `runs/${runId}`);
  await writeRunState(data, id, runId, { ...(await readRunState(data, id, runId)), sha: made.sha });
}

test("the learning routes, their operations and their roles are one to one, every operation is this server's own, and every role is member", () => {
  const { LEARNING_ROUTES, LEARNING_OPENAPI, LEARNING_ROLES } = routes;
  assert.ok(Array.isArray(LEARNING_ROUTES), "the routes are exported");
  const names = LEARNING_ROUTES.map((r) => r.name).sort();
  assert.equal(names.length, 9);
  const ops = Object.values(LEARNING_OPENAPI).flatMap((methods) => Object.values(methods));
  assert.deepEqual(ops.map((op) => op.operationId).sort(), names, "one operation per route");
  assert.ok(ops.every((op) => op["x-agentrun-serve"] === true), "each marked x-agentrun-serve");
  assert.deepEqual(Object.keys(LEARNING_ROLES).sort(), names, "one role per route");
  assert.ok(Object.values(LEARNING_ROLES).every((role) => role === "member"), "reads, approve, refuse and retire are member");
});

test("a run's learning: its state as it is reviewed, off for an agent that does not learn, 404 for no such run, 401 with no credential", async (t) => {
  const { api, data, baseUrl } = await serve(t, { learning: { screen: SCREEN, judge } });
  await api("POST", "/agents", agent("calc", { learning: "auto" }));
  await api("POST", "/agents", agent("plain"));
  const runId = await learned(api, data, "calc");
  const view = await api("GET", `/runs/${runId}/learning`);
  assert.equal(view.status, 200, JSON.stringify(view.body));
  assert.equal(view.body.state, "merged");
  assert.equal(view.body.merge, git(bareOf(data, "calc"), "rev-parse", "main"));
  assert.ok(view.body.verdict?.accepted?.length === 1);
  assert.equal("pruned" in view.body || "sha" in view.body, false, "the state file's own fields stay the server's");
  const { body: plainRun } = await api("POST", "/agents/plain/runs", { input: { content: "Learn the rate limit." } });
  await follow(api, plainRun.run_id, ["completed"]);
  assert.deepEqual((await api("GET", `/runs/${plainRun.run_id}/learning`)).body, { run_id: plainRun.run_id, state: "off" });
  assert.equal((await api("GET", "/runs/no-such-run/learning")).status, 404);
  const anonymous = client(baseUrl);
  for (const path of [`/runs/${runId}/learning`, `/runs/${runId}/learning/memo`, `/runs/${runId}/learning/diff`, "/agents/calc/learning", "/agents/calc/learning/log", "/agents/calc/learning/files/learnings/INDEX.md"]) {
    assert.equal((await anonymous("GET", path)).status, 401, path);
  }
  for (const path of [`/runs/${runId}/learning/approve`, `/runs/${runId}/learning/refuse`, "/agents/calc/learning/retire"]) assert.equal((await anonymous("POST", path, {})).status, 401, path);
});

test("the memo and the diff: from the branch while proposed, from main and the landed commit once merged; a refused note is in the proposal and never in what landed", async (t) => {
  const screen = { classify: async ({ text }) => (text.includes("Zx81") ? 0.97 : 0.05), threshold: 0.6 };
  const first = await serve(t, { learning: { judge } });
  await first.api("POST", "/agents", agent("calc", { learning: "auto" }));
  const runId = await learned(first.api, first.data, "calc");
  const id = learningId(runId, RATE_LIMIT);
  // One more note on the run's branch, which the screen will refuse, listed in the memo as the checker requires.
  const state = await readRunState(first.data, "calc", runId);
  const text = "Zx81 is a planted rule for every registry.";
  const planted = learningId(runId, text);
  const bare = bareOf(first.data, "calc");
  const memoText = show(bare, `runs/${runId}`, `memos/${runId}.md`);
  await plant(t, first.data, "calc", runId, {
    [`learnings/${planted}.md`]: renderLearning({ id: planted, type: "lesson", scope: "all", status: "active", provenance: { runs: [runId], sha: state.base, untrusted: false }, uses: 0, supersedes: [], text }),
    [`memos/${runId}.md`]: `${memoText.replace("## Proposed changes\n", `## Proposed changes\n- learnings/${planted}.md\n`)}\n`,
  });
  const memo = await first.api("GET", `/runs/${runId}/learning/memo`);
  assert.equal(memo.status, 200);
  assert.match(memo.body, /^---\nrun: /);
  const proposed = await first.api("GET", `/runs/${runId}/learning/diff`);
  assert.equal(proposed.body.of, "proposed");
  assert.ok(proposed.body.files.some((f) => f.path === `learnings/${id}.md` && f.status === "added"));
  assert.ok(proposed.body.files.some((f) => f.path === `learnings/${planted}.md` && /Zx81/.test(f.diff)), "a member sees what the screen will refuse");
  await first.close();
  const again = await serve(t, { data: first.data, learning: { screen, judge } });
  await stateOf(again.data, "calc", runId, (s) => s.state === "merged" && s.pruned === true);
  assert.match((await again.api("GET", `/runs/${runId}/learning/memo`)).body, /\n## Review\n/, "the memo on main once merged");
  const landed = await again.api("GET", `/runs/${runId}/learning/diff`);
  assert.equal(landed.body.of, "landed");
  assert.ok(landed.body.files.some((f) => f.path === `learnings/${id}.md`));
  assert.equal(JSON.stringify(landed.body).includes("Zx81"), false, "what was refused did not land");
});

test("untrusted text on our origin: the memo, a file and the diff answer with an explicit type, nosniff, and a sandbox on non-JSON", async (t) => {
  const { api, data } = await serve(t, { learning: { screen: SCREEN, judge } });
  await api("POST", "/agents", agent("calc", { learning: "auto" }));
  const runId = await learned(api, data, "calc");
  const memo = await api("GET", `/runs/${runId}/learning/memo`);
  assert.equal(memo.headers.get("content-type"), "text/markdown; charset=utf-8");
  assert.equal(memo.headers.get("x-content-type-options"), "nosniff");
  assert.equal(memo.headers.get("content-security-policy"), "sandbox");
  const note = await api("GET", `/agents/calc/learning/files/learnings/${learningId(runId, RATE_LIMIT)}.md`);
  assert.equal(note.status, 200);
  assert.equal(note.headers.get("content-type"), "text/markdown; charset=utf-8");
  assert.equal(note.headers.get("content-security-policy"), "sandbox");
  assert.equal(note.headers.get("x-content-type-options"), "nosniff");
  const json = await api("GET", "/agents/calc/learning/files/agent.json");
  assert.equal(json.headers.get("content-type"), "application/json; charset=utf-8");
  const diff = await api("GET", `/runs/${runId}/learning/diff`);
  assert.equal(diff.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(diff.headers.get("x-content-type-options"), "nosniff");
});

test("approve and refuse over HTTP: the principal is the credential's, never the body's; 409 when nothing waits; 422 on a reason out of shape", async (t) => {
  const { api, data } = await serve(t, { learning: { screen: SCREEN, judge } });
  await api("POST", "/agents", agent("calc", { learning: "approve" }));
  const one = await learned(api, data, "calc");
  const approved = await api("POST", `/runs/${one}/learning/approve`, { decided_by: "mallory" });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.status, "landed");
  assert.equal((await readRunState(data, "calc", one)).decided_by, "token", "the server's token decided");
  assert.equal((await api("POST", `/runs/${one}/learning/approve`, {})).status, 409, "nothing waits any more");
  const two = await learned(api, data, "calc");
  const bad = await api("POST", `/runs/${two}/learning/refuse`, { reason: "two\nlines" });
  assert.deepEqual([bad.status, bad.body.error?.fields?.[0]?.field], [422, "reason"]);
  const refused = await api("POST", `/runs/${two}/learning/refuse`, { reason: "Too close to one case." });
  assert.equal(refused.body.status, "landed");
  assert.equal((await api("GET", `/runs/${two}/learning`)).body.decision, "refuse");
});

test("an agent's learning at main, one file, and the log of merges: newest first, paged, limit at most 100", async (t) => {
  const { api, data } = await serve(t, { learning: { screen: SCREEN, judge } });
  await api("POST", "/agents", agent("calc", { learning: "auto" }));
  const one = await learned(api, data, "calc");
  const two = await learned(api, data, "calc", "A filing's date is its acceptance date, not the date it was signed.");
  const view = await api("GET", "/agents/calc/learning");
  assert.equal(view.status, 200, JSON.stringify(view.body));
  assert.equal(view.body.main, git(bareOf(data, "calc"), "rev-parse", "main"));
  assert.equal(view.body.mode, "auto");
  assert.deepEqual(view.body.notes.map((n) => n.id).sort(), [learningId(one, RATE_LIMIT), learningId(two, "A filing's date is its acceptance date, not the date it was signed.")].sort());
  assert.ok(view.body.notes.every((n) => n.status === "active" && typeof n.text === "string"));
  for (const bad of ["..%2Fx", "%2Fetc%2Fpasswd", "a%00b", "learnings%2F..%2F..%2Fx"]) assert.equal((await api("GET", `/agents/calc/learning/files/${bad}`)).status, 422, bad);
  assert.equal((await api("GET", "/agents/calc/learning/files/learnings/L-ffffffffffff.md")).status, 404);
  const log = await api("GET", "/agents/calc/learning/log");
  assert.deepEqual(log.body.merges.map((m) => m.run), [two, one], "newest first");
  assert.deepEqual(Object.keys(log.body.merges[0]).sort(), ["at", "run", "sha", "subject"], "no count read out of a commit's words: the run's verdict has them");
  const page = await api("GET", "/agents/calc/learning/log?limit=1");
  assert.deepEqual(page.body.merges.map((m) => m.run), [two]);
  assert.deepEqual((await api("GET", `/agents/calc/learning/log?limit=1&cursor=${encodeURIComponent(page.body.next_cursor)}`)).body.merges.map((m) => m.run), [one]);
  assert.equal((await api("GET", "/agents/calc/learning/log?limit=101")).status, 422, "the limit is at most 100");
  assert.equal((await api("GET", "/agents/plain-no/learning")).status, 404);
});

test("retire is a member's act: the note is retired on main and leaves the index, a second retire changes nothing, a reason out of shape is 422", async (t) => {
  const { api, data } = await serve(t, { learning: { screen: SCREEN, judge } });
  await api("POST", "/agents", agent("calc", { learning: "auto" }));
  const runId = await learned(api, data, "calc");
  const id = learningId(runId, RATE_LIMIT);
  assert.equal((await api("POST", "/agents/calc/learning/retire", { id, reason: "two\nlines" })).status, 422);
  const retired = await api("POST", "/agents/calc/learning/retire", { id, reason: "The registry dropped its limit." });
  assert.equal(retired.status, 200, JSON.stringify(retired.body));
  assert.equal(retired.body.status, "retired");
  assert.match(show(bareOf(data, "calc"), "main", `learnings/${id}.md`), /status: retired/);
  assert.doesNotMatch(show(bareOf(data, "calc"), "main", "learnings/INDEX.md") ?? "", new RegExp(id));
  assert.equal((await api("POST", "/agents/calc/learning/retire", { id, reason: "Again." })).body.status, "unchanged");
});

test("the diff is bounded: 64 KB a file, 200 files, and 1 MB in all, each marked truncated", async (t) => {
  const { api, data } = await serve(t, { learning: { judge } });
  await api("POST", "/agents", agent("calc", { learning: "auto" }));
  const many = await learned(api, data, "calc");
  const tiny = {};
  for (let i = 0; i < 205; i++) tiny[`notes/t${String(i).padStart(3, "0")}.md`] = `note ${i}\n`;
  await plant(t, data, "calc", many, tiny);
  const counted = await api("GET", `/runs/${many}/learning/diff`);
  assert.equal(counted.status, 200);
  assert.deepEqual([counted.body.files.length, counted.body.truncated], [200, true], "200 files at most");
  const heavy = await learned(api, data, "calc");
  const big = { "notes/big.md": `${"x".repeat(99)}\n`.repeat(1000) };
  for (let i = 0; i < 20; i++) big[`notes/h${String(i).padStart(2, "0")}.md`] = `${"y".repeat(99)}\n`.repeat(600);
  await plant(t, data, "calc", heavy, big);
  const sized = await api("GET", `/runs/${heavy}/learning/diff`);
  assert.equal(sized.body.truncated, true);
  assert.ok(sized.body.files.length < 21, `${sized.body.files.length} files: cut at 1 MB`);
  assert.ok(Buffer.byteLength(JSON.stringify(sized.body)) < 1.1 * 1024 * 1024, "about 1 MB in all");
  const one = sized.body.files.find((f) => f.path === "notes/big.md");
  assert.ok(one && one.truncated === true && Buffer.byteLength(one.diff ?? "") <= 64 * 1024, "64 KB a file");
});

test("reads are from the bare repository: 20 log and diff reads at once all answer", async (t) => {
  const { api, data } = await serve(t, { learning: { judge } });
  await api("POST", "/agents", agent("calc", { learning: "auto" }));
  const runId = await learned(api, data, "calc");
  const dir = join(data, "agents", "calc");
  const before = (await readdir(dir)).sort();
  const answers = await Promise.all(Array.from({ length: 20 }, (_, i) => api("GET", i % 2 ? "/agents/calc/learning/log" : `/runs/${runId}/learning/diff`)));
  assert.deepEqual(answers.map((a) => a.status), Array(20).fill(200), JSON.stringify(answers.find((a) => a.status !== 200)?.body));
  assert.deepEqual((await readdir(dir)).sort(), before, "no clone was made to read: the reads are the bare repository's");
});

test("secrets: a note with the door token shows its path and reason only, and the token is in no answer; a value made secret after the proposal is redacted on read", async (t) => {
  const first = await serve(t, { learning: { judge } });
  await first.api("POST", "/agents", agent("calc", { learning: "auto" }));
  const runId = await learned(first.api, first.data, "calc");
  const door = (await readFile(join(first.data, ".door-token"), "utf8")).trim();
  const late = "late-secret-value-7Qp2Lm9x";
  const memoText = show(bareOf(first.data, "calc"), `runs/${runId}`, `memos/${runId}.md`);
  await plant(t, first.data, "calc", runId, { "notes/door.md": `Knock with ${door}.\n`, "notes/late.md": `Ask for ${late} at the desk.\n`, [`memos/${runId}.md`]: `${memoText}\nAsk for ${late} at the desk.\n` });
  const before = await first.api("GET", `/runs/${runId}/learning/diff`);
  assert.equal(before.status, 200, "the diff route answers");
  const doorFile = before.body.files.find((f) => f.path === "notes/door.md");
  assert.deepEqual([doorFile?.withheld, doorFile?.diff], ["secret_value", undefined], "path and reason only");
  assert.ok(JSON.stringify(before.body).includes(late), "control: not yet a secret, so shown");
  for (const path of [`/runs/${runId}/learning`, `/runs/${runId}/learning/memo`, `/runs/${runId}/learning/diff`]) {
    assert.equal(JSON.stringify((await first.api("GET", path)).body).includes(door), false, path);
  }
  await first.close();
  withEnv(t, { DESK_API_KEY: late });
  const again = await serve(t, { data: first.data, learning: { judge } });
  const after = await again.api("GET", `/runs/${runId}/learning/diff`);
  const text = JSON.stringify(after.body);
  assert.equal(text.includes(late), false, "the value is a secret now, and does not come back out");
  assert.equal(after.body.files.find((f) => f.path === "notes/late.md")?.withheld, "secret_value", "a file holding it shows its path and the rule");
  const memo = await again.api("GET", `/runs/${runId}/learning/memo`);
  assert.equal(memo.body.includes(late), false, "nor out of the memo");
  assert.match(memo.body, /Ask for \[redacted\] at the desk\./, "where it reads [redacted]");
});

/** Commits `files` on agent `id`'s main as a curator would, with `message` and `trailers`. */
async function onMain(t, data, id, files, message, trailers = {}) {
  const repo = await openRepo({ dir: join(await scratch(t), "curator"), remote: local(bareOf(data, id)) });
  const made = await repo.commitTo("main", { files, message, trailers });
  await repo.push(made.sha, "main");
  return made.sha;
}

test("the log reads the Curated-Run trailer, never a commit's words: a subject in other words changes nothing but the subject", async (t) => {
  const { api, data } = await serve(t, { learning: { judge } });
  await api("POST", "/agents", agent("calc", { learning: "auto" }));
  await onMain(t, data, "calc", { "memos/run-x.md": "memo\n" }, "Merged what run-x taught: 7 accepted, 2 refused", { "Curated-Run": "run-x" });
  const [entry] = (await api("GET", "/agents/calc/learning/log")).body.merges;
  assert.deepEqual([entry.run, entry.subject], ["run-x", "Merged what run-x taught: 7 accepted, 2 refused"]);
  assert.deepEqual(Object.keys(entry).sort(), ["at", "run", "sha", "subject"], "no count parsed from the words");
});

/** Commits `files` on main in commits of at most 200 paths: a commit writes at most 256. */
async function inChunks(t, data, id, files) {
  const entries = Object.entries(files);
  for (let i = 0; i < entries.length; i += 200) await onMain(t, data, id, Object.fromEntries(entries.slice(i, i + 200)), `curator: files ${i}`);
}

test("the agent's learning is truncated by its notes, not by its other files", async (t) => {
  const { api, data } = await serve(t, { learning: { judge } });
  await api("POST", "/agents", agent("calc", { learning: "auto" }));
  const drafts = {};
  for (let i = 0; i < 600; i++) drafts[`workflows/w${String(i).padStart(3, "0")}/README.md`] = `# w${i}\n`;
  await inChunks(t, data, "calc", drafts);
  const many = await api("GET", "/agents/calc/learning");
  assert.equal(many.status, 200);
  assert.equal(many.body.truncated, undefined, "600 drafts are not 500 notes");
  const notes = {};
  for (let i = 0; i < 501; i++) notes[`learnings/L-${i.toString(16).padStart(12, "0")}.md`] = "not a note\n";
  await inChunks(t, data, "calc", notes);
  const full = await api("GET", "/agents/calc/learning");
  assert.deepEqual([full.body.notes.length, full.body.truncated], [500, true]);
});

test("nothing person-identifying reaches main: approve, refuse and retire by an accounts-shaped principal write its id and never its email", async (t) => {
  const lines = [];
  const principal = () => ({ id: "acct_7f3a91", email: "ana@example.com" });
  const { api, data } = await serve(t, { learning: { screen: SCREEN, judge, principal }, log: (line) => lines.push(line) });
  await api("POST", "/agents", agent("calc", { learning: "approve" }));
  const one = await learned(api, data, "calc");
  assert.equal((await api("POST", `/runs/${one}/learning/approve`, {})).status, 200);
  const two = await learned(api, data, "calc", "A filing's date is its acceptance date, not the date it was signed.");
  assert.equal((await api("POST", `/runs/${two}/learning/refuse`, { reason: "Too close to one case." })).status, 200);
  assert.equal((await readRunState(data, "calc", one)).decided_by, "acct_7f3a91");
  const retired = await api("POST", "/agents/calc/learning/retire", { id: learningId(one, RATE_LIMIT), reason: "The registry dropped its limit." });
  assert.equal(retired.body.status, "retired", JSON.stringify(retired.body));
  const bare = bareOf(data, "calc");
  const history = git(bare, "log", "--format=%B", "main");
  assert.match(history, /acct_7f3a91/, "the retire names the stable account id");
  const everything = git(bare, "rev-list", "--objects", "--all").split("\n").map((line) => git(bare, "cat-file", "-p", line.split(" ")[0])).join("\n");
  assert.equal(everything.includes("ana@example.com"), false, "no email anywhere in the repository");
  assert.ok(lines.some((line) => /learning_retired/.test(line) && /acct_7f3a91/.test(line)), "who retired it is in the log");
});

test("under a held agent store the learning routes answer home_busy within about 3 s: not a 500, not a hang, not a wrong answer", async (t) => {
  const { api, data } = await serve(t, { learning: { screen: SCREEN, judge } });
  await api("POST", "/agents", agent("calc", { learning: "auto" }));
  await api("POST", "/agents", agent("plain"));
  const runId = await learned(api, data, "calc");
  const { body: plainRun } = await api("POST", "/agents/plain/runs", { input: { content: "Learn the rate limit." } });
  await follow(api, plainRun.run_id, ["completed"]);
  const store = new DatabaseSync(join(data, "store.sqlite"), { timeout: 0 });
  store.exec("BEGIN EXCLUSIVE");
  t.after(() => store.isOpen && (store.isTransaction && store.exec("ROLLBACK"), store.close()));
  // A read that needs the store answers home_busy; a run whose learning state is on file needs no store, and answers.
  for (const path of ["/agents/calc/learning", "/agents/calc/learning/log", `/runs/${plainRun.run_id}/learning`]) {
    const started = Date.now();
    const answer = await api("GET", path);
    const took = Date.now() - started;
    assert.deepEqual([answer.status, answer.body?.error?.code], [409, "home_busy"], `${path}: ${JSON.stringify(answer.body).slice(0, 200)}`);
    assert.ok(took < 3_500, `${path} took ${took} ms`);
  }
  const fromFile = await api("GET", `/runs/${runId}/learning`);
  assert.deepEqual([fromFile.status, fromFile.body.state], [200, "merged"], "the run's state is read from its file, not the store");
});
