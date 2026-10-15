// The demo spec the reference entry reads: the parts of `demo.json` the entry itself acts on. A demo's `demo.json` holds more (the DSL's
// DemoSpec: models, keys, programs, expected calls; the template's claim, panels, targets); the entry ignores what it does not run.

/** A kill the supervisor makes. `point` names a crossing the child takes (`effect.kept <tool>`, `judge.asked <label>`, `model.request turn 1`, a package's
 *  own such as `vision.filing`); the first time the child crosses it, it is killed with SIGKILL. `kind: 'box'` says the whole machine or sandbox was
 *  taken away, and the supervisor destroys the process's boxes with it. */
export type CrossingKill = { point: string; why: string; kind?: 'process' | 'box' };
/** A storm: `kills` kills, each at the first crossing the child takes once it has run `gapMs` since it started (a crossing between a tool's dispatch and the
 *  host keeping its answer is never cut: nothing records what the tool did yet). */
export type StormKill = { storm: { kills: number; gapMs: number }; kind?: 'process' | 'box' };
export type KillSpec = CrossingKill | StormKill;

/** A box a job's tools run in: a directory of this machine (`local`), or a Docker container. Cloud boxes take their provider's package. */
export type BoxSpec = { kind: 'local' | 'docker'; image?: string };

export type DemoSpec = {
  name: string;
  title?: string;
  claim?: string;
  /** What `--kill` does: each entry in order, one per process, then the run finishes. The template's single `kill` is a list of one. */
  kills?: KillSpec[];
  kill?: { point: string; why: string };
  /** The dollars a live run is expected to cost. `--max-usd` defaults to twice this. */
  expectedCost?: number;
  /** The job's input: where its default lives and what it looks like, for `--input`. The job's own `input` is the default. */
  input?: { shape?: string };
  /** The box the job's tools run in. */
  boxes?: BoxSpec;
  [other: string]: unknown;
};

/** The kills a spec asks for, in order: `kills`, or the single `kill` of the template. */
export function killsOf(spec: DemoSpec): KillSpec[] {
  const list = spec.kills ?? (spec.kill ? [{ point: spec.kill.point, why: spec.kill.why }] : []);
  for (const kill of list) {
    if (kill.kind !== undefined && kill.kind !== 'process' && kill.kind !== 'box') throw new Error(`a kill's kind is "process" or "box", not ${JSON.stringify(kill.kind)}`);
    if ('storm' in kill) {
      if (!Number.isInteger(kill.storm.kills) || kill.storm.kills < 1 || !(kill.storm.gapMs >= 0)) throw new Error('a storm names kills (a positive integer) and gapMs (0 or more)');
    } else if (typeof kill.point !== 'string' || !kill.point || typeof kill.why !== 'string') throw new Error('a kill names a point and says why');
  }
  return list;
}

/** One kill the supervisor hands one process: the crossing to die at, or a storm's gap. */
export type Plan = { point: string; kind: 'process' | 'box'; why: string } | { storm: true; gapMs: number; kind: 'process' | 'box'; why: string };

/** The list as one plan per kill (a storm of N is N plans). */
export function plansOf(kills: KillSpec[]): Plan[] {
  return kills.flatMap((kill): Plan[] => {
    const kind = kill.kind ?? 'process';
    if ('storm' in kill) return Array.from({ length: kill.storm.kills }, (_, index) => ({ storm: true as const, gapMs: kill.storm.gapMs, kind, why: `storm ${index + 1} of ${kill.storm.kills}` }));
    return [{ point: kill.point, kind, why: kill.why }];
  });
}

/** `--input <path|json>`: a JSON object, from a file or inline. */
export function parseInput(argument: string, read: (path: string) => string): Record<string, unknown> {
  const text = argument.trimStart().startsWith('{') ? argument : read(argument);
  let value: unknown;
  try { value = JSON.parse(text); } catch (error) { throw new Error(`--input is a path to a JSON file or a JSON object: ${(error as Error).message}`); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('--input is a JSON object');
  return value as Record<string, unknown>;
}

/** The browser a live run drives: Browserbase when its key is set; else a local Chrome, only on a person's own machine and only when they say so with
 *  `--local-chrome` (a local Chrome on real pages shows this machine's address to every site). Fakes use the fake browser. */
export function chooseBrowser(options: { live: boolean; env: NodeJS.ProcessEnv; localChrome: boolean }): 'fake' | 'browserbase' | 'chrome' {
  if (!options.live) return 'fake';
  if (options.env.BROWSERBASE_API_KEY?.trim() || options.env.BB_API_KEY?.trim()) return 'browserbase';
  if (options.localChrome) {
    if (!options.env.CHROME_PATH?.trim()) throw new Error('--local-chrome needs CHROME_PATH, the Chrome binary.');
    return 'chrome';
  }
  throw new Error('A live run needs a browser: set BROWSERBASE_API_KEY (Browserbase), or pass --local-chrome with CHROME_PATH to drive a Chrome on your own machine. A local Chrome on real pages shows your address to each site.');
}

/** The spend cap in dollars: `--max-usd`, else twice the spec's `expectedCost`, else none. */
export function maxUsdOf(flag: string | undefined, spec: DemoSpec): number | null {
  if (flag !== undefined) {
    const value = Number(flag);
    if (!(value >= 0) || !Number.isFinite(value)) throw new Error('--max-usd is a number of dollars, 0 or more');
    return value;
  }
  return typeof spec.expectedCost === 'number' ? spec.expectedCost * 2 : null;
}
