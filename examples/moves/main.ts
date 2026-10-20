// The live run: one session, three hosts. Needs, in this process's environment (from your own wrappers): ARCHIL_API_KEY, PDA_LIVE_DISK and
// PDA_LIVE_REGION for a scratch disk; MODAL_TOKEN_ID and MODAL_TOKEN_SECRET for the account that starts the VM; ANTHROPIC_API_KEY for the two
// local generations. The Modal workspace must hold the Secrets named by --secret (default: moves-take-anthropic, the model key; moves-take-modal, the token pair the VM's session uses).
//   node examples/moves/main.ts --out DIR [--secret NAME ...]     (default Secrets: moves-take-anthropic, moves-take-modal)
// Writes to DIR: moves-log.txt (what happened, as it happened), ledger.jsonl (every exact id it created and ended), run-json-after-<n>.json,
// threads.json, result.json, answer.txt and report.json. It then searches everything in DIR for the secrets' values and fails if one is there.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { liveDeps } from "./live.ts";
import { moves } from "./run.ts";
import { appTarball, packTarball } from "./vm.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({ options: { out: { type: "string" }, secret: { type: "string", multiple: true }, "app-name": { type: "string", default: "agentrun-moves" } } });
const out = values.out;
// The two Modal Secrets the take's workspace holds: the model key (ANTHROPIC_API_KEY) and the token pair the VM's session uses (MODAL_TOKEN_ID, MODAL_TOKEN_SECRET).
const secrets = values.secret?.length ? values.secret : ["moves-take-anthropic", "moves-take-modal"];
if (!out) {
  console.error("usage: node examples/moves/main.ts --out DIR [--secret NAME ...]   (default secrets: moves-take-anthropic, moves-take-modal)");
  process.exit(2);
}
mkdirSync(out, { recursive: true });
const pack = mkdtempSync(join(tmpdir(), "moves-pack-"));
const repo = join(HERE, "..", "..");
const { deps, sensitive } = await liveDeps({
  out,
  appPath: join(HERE, "app.ts"),
  packageTarball: packTarball(join(repo, "packages", "pi-durable-disk"), pack),
  transportTarball: packTarball(join(repo, "packages", "pi-transport"), pack),
  appTarball: appTarball(HERE),
  secrets,
  appName: values["app-name"]!,
  env: process.env,
});

let failure: Error | undefined;
let report: Awaited<ReturnType<typeof moves>> | undefined;
try {
  report = await moves(deps);
} catch (error) {
  failure = error as Error;
}

if (report) {
  // The run.json after each generation, with the holder's host named by its place and nothing else of the machine.
  for (const g of report.generations) {
    const { record } = g;
    writeFileSync(
      join(out, `run-json-after-${g.generation}.json`),
      `${JSON.stringify({ run: "my-run", status: record.status, generation: record.generation, sealedSeq: record.sealedSeq, holder: record.holder ? { driver: record.holder.driver, host: g.where === "modal" ? "modal-vm" : "local-host", since: (record.holder as { since?: string }).since } : null, heartbeatAt: record.heartbeatAt, updatedAt: record.updatedAt, detail: record.detail ?? null }, null, 2)}\n`,
    );
  }
  for (const name of ["threads.json", "result.json", "answer.txt"]) writeFileSync(join(out, name), await deps.work(name).catch(() => ""));
  const { generations, ...rest } = report;
  writeFileSync(join(out, "report.json"), `${JSON.stringify({ ...rest, generations: generations.map(({ record: _record, ...g }) => g) }, null, 2)}\n`);
}

// The recording holds no secret: every file in DIR is searched for the values of the keys this process held.
const leaked: string[] = [];
const walk = (dir: string) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else {
      const bytes = readFileSync(full);
      for (const secret of sensitive) if (secret && bytes.includes(secret)) leaked.push(entry.name);
    }
  }
};
walk(out);
if (leaked.length) {
  console.error(`not ok: a secret's value is in ${leaked.join(", ")}`);
  process.exit(1);
}
if (failure || !report) {
  console.error(`not ok: ${failure?.message ?? "no report"}`);
  process.exit(1);
}
console.log(`ok: the session moved local -> Modal VM -> local with ${report.threads.length} threads, picked thread ${report.picked}, and left nothing running (${report.ledger.started.length} incarnations started and ended; recording searched: 0 secrets)`);
