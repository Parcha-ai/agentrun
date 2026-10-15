// Serve and park: an idle agent holds no process. An instance serves `POST /submit`; its model is overloaded and the
// retry is a long wait, so the run parks: the wake time is written to run.json, the claim is released and the process
// exits 0. Nothing runs until `wakeAt`, when a small restart loop opens the run again and the retry finishes. The same
// `requestId` sent after the restart finds the first submission: it is answered, not run twice.
//
// One file, its own supervisor: `node examples/serve-and-park/main.ts` starts `main.ts instance` children. No disk,
// no key: `localRun` is a directory of this machine and pi-ai's faux model answers.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import { localRun, openDurableRun, parseRunRecord, RUN_JSON, serveRun, watchParking } from "@parcha/pi-durable-disk";

const root = join(process.cwd(), "serve-and-park-run");
/** The model's retry wait. A wait longer than the park threshold is what parks the run. */
const RETRY_MS = 3_000;
const PARK_THRESHOLD_MS = 500;

/** One incarnation of the run: serve, and park when the work only waits. */
async function instance(): Promise<void> {
  let generation = 0;
  // The first generation's model is overloaded (a retryable error); every later request is answered.
  const faux = fauxProvider();
  faux.setResponses(
    Array.from({ length: 20 }, () => () => {
      console.log(`model request (generation ${generation})`);
      return generation === 1 ? fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error: Overloaded" }) : fauxAssistantMessage("recovered, answered once");
    }),
  );
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const agent = { model: { provider: model.provider, modelId: model.id } };
  // The server listens before the run opens, and answers 503 OPENING until `attach`.
  const server = await serveRun({ root: { agent } });
  const run = await openDurableRun(
    { disk: "local", region: "local", id: "serve-park" },
    { ...localRun(root), harness: { models, registry: createRegistry(), settings: { retry: { baseDelayMs: RETRY_MS, maxAgentDelayMs: RETRY_MS } } } },
  );
  generation = run.generation;
  server.attach(run);
  console.log(`generation ${generation} serves ${server.url}`);
  // Park when the work only waits longer than the threshold: the wake goes into run.json, then the claim is released.
  const parking = watchParking(run, { thresholdMs: PARK_THRESHOLD_MS, keepAwake: () => server.active > 0, quiesce: () => server.pause() });
  void parking.parked.then((parked) => {
    console.log(`generation ${generation} parked until ${new Date(parked.wakeAt!).toISOString()}, released, exiting`);
    process.exit(0);
  });
  // The supervisor ends the run with SIGTERM once it has what it wants.
  process.once("SIGTERM", () => {
    void (async () => {
      await parking.stop();
      await run.setStatus("done");
      await run.release();
      process.exit(0);
    })();
  });
  setInterval(() => {}, 1 << 30); // an instance stays up until it parks or is ended
}

interface Instance {
  readonly child: ChildProcess;
  readonly url: Promise<string>;
  readonly closed: Promise<number | NodeJS.Signals | null>;
}

/** An instance of this file on the run directory, its lines echoed. `url` is where it serves; `closed` waits for `close`, not `exit`. */
function start(started: ChildProcess[]): Instance {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "instance"], { stdio: ["ignore", "pipe", "inherit"] });
  started.push(child);
  let found: (url: string) => void;
  const url = new Promise<string>((resolve) => (found = resolve));
  createInterface({ input: child.stdout! }).on("line", (line) => {
    console.log(line);
    lines.push(line);
    const at = /serves (http:\/\/\S+)$/.exec(line);
    if (at) found(at[1]!);
  });
  const closed = new Promise<number | NodeJS.Signals | null>((resolve) => child.on("close", (status, signal) => resolve(signal ?? status)));
  return { child, url, closed };
}

/** `POST /submit`, which fails with a message instead of waiting past `ms` (a `wait: true` submit never answers if the work never finishes). */
async function submit(url: string, body: Record<string, unknown>, ms = 30_000): Promise<{ generation: number; submission: { id: number; status: string }; answer?: { text: string } }> {
  try {
    const res = await fetch(new URL("/submit", url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(ms) });
    if (!res.ok) throw new Error(`POST /submit answered ${res.status}: ${await res.text()}`);
    return (await res.json()) as never;
  } catch (error) {
    if ((error as Error).name === "TimeoutError") throw new Error(`POST /submit ${JSON.stringify(body.requestId)} was not answered within ${ms} ms`);
    throw error;
  }
}

/** A process with this pid exists (signal 0 delivers nothing). */
function alive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** `promise`, or a thrown error naming what did not happen within `ms`: a run that never parks must fail, not hang. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${what} did not happen within ${ms} ms`)), ms)));
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

const runRecord = () => parseRunRecord(readFileSync(join(root, RUN_JSON), "utf8"));
const lines: string[] = [];

async function supervise(): Promise<void> {
  const started: ChildProcess[] = [];
  const failures: string[] = [];
  const expect = (ok: boolean, what: string) => ok || failures.push(what);
  rmSync(root, { recursive: true, force: true });
  console.log(`the run is ${root}`);
  try {
    // Generation 1: one submission, not waited for. Its model is overloaded, so the retry waits.
    const first = start(started);
    const sent = await submit(await within(first.url, 15_000, "generation 1 serving"), { requestId: "order-1", content: "Please process order 1" });
    console.log(`submitted order-1: submission ${sent.submission.id} is ${sent.submission.status}`);
    expect((await within(first.closed, 30_000, "generation 1 parking")) === 0, "generation 1 exits 0 by itself, parked");
    const parkedAt = Date.now();
    const sleeping = runRecord();
    expect(sleeping.status === "sleeping" && sleeping.wakeAt !== null && Date.parse(sleeping.wakeAt) > parkedAt - 1_000, `run.json says sleeping with a wakeAt: ${JSON.stringify([sleeping.status, sleeping.wakeAt])}`);
    // The record keeps the last holder; the release sealed the store, and the process it names is gone.
    expect(sleeping.sealedSeq !== null, "the release sealed the store at its last committed sequence");
    expect(!alive(sleeping.holder?.pid), `the last holder's process is gone: ${JSON.stringify(sleeping.holder)}`);

    // The restart loop: nothing runs until wakeAt, then the run is opened again.
    const wakeAt = Date.parse(sleeping.wakeAt ?? "");
    console.log(`no process holds the run for ${Math.max(0, wakeAt - Date.now())} ms, until ${sleeping.wakeAt}`);
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, wakeAt - Date.now())));
    const second = start(started);
    const url = await within(second.url, 15_000, "generation 2 serving");
    // The same requestId after the restart: pi finds the first submission, so the model is not asked again.
    const again = await submit(url, { requestId: "order-1", content: "Please process order 1", wait: true });
    console.log(`submitted order-1 again: submission ${again.submission.id} is ${again.submission.status}, answered "${again.answer?.text}" by generation ${again.generation}`);
    expect(again.submission.id === sent.submission.id, `the duplicate is the same submission: ${sent.submission.id} and ${again.submission.id}`);
    expect(again.submission.status === "done" && again.answer?.text === "recovered, answered once" && again.generation === 2, `the answer comes from generation 2: ${JSON.stringify(again)}`);
    second.child.kill("SIGTERM");
    expect((await within(second.closed, 15_000, "generation 2 ending")) === 0, "generation 2 exits 0 on SIGTERM, done");
    expect(runRecord().status === "done", `run.json says done: ${runRecord().status}`);
    // The model was asked once by each generation (overloaded, then answered): the duplicate never reached it.
    const asked = lines.filter((line) => line.startsWith("model request"));
    expect(asked.join() === "model request (generation 1),model request (generation 2)", `model requests: ${asked}`);
  } catch (error) {
    failures.push((error as Error).message);
  } finally {
    for (const child of started) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  if (failures.length) {
    console.error(`not ok: ${failures.join("; ")}`);
    process.exit(1);
  }
  console.log("ok: an idle run holds no process: it parked on a long retry, a restart at its wakeAt finished it, and a repeated requestId was answered, not run again");
}

if (process.argv[2] === "instance") await instance();
else await supervise();
