// One process of the crash matrix: a lead asks `read` about an image, through the adapter, on the SQLite file the
// parent names. The core behind the adapter follows the durability rules every reader follows: it works on the copy it
// read, names a derivation by that copy's hash and its parameters, writes it to a temporary name and renames it, keeps
// the eyes' answer as a memo before it files the receipt, and files the receipt under the look's key. With MODE=first
// the process writes `.cut-<CUT>` in the workspace at that point and waits there for the parent's SIGKILL; with
// MODE=second it reopens the same file, the cut call runs again, and it prints what the conversation holds.
// env: DB CWD OUT LEDGER CUT=copy|derive|receipt|none MODE=first|second
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CONTRACT_VERSION, visionContext } from "@parcha/pi-vision";
import { fakeEyes } from "@parcha/pi-vision/testing";
import { ctx, loadDurable, open, transcript } from "./rig.mjs";

const { DB, CWD, OUT, LEDGER, CUT, MODE } = process.env;
const cutHere = (point) => {
  if (CUT !== point || MODE !== "first") return Promise.resolve();
  fs.writeFileSync(path.join(CWD, `.cut-${point}`), "");
  // A timer keeps the process alive until the parent's SIGKILL, so it never exits on its own.
  return new Promise(() => setInterval(() => {}, 60_000));
};
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const value = (result) => { if (!result.ok) throw result.error; return result.value; };

async function readMedia(env, args, call, setup) {
  const at = visionContext(call.signal);
  const copy = value(await env.readBinaryFile(args.path, at));
  const hash = sha(copy);
  await cutHere("copy");
  const derived = `${setup.scope.deriveDir}/${hash.slice(0, 16)}-fit${setup.limits.image.maxWidth}.png`;
  if (!(await env.fileInfo(derived, at)).ok) {
    const temp = `${derived}.${randomBytes(4).toString("hex")}.tmp`;
    value(await env.writeFile(temp, copy, at));
    await cutHere("derive");
    value(await env.renameFile(temp, derived, at));
  }
  const shown = value(await env.readBinaryFile(derived, at));
  const key = sha(JSON.stringify([hash, args.path, args.ask, setup.eyes.model, CONTRACT_VERSION, setup.limits.image]));
  const answer = await call.memo(`vision:look:${key}`, async () => {
    const seen = await setup.eyes.see({ parts: [{ type: "image", data: Buffer.from(shown).toString("base64"), mimeType: "image/png", width: 1, height: 1, fragment: args.path }], ask: args.ask }, call.signal);
    return { text: seen.text, model: seen.model, usage: seen.usage };
  });
  const record = { tool: "look", args: { path: args.path, ask: args.ask, model: answer.model, native: false }, status: "ok", facts: { sha256: hash, kind: "image", fragment: args.path, shown: derived, fit: { reduction: "as_is" }, key }, body: answer.text };
  const filed = await setup.evidence.file(setup.scope.label, record);
  return { content: [{ type: "text", text: `${answer.text} (receipt: ${filed.path})` }], details: { sha256: hash, key, derived }, usage: answer.usage };
}

/** The host's sink: one receipt per look key, written to a temporary name and renamed; each call is logged. */
const sink = {
  async file(label, record) {
    fs.appendFileSync(path.join(OUT, "calls.jsonl"), `${JSON.stringify({ key: record.facts.key })}\n`);
    const file = path.join(OUT, label, `${record.facts.key}.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(temp, `sha256: ${record.facts.sha256}\nkey: ${record.facts.key}\n---\n${record.body}`);
    await cutHere("receipt");
    fs.renameSync(temp, file);
    return { path: path.relative(OUT, file) };
  },
};

globalThis.visionCore = { readMedia, guardResult: async (result) => result };
const { createVisionExtension } = await loadDurable();
const eyes = fakeEyes({ ledgerPath: LEDGER, answers: [(request) => `an image of ${request.parts[0].chars} base64 characters`] });
const { extension } = createVisionExtension({ eyes, evidence: sink, scope: () => ({ label: "vision", deriveDir: ".vision/derived" }) });
const { harness, root } = await open({ extensions: [extension], rounds: [[["read", { path: "scan.png", ask: "what is shown?" }]]], cwd: CWD, db: DB });
const settled = await (await root.submit({ type: "input", content: "go", requestId: "go-1" }, ctx)).wait(ctx);
process.stdout.write(`RESULT ${JSON.stringify({ settled: settled.status, results: await transcript(root), usage: await harness.usage(ctx) })}\n`);
await harness.close(ctx);
process.exit(0);
