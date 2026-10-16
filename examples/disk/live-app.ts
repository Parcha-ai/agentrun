// The live variant of the disk demo's app: a plain pi-durable-disk app module, run in each sandbox by `pi-durable-disk run --app`. The lead is pi-ai's faux model (scripted: it
// charges the next invoice until ten have a result), `charge` is a paid call whose payment is a line appended to `work/charges.log` on the run's disk, and the batch ends with the
// run's own `done` record. With the supervisor's kill plan (`PLAN`, `KILL_REQUEST`, `KILL_NONCE`) the fifth charge, once paid, asks to be killed and waits: the supervisor deletes the box.
// Only the package and pi's own packages are needed in the box.
import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from '@earendil-works/pi-ai';
import type { FauxResponseFactory } from '@earendil-works/pi-ai';
import { createRegistry, defineExtension, defineTool } from '@earendil-works/pi-durable';
import type { AppContext, AppOptions } from '@parcha/pi-durable-disk';

const BATCH = 'october-vendors';
const INVOICES = 10;
const TASK = `Charge the ten invoices of ${BATCH}, one call each, and report how it went.`;
const cents = (index: number) => 1250 + 175 * index;

/** The kill request, written durably (a temporary file, fsync, rename, fsync of the directory): a request S3 cannot see yet is no request. */
function writeRequest(file: string, body: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const whole = `${file}.${process.pid}`;
  const fd = openSync(whole, 'w');
  writeFileSync(fd, JSON.stringify(body));
  fsyncSync(fd);
  closeSync(fd);
  renameSync(whole, file);
  const dir = openSync(dirname(file), 'r');
  fsyncSync(dir);
  closeSync(dir);
}

export default function app(where: AppContext): AppOptions {
  // The supervisor's per-attempt nonce is read once and removed from the environment before anything starts.
  const nonce = process.env.KILL_NONCE;
  delete process.env.KILL_NONCE;
  const request = process.env.KILL_REQUEST;
  const plan = process.env.PLAN ? (JSON.parse(process.env.PLAN) as { run?: { point?: string; n?: number } }) : {};
  const ledgerFile = join(where.work, 'charges.log');
  let generation = 0;
  let paid = 0;

  const charge = defineTool({
    name: 'charge',
    description: 'Charge an invoice through the paid API. Costs real money; call it once per invoice.',
    parameters: Type.Object({ invoice: Type.String(), cents: Type.Number() }),
    async execute(args) {
      const receipt = `rcpt-${args.invoice}`;
      // The payment: a line on the run's disk, made durable before the call answers.
      mkdirSync(where.work, { recursive: true });
      const fd = openSync(ledgerFile, 'a');
      writeFileSync(fd, `${args.invoice}\t${receipt}\t${args.cents}\tgeneration ${generation}\n`);
      fsyncSync(fd);
      closeSync(fd);
      paid += 1;
      const run = plan.run;
      if (request && run?.point && paid === (run.n ?? 1)) {
        writeRequest(request, { point: run.point, n: paid, pid: process.pid, nonce });
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120_000); // the supervisor deletes this box
        process.kill(process.pid, 'SIGKILL');
      }
      return { content: [{ type: 'text', text: `charged ${args.invoice}: ${receipt}` }] };
    },
  });
  const registry = createRegistry();
  registry.install(defineExtension({ name: 'billing', tools: [charge] }));

  // The lead decides from the results the conversation holds: one charge per invoice, a cut one (a result that says it was interrupted) counted, and never asked again.
  const reply: FauxResponseFactory = (context) => {
    const done = context.messages.filter((message) => message.role === 'toolResult').length;
    if (done >= INVOICES) return fauxAssistantMessage(`${INVOICES} invoices of ${BATCH} charged; a charge cut by the kill was not sent again.`);
    return fauxAssistantMessage(fauxToolCall('charge', { invoice: `INV-${String(done + 1).padStart(3, '0')}`, cents: cents(done) }, { id: `charge-${done + 1}` }), { stopReason: 'toolUse' });
  };
  const faux = fauxProvider();
  faux.setResponses(Array.from({ length: 200 }, () => reply));
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const agent = { model: { provider: model.provider, modelId: model.id } };

  return {
    models,
    registry,
    async onOpen(run) {
      generation = run.generation;
      const root = await run.harness.root(ctx, { agent });
      await (await root.submit({ type: 'input', content: TASK, requestId: 'task-1' }, ctx)).wait(ctx);
      const lines = readFileSync(ledgerFile, 'utf8').split('\n').filter(Boolean).map((line) => line.split('\t'));
      const storeSha256 = createHash('sha256').update(readFileSync(join(where.store, 'run.sqlite'))).digest('hex');
      const record = { batch: BATCH, charged: lines.length, invoices: lines.map((line) => line[0]), generations: [...new Set(lines.map((line) => line[3]))] };
      process.stdout.write(`${JSON.stringify({ outcome: { status: 'complete', generation, record } })}\n`);
      await run.setStatus('done', { record, storeSha256 });
      await run.release();
      process.exit(0);
    },
  };
}
