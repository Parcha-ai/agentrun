// The job profile packs are for: an agent asked for a deliverable at an effort, with no pack named. `output` alone loads
// the shipped default pack, on every harness: its effort row's skill and the output's writer, delivered as the harness
// takes skills (written out on pi, loaded natively on claude-agent and codex) under one mandate, the run's effort as
// the session's thinking level, and the deliverable in the file the pack names, which GET /runs/{id}/output names and
// the files routes serve. Faux model for pi, faux harness for the others: no key, no network.
import assert from "node:assert/strict";
import { test } from "node:test";
import { SLIDES } from "./fixtures/faux-harness.mjs";
import { agent, follow, serve } from "./support.mjs";

const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;

/** What the default pack pins for a high-effort slides run. */
const PINNED = { name: "default", effort: "high", skills: ["effort-high", "slides"], output: { type: "slides", file: "slides.html", skills: ["slides"] } };
/** The mandate after the instructions: one wording on every harness. */
const MANDATE = [
  "This run's profile (default) uses these skills, in this order: first `effort-high`, then `slides`. Each is listed to you as a skill or written out below.",
  "Use `slides`, the writer for this run's output (slides), right before you write the deliverable.",
  "Write the deliverable to `slides.html` in your workspace.",
].join("\n");
/** A line of each skill's body: in the system prompt only where the harness has it written out. */
const BODIES = ["# High effort: the full research loop", "Build the run's deck as **one self-contained HTML file, `slides.html`**"];
/** The skills each harness's adapter loads itself: none on pi, which has them written out. */
const NATIVE = { pi: "none", "claude-agent": "effort-high, slides", codex: "effort-high, slides" };

test("a job at high effort for slides, with no pack named, gets the default pack on pi, claude-agent and codex: its skills as each harness takes them, one mandate, its effort's thinking, and slides.html named by GET /runs/{id}/output and served", { timeout: 240_000 }, async (t) => {
  const { api } = await serve(t, { fauxHarness: FAUX_HARNESS });
  for (const [harness, native] of Object.entries(NATIVE)) {
    const id = `deck-${harness}`;
    // The revision thinks low and names no skill: the pack brings both.
    const made = await api("POST", "/agents", agent(id, { harness, instructions: "Make the slides, then say your system.", tools: ["write"], thinking: "low" }));
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const run = await api("POST", `/agents/${id}/runs`, { input: { content: "A deck on the quarter." }, effort: "high", output: "slides" });
    assert.equal(run.status, 202, `${harness}: ${JSON.stringify(run.body)}`);
    const runId = run.body.run_id;
    assert.deepEqual(run.body.profile, PINNED, `${harness}: the default pack, resolved and pinned`);
    await follow(api, runId, ["completed"], { deadlineMs: 55_000 });
    // The session says its thinking level, the skills its adapter was given to load itself, then its system prompt.
    const said = (await api("GET", `/runs/${runId}`)).body.result?.final_answer ?? "";
    const [thinking, given] = said.split("\n");
    assert.equal(thinking, "Thinking high.", `${harness}: the run's effort, over the revision's thinking`);
    assert.equal(given, `Native: ${native}`, `${harness}: the skills its adapter loads itself`);
    assert.ok(said.includes(`Make the slides, then say your system.\n\n${MANDATE}`), `${harness}: the mandate right after the instructions: ${said.slice(0, 2000)}`);
    for (const line of BODIES) assert.equal(said.includes(line), harness === "pi", `${harness}: ${line} written out only where the harness loads no skill itself`);
    // The deck the model wrote with the write tool: named by the output route, served and listed by the files routes. An
    // HTML output's url is a download, to open locally: the server never runs a run's scripts on its own origin.
    const output = await api("GET", `/runs/${runId}/output`);
    assert.equal(output.status, 200, JSON.stringify(output.body));
    assert.deepEqual(output.body, { run_id: runId, type: "slides", path: "slides.html", url: `/v2/runs/${runId}/files/slides.html?download=1` }, harness);
    const file = await api("GET", output.body.url.replace(/^\/v2/, ""));
    assert.equal(file.status, 200, harness);
    assert.equal(file.headers.get("content-type"), "text/html; charset=utf-8", harness);
    assert.equal(file.headers.get("content-disposition"), 'attachment; filename="slides.html"', `${harness}: a download`);
    assert.equal(file.body, SLIDES, `${harness}: the url serves the deck`);
    const listed = (await api("GET", `/runs/${runId}/files`)).body.files.find((entry) => entry.path === "slides.html");
    assert.deepEqual([listed?.size_bytes, listed?.content_type], [Buffer.byteLength(SLIDES), "text/html; charset=utf-8"], `${harness}: listed with its size and type`);
  }
});
