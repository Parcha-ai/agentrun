// One process of the kill test in judge.test.mjs: the lead calls a code-mode tool whose script asks two judgments, one
// image each, on the SQLite file the parent names. With MODE=first the process writes `.cut` in the workspace when Jev is
// asked for the second (the first filed and told) and waits there for the parent's SIGKILL; with MODE=second it reopens
// the same file, the cut call runs again, and it prints what the tool returned.
// env: DB CWD OUT LEDGER MODE=first|second
import fs from "node:fs";
import path from "node:path";
import { createVisionExtension } from "@parcha/pi-vision/durable";
import { fakeJev } from "../support/jev.mjs";
import { codeTool } from "./code-tool.mjs";
import { ctx, open, transcript } from "./rig.mjs";

const { DB, CWD, OUT, LEDGER, MODE } = process.env;
const log = (file, row) => fs.appendFileSync(path.join(OUT, file), `${JSON.stringify(row)}\n`);
const fake = fakeJev({ ledgerPath: LEDGER });
const judge = async (params) => {
  if (MODE === "first" && fake.requests.length === 1) {
    fs.writeFileSync(path.join(CWD, ".cut"), "");
    // A timer keeps the process alive until the parent's SIGKILL, so it never exits on its own.
    await new Promise(() => setInterval(() => {}, 60_000));
  }
  return fake.judge(params);
};
const vision = createVisionExtension({
  jev: { judge },
  evidence: { file: async (label, record) => ({ path: `${label}/${record.facts.key.slice(0, 16)}.md` }) },
  onLook: (look) => log("looks.jsonl", { by: MODE, key: look.record.facts.key, kept: look.kept ?? false }),
  scope: () => ({ label: "vision", deriveDir: ".vision" }),
});
const noul = (file) => `await vision.judge({ paths: ["${file}"], questions: { blank: { type: "noul", instructions: "Is \`images[0].image\` blank?" } } })`;
const code = `return [${noul("p1.png")}, ${noul("p2.png")}];`;
const { harness, root } = await open({ extensions: [codeTool(vision), vision.extension], rounds: [[["code", { code }]]], cwd: CWD, db: DB });
const settled = await (await root.submit({ type: "input", content: "go", requestId: "go-1" }, ctx)).wait(ctx);
process.stdout.write(`RESULT ${JSON.stringify({ settled: settled.status, results: await transcript(root) })}\n`);
await harness.close(ctx);
process.exit(0);
