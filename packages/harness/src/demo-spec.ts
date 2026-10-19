// The demo spec the reference entry reads: the parts of `demo.json` the entry itself acts on. A demo's `demo.json` holds more (the DSL's
// DemoSpec: models, keys, programs, expected calls; the template's claim, panels, targets); the entry ignores what it does not run.

import { JEV_CAPS } from './judge.ts';

/** A kill the supervisor makes. `point` names a crossing the child takes (`effect.kept <tool>`, `judge.asked <label>`, `model.request turn 1`, a package's
 *  own such as `vision.filing`); the first time the child crosses it, it is killed with SIGKILL. `kind: 'box'` says the whole machine or sandbox was
 *  taken away, and the supervisor destroys the process's boxes with it. */
export type CrossingKill = {
  point: string; why: string; kind?: 'process' | 'box';
  /** `run` (the default): the process the run lives in dies, and the supervisor writes a kill line with its `kind`. `tool`: a box a tool made (the audit's install box) is
   *  destroyed once at the crossing: the run's process lives, so no kill line is written, and the transport box lines record the loss. */
  target?: 'run' | 'tool';
  /** The nth time the child takes the crossing (default 1): the third box command in flight, say. */
  n?: number;
  /** At a crossing that parks (`vision.filing`): the filing that is the nth, and those that reach the same crossing after it, are parked (never completed) until `hold` of them are parked or `waitMs` (default 3000) has passed, then the
   *  kill. Several answers are then kept in the journal and none filed, so the resume files each kept answer: "N kept, nothing paid twice". */
  hold?: number;
  waitMs?: number;
  /** Only a crossing whose info has these values counts (`transport.tool.started` fires for every tool: `{ tool: 'install' }` is the install step). With `n`: the nth matching crossing. */
  where?: Record<string, string | number | boolean>;
};
/** A storm: `kills` kills, each at the first crossing the child takes once it has run `gapMs` since it started (a crossing between a tool's dispatch and the
 *  host keeping its answer is never cut: nothing records what the tool did yet). */
export type StormKill = { storm: { kills: number; gapMs: number }; kind?: 'process' | 'box' };
export type KillSpec = CrossingKill | StormKill;

/** A box a job's tools run in: a directory of this machine (`local`), or a Docker container. Cloud boxes take their provider's package. */
export type BoxSpec = {
  kind: 'local' | 'docker'; image?: string;
  /** Also run the job's own tools (the disk package's shell and files) in a box of this provider. Without it the provider is only handed to the demo's tools (`context.boxes`). */
  runIn?: boolean;
};

export type DemoSpec = {
  name: string;
  title?: string;
  claim?: string;
  /** What `--kill` does: each entry in order, one per process, then the run finishes. The template's single `kill` is a list of one. */
  kills?: KillSpec[];
  kill?: { point: string; why: string };
  /** The dollars a live run is expected to cost. `--max-usd` defaults to twice this. */
  expectedCost?: number;
  /** The job's input: what it looks like, for `--input` (the job's own `input` is the default). `fixtures` maps a capture's name (`[a-z0-9-]`) to its fixture, a JSON file at `examples/<demo>/fixtures/...`: `--input <name>` runs the job on it. */
  input?: { shape?: string; fixtures?: Record<string, string> };
  /** The keys and programs the demo needs (the DSL's DemoSpec): each `{ env, ... }` or a `oneOf` group of them. A live child's environment is exactly these names. */
  keys?: unknown[];
  programs?: unknown[];
  /** The checked files the job reads: `sources.json` beside the demo (`true`), or another path relative to it. They are fetched into the run's `work/` on `--live` and with `--fetch-sources`. */
  sources?: boolean | string;
  /** The models the demo names (the DSL's DemoSpec). `judge: { jev: true }` is the Jev judge: it needs a Jev key group in `keys` (`TYPESAFE_API_KEY` or `OPENROUTER_API_KEY`), refused at load without one. `judge.caps` sets the demo's own Jev caps
   *  (`requests`, `tokens`: positive integers, at most 200 requests and 2,560,000 tokens); the run still refuses past them, and `--max-usd` still applies. */
  models?: { lead?: unknown; eyes?: unknown; judge?: { jev?: boolean; caps?: { requests?: number; tokens?: number } } };
  /** The job's tools, each named and placed (the commercial contract): `local` is `"fakes"` or `"mcp:<url>"`, `hosted` the hosted catalogue name or null. On `--live` a tool the live parts do not supply runs from the fakes only when `local` is `"fakes"`. */
  tools?: Array<{ name: string; local?: string; hosted?: string | null }>;
  /** `false`: the demo opens no page, so the entry creates no browser, live or on fakes (a `--live` run then needs no Browserbase key and no Chrome), and a page tool call fails with `this demo has no browser`. Default: a browser. */
  browser?: boolean;
  /** Code mode (same as `DemoOptions.codeMode`): a `code` tool with a sandbox that has `tools.bash` and `vision.see`. Off by default. */
  codeMode?: boolean | { timeoutMs?: number; outputChars?: number };
  /** The box the job's tools run in. */
  boxes?: BoxSpec;
  /** The sites the agent can hand a task to (`use_website`): each runs a child agent in a browser of its own, starting at `startUrl`, and answers a short report. */
  sites?: Record<string, { title: string; description: string; startUrl: string }>;
  [other: string]: unknown;
};

/** The kills a spec asks for, in order: `kills`, or the single `kill` of the template. */
export function killsOf(spec: DemoSpec): KillSpec[] {
  const list = spec.kills ?? (spec.kill ? [{ point: spec.kill.point, why: spec.kill.why }] : []);
  for (const kill of list) {
    if (kill.kind !== undefined && kill.kind !== 'process' && kill.kind !== 'box') throw new Error(`a kill's kind is "process" or "box", not ${JSON.stringify(kill.kind)}`);
    if (!('storm' in kill) && kill.target !== undefined && kill.target !== 'run' && kill.target !== 'tool') throw new Error(`a kill's target is "run" or "tool", not ${JSON.stringify(kill.target)}`);
    if (!('storm' in kill) && kill.hold !== undefined && !(Number.isInteger(kill.hold) && kill.hold >= 1)) throw new Error('a kill\'s hold is a positive integer');
    if (!('storm' in kill) && kill.waitMs !== undefined && !(kill.waitMs >= 0)) throw new Error('a kill\'s waitMs is 0 or more');
    if (!('storm' in kill) && kill.hold !== undefined && kill.target === 'tool') throw new Error('hold parks a run kill: it does not go with target "tool"');
    if (!('storm' in kill) && kill.n !== undefined && !(Number.isInteger(kill.n) && kill.n >= 1)) throw new Error('a kill\'s n is a positive integer');
    if ('storm' in kill && (kill as { where?: unknown }).where !== undefined) throw new Error('a storm has no where: it takes the first crossing it can');
    if (!('storm' in kill) && kill.where !== undefined && (kill.where === null || typeof kill.where !== 'object' || Array.isArray(kill.where) || !Object.keys(kill.where).length || !Object.values(kill.where).every((value) => ['string', 'number', 'boolean'].includes(typeof value)))) throw new Error('a kill\'s where is an object of fields (strings, numbers, booleans) the crossing\'s info must equal');
    if ('storm' in kill) {
      if (!Number.isInteger(kill.storm.kills) || kill.storm.kills < 1 || !(kill.storm.gapMs >= 0)) throw new Error('a storm names kills (a positive integer) and gapMs (0 or more)');
    } else if (typeof kill.point !== 'string' || !kill.point || typeof kill.why !== 'string') throw new Error('a kill names a point and says why');
  }
  return list;
}

/** One kill the supervisor hands one process: the crossing to die at, or a storm's gap. */
export type Plan = { point: string; kind: 'process' | 'box'; why: string; target: 'run' | 'tool'; n: number; where?: Record<string, string | number | boolean>; hold?: number; waitMs?: number } | { storm: true; gapMs: number; kind: 'process' | 'box'; why: string; target: 'run' };
/** What one process is handed: the kill that ends it (if any), and the tool boxes it destroys on the way. */
export type ChildPlan = { run?: Plan; tools: Plan[] };

/** The list as one plan per kill (a storm of N is N plans). */
export function plansOf(kills: KillSpec[]): Plan[] {
  return kills.flatMap((kill): Plan[] => {
    const kind = kill.kind ?? 'process';
    if ('storm' in kill) return Array.from({ length: kill.storm.kills }, (_, index) => ({ storm: true as const, gapMs: kill.storm.gapMs, kind, target: 'run' as const, why: `storm ${index + 1} of ${kill.storm.kills}` }));
    return [{ point: kill.point, kind, why: kill.why, target: kill.target ?? 'run', n: kill.n ?? 1, ...(kill.where ? { where: kill.where } : {}), ...(kill.hold !== undefined ? { hold: kill.hold, waitMs: kill.waitMs ?? 3000 } : {}) }];
  });
}

/** The plans as what each process is handed: a tool-box plan rides with the next run kill (or the last process), so one process destroys its tool boxes and then dies. */
export function childPlansOf(plans: Plan[]): ChildPlan[] {
  const out: ChildPlan[] = [];
  let tools: Plan[] = [];
  for (const plan of plans) {
    if (plan.target === 'tool') { tools.push(plan); continue; }
    out.push({ run: plan, tools });
    tools = [];
  }
  out.push({ tools });
  return out;
}

/** `--input <path|json>`: a JSON object, from a file or inline. */
export function parseInput(argument: string, read: (path: string) => string): Record<string, unknown> {
  const text = argument.trimStart().startsWith('{') ? argument : read(argument);
  let value: unknown;
  try { value = JSON.parse(text); } catch (error) { throw new Error(`--input is a path to a JSON file or a JSON object: ${(error as Error).message}`); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('--input is a JSON object');
  return value as Record<string, unknown>;
}

/** The browser a live run drives: Browserbase when its key PAIR is set (`BROWSERBASE_API_KEY` and `BROWSERBASE_PROJECT_ID`, a `oneOf` group of the demo's keys that is met
 *  by the pair as a whole), decided here, before anything starts; else a local Chrome, only on a person's own machine and only when they say so with `--local-chrome` (a
 *  local Chrome on real pages shows this machine's address to every site). A half pair is never used: it is named, so it is not a provider that fails later. Fakes use the fake. */
export function chooseBrowser(options: { live: boolean; env: NodeJS.ProcessEnv; localChrome: boolean }): 'fake' | 'browserbase' | 'chrome' {
  if (!options.live) return 'fake';
  const key = options.env.BROWSERBASE_API_KEY?.trim() || options.env.BB_API_KEY?.trim();
  const project = options.env.BROWSERBASE_PROJECT_ID?.trim();
  if (key && project) return 'browserbase';
  if (options.localChrome) {
    if (!options.env.CHROME_PATH?.trim()) throw new Error('--local-chrome needs CHROME_PATH, the Chrome binary.');
    return 'chrome';
  }
  const half = key ? ' Only BROWSERBASE_API_KEY is set: Browserbase needs BROWSERBASE_PROJECT_ID too.' : project ? ' Only BROWSERBASE_PROJECT_ID is set: Browserbase needs BROWSERBASE_API_KEY too.' : '';
  throw new Error(`A live run needs a browser: set BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID (Browserbase), or pass --local-chrome with CHROME_PATH to drive a Chrome on your own machine.${half} A local Chrome on real pages shows your address to each site.`);
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

/** The box a run uses: Docker is used only with `--live`; a no-key run uses a local box instead, so it starts no container. */
export function effectiveBoxes(spec: DemoSpec, live: boolean): BoxSpec | undefined {
  if (!spec.boxes) return undefined;
  return spec.boxes.kind === 'docker' && !live ? { ...spec.boxes, kind: 'local' } : spec.boxes;
}

/** `--input`: a JSON object (inline or a file), or the name of one of the demo's captures (`input.fixtures`), which is read from the path the map gives. The path must be a file under
 *  `examples/<demo>/fixtures/` (no `..`). On fakes a bare name that is not a capture, and not a file either, is refused with the captures there are; `--live` takes any input the job accepts. */
export function inputOf(argument: string, spec: DemoSpec, where: { demo: string; root: string; live: boolean; read: (path: string) => string; kind: (path: string) => 'file' | 'directory' | undefined }): Record<string, unknown> {
  const captures = spec.input?.fixtures ?? {};
  const bare = !argument.trimStart().startsWith('{') && /^[a-z0-9][a-z0-9-]*$/.test(argument);
  if (bare && Object.hasOwn(captures, argument)) {
    const path = captures[argument]!;
    const under = `examples/${where.demo}/fixtures/`;
    if (typeof path !== 'string' || !path.startsWith(under) || path.split('/').some((part) => part === '..' || part === '.' || part === '') || path.includes('\\') || path.includes('\0')) throw new Error(`capture "${argument}" points at ${JSON.stringify(path)}, which is not a path under ${under}`);
    const file = `${where.root}/${path}`;
    const kind = where.kind(file);
    if (kind !== 'file') throw new Error(`capture "${argument}" is ${path}, which ${kind === 'directory' ? 'is a directory: a capture read as the input is a JSON file' : 'does not exist: put the capture there'}`);
    return parseInput(where.read(file), () => { throw new Error('unreachable'); });
  }
  if (bare && !where.live && where.kind(argument) === undefined) {
    const names = Object.keys(captures);
    throw new Error(`--input ${argument} is not a capture of ${where.demo}, and a run on fakes replays a capture. ${names.length ? `The captures are: ${names.join(', ')}.` : 'It has none.'} Run with --live to read the real thing.`);
  }
  return parseInput(argument, where.read);
}

/** The environment names a demo declares in demo.json: every `env` of its `keys` (a `oneOf` group's members included, however deep a member's own group nests) and of its `programs`. A live child is given these and nothing else. */
export function declaredEnv(spec: DemoSpec): Set<string> {
  const names = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { for (const member of value) walk(member); return; }
    if (value === null || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if (typeof record.env === 'string' && record.env) names.add(record.env);
    walk(record.oneOf);
  };
  walk(spec.keys);
  walk(spec.programs);
  return names;
}

/** The most a demo may set its Jev caps to, per field: 200 requests, and 2,560,000 tokens (about $0.11 at Jev's list price) because one request with three
 *  images is about 10,000 tokens, so an image demo's request cap binds first. */
const JEV_CAP_CEILINGS = { requests: 200, tokens: 2_560_000 } as const;

/** The Jev caps this demo runs under: the default (50 requests, 40,000 tokens) or `models.judge.caps`, each a positive integer at most its ceiling (200 requests, 2,560,000 tokens): a value beyond that is refused at load. */
export function judgeCapsOf(spec: DemoSpec): { requests: number; tokens: number } {
  const given = spec.models?.judge?.caps;
  const out = { ...JEV_CAPS } as { requests: number; tokens: number };
  if (given === undefined) return out;
  if (given === null || typeof given !== 'object' || Array.isArray(given)) throw new Error('models.judge.caps is an object { requests, tokens }');
  for (const name of ['requests', 'tokens'] as const) {
    const value = given[name];
    if (value === undefined) continue;
    const ceiling = JEV_CAP_CEILINGS[name];
    if (!Number.isInteger(value) || value < 1 || value > ceiling) throw new Error(`models.judge.caps.${name} is a positive integer at most ${ceiling} (the default is ${JEV_CAPS[name]}), not ${JSON.stringify(value)}`);
    out[name] = value;
  }
  return out;
}

/** A model whose provider needs a key the demo does not declare is refused at load, naming the group to add: demo.json stays the one list the child's environment and the setup prompt read, and no key is implied. First case: the Jev judge. */
export function checkModelKeys(spec: DemoSpec): void {
  if (spec.models?.judge?.jev !== true) return;
  const declared = declaredEnv(spec);
  if (!declared.has('TYPESAFE_API_KEY') && !declared.has('OPENROUTER_API_KEY')) {
    throw new Error('demo.json names models.judge (Jev) but declares no key for it: add a keys group { "oneOf": [{ "env": "TYPESAFE_API_KEY", "required": true, "where": "...", "why": "the Jev judge" }, { "env": "OPENROUTER_API_KEY", "required": true, "where": "...", "why": "the Jev judge through OpenRouter" }], "why": "a Jev key", "for": "live" }');
  }
}
