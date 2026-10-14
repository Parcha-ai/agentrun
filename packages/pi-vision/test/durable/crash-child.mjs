// One process of the crash matrix: a lead whose route takes no images asks `read` a question about a PDF, through the
// adapter and the package's own readers and guard, on the SQLite file the parent names. The read hashes the file, keeps
// the document's text and each rendered page as derivations, and the guard has the eyes answer one page a request,
// keeps each answer as the call's memo, files its receipt and tells the host's rows. The cut points are the host's own:
// its environment (the scratch directory the read asks for once it has hashed the file; the rename that finishes a
// derivation), its receipt sink, and its eyes (asked for a second look, once the first is told). With MODE=first the
// process writes `.cut-<CUT>` in the workspace at that point and waits there for the parent's SIGKILL; with
// MODE=second it reopens the same file, the cut call runs again, and it prints what the conversation holds.
// env: DB CWD OUT LEDGER CUT=copy|derive|receipt|look|none MODE=first|second
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { DEFAULT_LIMITS } from "@parcha/pi-vision";
import { createVisionExtension } from "@parcha/pi-vision/durable";
import { fakeEyes } from "@parcha/pi-vision/testing";
import { ctx, open, transcript } from "./rig.mjs";

const { DB, CWD, OUT, LEDGER, CUT, MODE } = process.env;
const DERIVED = ".vision/derived";
const cutHere = (point) => {
  if (CUT !== point || MODE !== "first") return Promise.resolve();
  fs.writeFileSync(path.join(CWD, `.cut-${point}`), "");
  // A timer keeps the process alive until the parent's SIGKILL, so it never exits on its own.
  return new Promise(() => setInterval(() => {}, 60_000));
};

/** pi's Node environment, stopped where a crash is wanted. */
class CutEnv extends NodeExecutionEnv {
  #scratch = 0;
  /** The first scratch directory a call asks for is the read's, asked for once the source is hashed and before any
   *  reader opens it. */
  async createTempDir(prefix, context) {
    if (this.#scratch++ === 0) await cutHere("copy");
    return super.createTempDir(prefix, context);
  }
  /** A derivation is whole once its temporary file is renamed into the derive directory; each one kept is logged with
   *  the process that kept it, so the parent sees what a rerun made again. */
  async renameFile(from, to, context) {
    const kept = path.resolve(this.cwd, to).startsWith(path.join(CWD, DERIVED) + path.sep);
    if (kept) await cutHere("derive");
    const renamed = await super.renameFile(from, to, context);
    if (kept && renamed.ok) fs.appendFileSync(path.join(OUT, "kept.jsonl"), `${JSON.stringify({ by: MODE, name: path.basename(to) })}\n`);
    return renamed;
  }
}

/** The host's sink: one receipt per look key, written to a temporary name and renamed; each call is logged. */
const sink = {
  async file(label, record) {
    fs.appendFileSync(path.join(OUT, "calls.jsonl"), `${JSON.stringify({ key: record.facts.key, kept: record.facts.kept ?? false })}\n`);
    const file = path.join(OUT, label, `${record.facts.key}.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(temp, `sha256: ${record.facts.sha256}\nkey: ${record.facts.key}\n---\n${record.body}`);
    await cutHere("receipt");
    fs.renameSync(temp, file);
    return { path: path.relative(OUT, file) };
  },
};

/** The host's rows: each look it is told of, logged with the process that was told. */
const onLook = (look) => fs.appendFileSync(path.join(OUT, "looks.jsonl"), `${JSON.stringify({ by: MODE, key: look.record.facts.key, kept: look.kept ?? false, costUsd: look.costUsd })}\n`);

/** One page a request, so each page of a document is a look of its own. */
const fake = fakeEyes({ ledgerPath: LEDGER, limits: { ...DEFAULT_LIMITS, imagesPerCall: 1 }, answers: [(request) => `a page of ${request.parts.filter((part) => part.type === "image").map((part) => part.chars).join(" and ")} base64 characters`] });
const eyes = { ...fake, see: async (request, signal) => { if (fake.ledger.length === 1) await cutHere("look"); return fake.see(request, signal); } };
const { extension } = createVisionExtension({ eyes, evidence: sink, onLook, scope: () => ({ label: "vision", deriveDir: DERIVED }) });
const { harness, root } = await open({ extensions: [extension], rounds: [[["read", { path: "notice.pdf", ask: "what is the reference number?" }]]], cwd: CWD, db: DB, env: () => new CutEnv({ cwd: CWD }), lead: "blind-1" });
const settled = await (await root.submit({ type: "input", content: "go", requestId: "go-1" }, ctx)).wait(ctx);
process.stdout.write(`RESULT ${JSON.stringify({ settled: settled.status, results: await transcript(root), usage: await harness.usage(ctx) })}\n`);
await harness.close(ctx);
process.exit(0);
