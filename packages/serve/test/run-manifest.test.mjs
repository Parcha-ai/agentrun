// A run is told of the files given to it: its first message names each file it finds in work/inputs/ (run-manifest.ts),
// so "summarize the attached file" finds the file, on pi, claude-agent and codex alike, through the API.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { filesLine, MANIFEST_ENTRIES, sizeOf } from "../dist/run-manifest.js";
import { agent, follow, scratch, serve } from "./support.mjs";

const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;

/** A ready upload of `bytes` at `path`. */
async function upload(server, path, bytes) {
  const made = await server.api("POST", "/files", { path, size_bytes: bytes.length });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  // `upload.url` is relative to /v2.
  const sent = await fetch(`${server.baseUrl}${made.body.upload.url}`, { method: "PUT", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/octet-stream" }, body: bytes });
  const ready = await sent.json();
  assert.equal(sent.status, 200, JSON.stringify(ready));
  return ready.file_id;
}

/** A run of `agentId` with `input` and `fileIds`, followed to its end: its answer and its user messages, as the
 *  timeline has them (what its harness was sent). */
async function run(api, agentId, content, fileIds) {
  const started = await api("POST", `/agents/${agentId}/runs`, { input: { content }, ...(fileIds ? { file_ids: fileIds } : {}) });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const { rows } = await follow(api, started.body.run_id, ["completed"], { deadlineMs: 55_000 });
  const answer = (await api("GET", `/runs/${started.body.run_id}`)).body.result?.final_answer;
  return { answer, said: rows.filter((row) => row.kind === "user_message").map((row) => row.text) };
}

test("a run with file_ids is told of its file in its first message, and summarizes it; one without is sent its input as it is", { timeout: 120_000 }, async (t) => {
  // A model that reads the first file its first message names, then answers with what it read.
  const reader = join(await scratch(t), "faux-reader.mjs");
  await writeFile(reader, `const textOf = (m) => (typeof m?.content === "string" ? m.content : (m?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(""));
export default function reply(context, faux) {
  const last = context.messages.at(-1);
  if (last?.role === "toolResult") return faux.message(\`Summary: \${textOf(last)}\`);
  const first = textOf(context.messages.find((m) => m.role === "user"));
  const named = /Files for this run: (\\S+) \\(/.exec(first)?.[1];
  return named ? faux.message(faux.toolCall("read", { path: named }), { stopReason: "toolUse" }) : faux.message("I see no attached file.");
}
`);
  const server = await serve(t, { faux: reader });
  const { api } = server;
  const notes = Buffer.from("The tide turns at six, twice.\n");
  const id = await upload(server, "notes.txt", notes);
  assert.equal((await api("POST", "/agents", agent("summarizer", { tools: ["read"] }))).status, 201);

  const told = await run(api, "summarizer", "Summarize the attached file.", [id]);
  assert.deepEqual(told.said, [`Summarize the attached file.\n\nFiles for this run: inputs/notes.txt (${notes.length} B).`]);
  assert.equal(told.answer, `Summary: ${notes.toString().trim()}`);

  const plain = await run(api, "summarizer", "Summarize the attached file.");
  assert.deepEqual(plain.said, ["Summarize the attached file."], "no files, no line");
  assert.equal(plain.answer, "I see no attached file.");
});

for (const harness of ["claude-agent", "codex"]) {
  test(`a ${harness} run's first message names its files too`, { timeout: 90_000 }, async (t) => {
    const server = await serve(t, { fauxHarness: FAUX_HARNESS });
    const { api } = server;
    const ids = [await upload(server, "a.md", Buffer.from("alpha")), await upload(server, "docs/b.csv", Buffer.alloc(1536, 120))];
    assert.equal((await api("POST", "/agents", agent(`on-${harness}`, { harness, tools: ["read"] }))).status, 201);
    const { said } = await run(api, `on-${harness}`, "Look at these.", ids);
    assert.deepEqual(said, ["Look at these.\n\nFiles for this run: inputs/a.md (5 B), inputs/docs/b.csv (1.5 KB)."]);
  });
}

test("the line names at most MANIFEST_ENTRIES files, then counts the rest; sizes read as a person reads them; a control character never breaks it", () => {
  const files = Array.from({ length: MANIFEST_ENTRIES + 5 }, (_, i) => ({ path: `inputs/f${String(i).padStart(2, "0")}.txt`, size: i }));
  const line = filesLine("Files for this run", files);
  assert.equal(line.split(", inputs/").length, MANIFEST_ENTRIES);
  assert.ok(line.startsWith("Files for this run: inputs/f00.txt (0 B), inputs/f01.txt (1 B), "), line);
  assert.ok(line.endsWith(`inputs/f${MANIFEST_ENTRIES - 1}.txt (${MANIFEST_ENTRIES - 1} B), and 5 more.`), line);
  assert.equal(filesLine("Files for this run", []), undefined);
  assert.equal(filesLine("Files", [{ path: "inputs/a\nb\u0007.txt", size: 3 }]), "Files: inputs/a?b?.txt (3 B).");
  assert.deepEqual([0, 1023, 1024, 1536, 1024 * 1024, 5 * 1024 * 1024 + 1].map(sizeOf), ["0 B", "1023 B", "1.0 KB", "1.5 KB", "1.0 MB", "5.0 MB"]);
});
