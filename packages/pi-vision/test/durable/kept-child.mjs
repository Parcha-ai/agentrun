// One process of the kill tests in see-kept.test.mjs: a code-mode host whose tool is not replay-safe (REPLAY=unsafe), so
// pi never runs a cut call again and the lead asks anew, or one whose tool is (REPLAY=safe), so pi runs the cut call
// again. The script asks vision.see about two windows of a video, one window a request. With MODE=first the host's sink
// holds the second filing (the eyes have answered the second window) and the process writes `.cut` and waits for the
// parent's SIGKILL; with MODE=second it reopens the same file, the lead calls the tool again with the same script, and it
// prints what the tool returned. TASK_MEMOS=first keeps the first process's memos on its task.
// env: DB CWD OUT LEDGER MODE=first|second REPLAY=unsafe|safe TASK_MEMOS
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_LIMITS } from "@parcha/pi-vision";
import { createVisionExtension } from "@parcha/pi-vision/durable";
import { fakeEyes } from "@parcha/pi-vision/testing";
import { codeTool } from "./code-tool.mjs";
import { ctx, open, transcript } from "./rig.mjs";

const { DB, CWD, OUT, LEDGER, MODE, REPLAY = "unsafe", TASK_MEMOS } = process.env;
const log = (file, row) => fs.appendFileSync(path.join(OUT, file), `${JSON.stringify(row)}\n`);
let filings = 0;
const vision = createVisionExtension({
  eyes: fakeEyes({ ledgerPath: LEDGER, limits: { ...DEFAULT_LIMITS, imagesPerCall: 1 }, answers: [(request) => `saw ${request.parts.find((p) => p.type === "image").fragment}`] }),
  evidence: {
    file: async (label, record) => {
      if (MODE === "first" && ++filings === 2) {
        fs.writeFileSync(path.join(CWD, ".cut"), "");
        // A timer keeps the process alive until the parent's SIGKILL, so it never exits on its own.
        await new Promise(() => setInterval(() => {}, 60_000));
      }
      return { path: `${label}/${record.facts.key.slice(0, 16)}.md` };
    },
  },
  onLook: (look) => log("looks.jsonl", { by: MODE, key: look.record.facts.key, source: look.source, kept: look.kept ?? false, costUsd: look.costUsd }),
  scope: () => ({ label: "vision", deriveDir: ".vision" }),
});
const code = `return await vision.see({ ask: "What happens?", paths: ["w1.png", "w2.png"], fragments: ["talk.mp4#t=0,30", "talk.mp4#t=30,60"] });`;
const { harness, root } = await open({ extensions: [codeTool(vision, { replay: REPLAY, taskMemos: TASK_MEMOS === MODE }), vision.extension], rounds: [[["code", { code }]], [["code", { code }]]], cwd: CWD, db: DB });
const settled = await (await root.submit({ type: "input", content: "go", requestId: "go-1" }, ctx)).wait(ctx);
process.stdout.write(`RESULT ${JSON.stringify({ settled: settled.status, results: await transcript(root) })}\n`);
await harness.close(ctx);
process.exit(0);
