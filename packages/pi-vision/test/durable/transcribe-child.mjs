// One process of the kill test in transcribe.test.mjs: the lead calls a code-mode tool whose script transcribes two
// files, on the SQLite file the parent names. With MODE=first the process writes `.cut` in the workspace when the second
// file is sent (the first filed and told) and waits there for the parent's SIGKILL; with MODE=second it reopens the same
// file and prints what the tool returned. The tool is not replay-safe, as a code-mode host's is not: the cut call stays
// cut and the lead calls the tool again with the same script.
// env: DB CWD OUT LEDGER MODE=first|second
import fs from "node:fs";
import path from "node:path";
import { createVisionExtension } from "@parcha/pi-vision/durable";
import { fakeTranscriptionFetch, SENTINEL_TRANSCRIBER_KEY } from "@parcha/pi-vision/testing";
import { openAiTranscriber } from "@parcha/pi-vision/transcribers";
import { codeTool } from "./code-tool.mjs";
import { ctx, open, transcript } from "./rig.mjs";

const { DB, CWD, OUT, LEDGER, MODE } = process.env;
const log = (file, row) => fs.appendFileSync(path.join(OUT, file), `${JSON.stringify(row)}\n`);
const fake = fakeTranscriptionFetch("openai", { words: [{ text: "Tranquility", start: 3, end: 3.6 }], durationS: 30 });
let sent = 0;
const fetch = async (url, init) => {
  sent += 1;
  fs.appendFileSync(LEDGER, `${JSON.stringify({ by: MODE, file: init.body.get("file").name })}\n`);
  if (MODE === "first" && sent === 2) {
    fs.writeFileSync(path.join(CWD, ".cut"), "");
    // A timer keeps the process alive until the parent's SIGKILL, so it never exits on its own.
    await new Promise(() => setInterval(() => {}, 60_000));
  }
  return fake.fetch(url, init);
};
const vision = createVisionExtension({
  transcriber: openAiTranscriber({ apiKey: () => SENTINEL_TRANSCRIBER_KEY, usdPerMinute: 0.006, fetch }),
  evidence: { file: async (label, record) => ({ path: `${label}/${record.facts.key.slice(0, 16)}.md` }) },
  onLook: (look) => log("looks.jsonl", { by: MODE, key: look.record.facts.key, kept: look.kept ?? false }),
  scope: () => ({ label: "vision", deriveDir: ".vision" }),
});
const code = `return [await vision.transcribe({ path: "a.mp3" }), await vision.transcribe({ path: "b.mp3" })].map((t) => ({ kept: t.kept, costUsd: t.costUsd }));`;
const { harness, root } = await open({ extensions: [codeTool(vision, { replay: "unsafe" }), vision.extension], rounds: [[["code", { code }]], [["code", { code }]]], cwd: CWD, db: DB });
const settled = await (await root.submit({ type: "input", content: "go", requestId: "go-1" }, ctx)).wait(ctx);
process.stdout.write(`RESULT ${JSON.stringify({ settled: settled.status, results: await transcript(root) })}\n`);
await harness.close(ctx);
process.exit(0);
