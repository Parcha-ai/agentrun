// The run's two tools, over the host's sandboxes, one box per environment. `frame` asks the placer where one frame of the zoom runs, draws the frame's four tiles there with the tile
// program, and keeps the frame on the run's disk; its answer names the environment, the box by its label (`box-1`, never the provider's id) and the placer's reason. `release` ends
// every box the run made and answers which; with rates (an option, off in demo.json) it also answers each box's receipt. A box is made the first time a frame is placed in its
// environment, and every later frame placed there uses it.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import type { Models } from '@earendil-works/pi-ai';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import type { ToolContext } from '@parcha/agentrun-reference';
import { type Box, type BoxPrice, type BoxProvider, type BoxReceipt, type BoxSpec, boxReceipts, type EnvironmentFacts, jevPlacer, type Placer } from '@parcha/pi-transport';
import { boxEnv } from '@parcha/pi-transport/hands';
import spec from './demo.json' with { type: 'json' };
import { HEIGHT, TILES_X, TILES_Y, TILE_H, TILE_W, WIDTH, iterationsOf, window_ } from './programs/params.mjs';

/** One place a frame can run: its id, its provider, the author's one line on what it is for, and what its live boxes are made with. */
export type Environment = { id: string; provider: string; purpose: string; cpus?: number; image?: string };
export const ENVIRONMENTS = spec.placement.environments as readonly Environment[];
export const REST = spec.placement.rest;

const PROGRAMS = join(dirname(fileURLToPath(import.meta.url)), 'programs');
/** Where the tile program goes in a box, relative to its workspace. */
const IN_BOX = 'placed-frames';
/** A box ends by itself this long after it was made, whatever happens to the run; `release` ends it first. */
const LIFETIME_MS = 20 * 60_000;
/** The label every box of this example carries, so a person can list what a run left. */
export const LABELS = { example: 'placed-frames' };
const JEV = { provider: 'typesafe', modelId: 'jev-latest' };

/** What the host brings: a provider for each environment, the models the placer asks, and the rates, if any. */
export type Hosting = {
  /** Each environment's provider, by its id, made once with the run's place. */
  providers(place: { root: string; work: string }): Record<string, BoxProvider> | Promise<Record<string, BoxProvider>>;
  /** What an environment's boxes are made with beyond the lifetime and the labels (a live sandbox's size and image); nothing for a local box. */
  specOf?(environment: Environment): Partial<BoxSpec>;
  /** pi-ai's models with the classifier the placer asks: Jev at TypeSafe, or the fakes' scripted one. */
  models: Models;
  /** Who answers the placer: said in each frame's answer, so a scripted run never reads as Jev's. */
  placer: 'jev' | 'scripted';
  /** Each kind of box's rate, for a receipt per box. None by default: no receipt is made. */
  rates?: readonly BoxPrice[] | null;
};

/** What Jev reads for an environment: the author's line and the facts the config states (the provider is not shown to Jev). */
export const factsOf = (environment: Environment): EnvironmentFacts => ({
  id: environment.id, provider: environment.provider, purpose: environment.purpose, capabilities: [],
  gpu: null, cpus: environment.cpus ?? null, memoryMb: null, isolation: null, region: null,
});

/** The step Jev places: the frame as numbers, with no word that says where it should go. */
export function stepOf(f: number, frames: number): string {
  const closer = Math.round(window_(0).width / window_(f).width).toLocaleString('en-US');
  return `Draw frame ${f + 1} of ${frames} of a zoom into the Mandelbrot set: ${closer} times closer than the first frame, at ${iterationsOf(f)} iterations per pixel, as four tiles of ${TILE_W} by ${TILE_H} pixels.`;
}

/** A command in a box, with its output. */
async function sh(env: ExecutionEnv, command: string, timeoutS: number): Promise<{ exitCode: number; out: string; errs: string }> {
  let out = '';
  let errs = '';
  const ran = await env.exec(command, { timeout: timeoutS, onOutput: (text, _context, info) => { if (info.stream === 'stderr') errs += text; else out += text; } }, ctx);
  if (!ran.ok) throw ran.error;
  return { exitCode: ran.value.exitCode, out, errs };
}

type Made = { box: Box; env: ExecutionEnv; label: string; provider: string };
type State = { providers: Record<string, BoxProvider>; labelOf(provider: string, id: string): string | undefined; receipts: BoxReceipt[]; placer: Placer; boxes: Map<string, Promise<Made>> };

/** The tools of one run: `frame` and `release`, sharing the run's boxes. */
export function frameTools(hosting: Hosting) {
  let state: Promise<State> | undefined;
  const open = (place: { root: string; work: string }) => (state ??= (async () => {
    const receipts: BoxReceipt[] = [];
    const ledger = boxReceipts({ prices: hosting.rates ?? [], write: (receipt) => receipts.push(receipt) });
    const given = await hosting.providers(place);
    const providers = Object.fromEntries(ENVIRONMENTS.map((environment) => {
      const provider = given[environment.id];
      if (!provider) throw new Error(`no provider for the environment ${environment.id}`);
      return [environment.id, ledger.wrap(provider)];
    }));
    const placer = await jevPlacer(hosting.models, JEV, { rest: REST, timeoutMs: 30_000 });
    if (!placer.ok) throw placer.error;
    return { providers, labelOf: (provider, id) => ledger.labelOf(provider, id), receipts, placer: placer.value, boxes: new Map() };
  })());

  /** The environment's box: made, checked for node and given the tile program the first time, then the same one. */
  const boxIn = (s: State, environment: Environment): Promise<Made> => {
    const known = s.boxes.get(environment.id);
    if (known) return known;
    const making = (async () => {
      const provider = s.providers[environment.id]!;
      const created = await provider.create({ maxLifetimeMs: LIFETIME_MS, labels: LABELS, ...hosting.specOf?.(environment) }, ctx);
      if (!created.ok) throw created.error;
      const box = created.value;
      const env = boxEnv(box);
      const made = { box, env, label: s.labelOf(provider.name, box.id) ?? 'box-?', provider: provider.name };
      const node = await sh(env, 'node -v', 60);
      if (node.exitCode !== 0) {
        await box.destroy(ctx);
        throw new Error(`the ${environment.id} sandbox (${provider.name}) has no node: ${environment.provider === 'daytona' ? 'set DAYTONA_SNAPSHOT to a snapshot with node 22 or newer' : 'name an image with node 22 or newer'}`);
      }
      const uploaded = await box.upload(['tile.mjs', 'params.mjs'].map((name) => ({ path: `${IN_BOX}/${name}`, bytes: new Uint8Array(readFileSync(join(PROGRAMS, name))) })), ctx);
      if (!uploaded.ok) throw uploaded.error;
      return made;
    })();
    s.boxes.set(environment.id, making);
    // A box that could not be made is asked for again by the next frame placed there.
    making.catch(() => { if (s.boxes.get(environment.id) === making) s.boxes.delete(environment.id); });
    return making;
  };

  const frame = async (args: Record<string, unknown>, context?: ToolContext) => {
    if (!context?.place) throw new Error('the frame tool needs the run\'s place');
    const s = await open(context.place);
    const [f, frames] = [Number(args.f), Number(args.frames)];
    const record = await s.placer.decide({ session: 'placed-frames', phase: 'message', what: 'hands', current: REST, options: ENVIRONMENTS.map(factsOf), next: stepOf(f, frames) }, ctx);
    const environment = ENVIRONMENTS.find((each) => each.id === record.target)!;
    const made = await boxIn(s, environment);
    const cells = Array.from({ length: TILES_X * TILES_Y }, (_, i) => ({ tx: i % TILES_X, ty: Math.floor(i / TILES_X) }));
    const tiles = await Promise.all(cells.map(async ({ tx, ty }) => {
      const ran = await sh(made.env, `node ${IN_BOX}/tile.mjs '${JSON.stringify({ f, tx, ty })}'`, 120);
      if (ran.exitCode !== 0) throw new Error(`tile ${f}/${tx}/${ty} failed in ${made.label}: ${ran.errs.slice(0, 200)}`);
      return { tx, ty, px: Buffer.from((JSON.parse(ran.out.trim().split('\n').at(-1)!) as { px: string }).px, 'base64') };
    }));
    const pixels = Buffer.alloc(WIDTH * HEIGHT);
    for (const { tx, ty, px } of tiles) for (let y = 0; y < TILE_H; y += 1) px.copy(pixels, (ty * TILE_H + y) * WIDTH + tx * TILE_W, y * TILE_W, (y + 1) * TILE_W);
    const dir = join(context.place.work, 'frames');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `f${f}.idx.partial`), pixels);
    renameSync(join(dir, `f${f}.idx.partial`), join(dir, `f${f}.idx`));
    const need = record.answers?.need?.type === 'bool' ? Number(record.answers.need.probability.toFixed(2)) : null;
    return {
      f, environment: environment.id, provider: made.provider, box: made.label,
      placed: { by: hosting.placer === 'scripted' ? 'scripted' : record.by, need, reason: hosting.placer === 'scripted' ? record.reason.replaceAll('Jev judged', 'the script judged') : record.reason, ...(record.error ? { error: record.error.code } : {}) },
      sha256: createHash('sha256').update(pixels).digest('hex'), iterations: iterationsOf(f),
    };
  };

  const release = async () => {
    if (!state) return { boxes: [] };
    const s = await state;
    const ended: Array<{ box: string; environment: string; provider: string }> = [];
    for (const [environment, making] of s.boxes) {
      const made = await making.catch(() => undefined);
      if (!made) continue;
      const done = await made.box.destroy(ctx);
      if (!done.ok) throw done.error;
      ended.push({ box: made.label, environment, provider: made.provider });
    }
    ended.sort((a, b) => a.box.localeCompare(b.box, 'en', { numeric: true }));
    return { boxes: ended, ...(s.receipts.length > 0 ? { receipts: s.receipts } : {}) };
  };

  return { frame, release };
}
