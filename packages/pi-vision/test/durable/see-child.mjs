// One process of the kill test in see.test.mjs: the lead calls a code-mode tool whose script asks vision.see about two
// files, one image a request, on the SQLite file the parent names. With MODE=first the process writes `.cut` in the
// workspace when the eyes are asked for the second look (the first filed and told) and waits there for the parent's
// SIGKILL; with MODE=second it reopens the same file, the cut call runs again, and it prints what the tool returned.
// env: DB CWD OUT LEDGER MODE=first|second
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_LIMITS } from "@parcha/pi-vision";
import { createVisionExtension } from "@parcha/pi-vision/durable";
import { fakeEyes } from "@parcha/pi-vision/testing";
import { codeTool } from "./code-tool.mjs";
import { ctx, open, transcript } from "./rig.mjs";

const { DB, CWD, OUT, LEDGER, MODE } = process.env;
const log = (file, row) => fs.appendFileSync(path.join(OUT, file), `${JSON.stringify(row)}\n`);
const fake = fakeEyes({ ledgerPath: LEDGER, limits: { ...DEFAULT_LIMITS, imagesPerCall: 1 }, answers: [(request) => `saw ${request.parts.find((p) => p.type === "image").fragment}`] });
const eyes = {
  ...fake,
  see: async (request, signal) => {
    if (MODE === "first" && fake.ledger.length === 1) {
      fs.writeFileSync(path.join(CWD, ".cut"), "");
      // A timer keeps the process alive until the parent's SIGKILL, so it never exits on its own.
      await new Promise(() => setInterval(() => {}, 60_000));
    }
    return fake.see(request, signal);
  },
};
const vision = createVisionExtension({
  eyes,
  evidence: { file: async (label, record) => { log("filed.jsonl", { key: record.facts.key, kept: record.facts.kept ?? false }); return { path: `${label}/${record.facts.key.slice(0, 16)}.md` }; } },
  onLook: (look) => log("looks.jsonl", { by: MODE, key: look.record.facts.key, kept: look.kept ?? false, costUsd: look.costUsd }),
  scope: () => ({ label: "vision", deriveDir: ".vision" }),
});
const code = `return await vision.see({ ask: "What does each say?", paths: ["p1.png", "p2.png"] });`;
const { harness, root } = await open({ extensions: [codeTool(vision), vision.extension], rounds: [[["code", { code }]]], cwd: CWD, db: DB });
const settled = await (await root.submit({ type: "input", content: "go", requestId: "go-1" }, ctx)).wait(ctx);
process.stdout.write(`RESULT ${JSON.stringify({ settled: settled.status, results: await transcript(root) })}\n`);
await harness.close(ctx);
process.exit(0);
