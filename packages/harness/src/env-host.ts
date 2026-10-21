// A host for a run outside `demo()`, from the environment: the models the caller gives, Jev only with a key, a browser only with a Chrome or both Browserbase keys, and evidence, status and the record as
// `localHost` writes them under the run's directory, except evidence, which is under its `work/`: a tool's result points the agent at it, and the agent's `read` reaches `work/` only. It reads the environment once, when it is built. A plane it has no key for refuses every use and is named in `lacks` with what would give it one.
import { join } from 'node:path';
import type { Models } from '@earendil-works/pi-ai/models';
import type { ModelRef } from '@earendil-works/pi-durable';
import { createJevRunner } from '@parcha/agentrun-jev';
import { LIST_PRICES } from '@parcha/pi-browser';
import { chooseBrowser } from './demo-spec.ts';
import { mergeParts } from './demo.ts';
import { localHost, type BrowserPlane, type Fakes, type Host, type RunJudge, type RunPlace } from './host.ts';
import { JEV_LIST_PRICE, priceJudge } from './judge.ts';

/** What gives a host from the environment a browser, and a judge: the words `lacks` carries when it has none. */
const NO_BROWSER = 'set CHROME_PATH or both BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID';
const NO_JUDGE = 'set TYPESAFE_API_KEY';

const refuse = (why: string): never => { throw new Error(why); };

/** No scripted part: `localHost` is built for its evidence, status and record, and every member that would answer from a script is replaced. */
const UNSCRIPTED: Fakes = { model: () => refuse('this host has no scripted model'), tools: {}, judge: async () => refuse('this host has no scripted judge'), pages: {}, start: 'about:blank' };

export type EnvHostOptions = { /** pi-ai's models, with the lead's provider set. */ models: Models; lead: ModelRef; /** Default: this process's environment. */ env?: NodeJS.ProcessEnv };

/** A host for one run at `place`: `models` and `lead` as given; Jev (`TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL` when set) priced at its list price; a Browserbase browser with both of its keys, else a local Chrome at
 *  `CHROME_PATH`; evidence under the run's `work/` (the path a tool returns is one the agent's `read` reaches), status and the record under the run's directory. Its `runEffect` refuses: an agent run has no workflow `call` node. */
export async function hostFromEnv(place: RunPlace, { models, lead, env = process.env }: EnvHostOptions): Promise<Host> {
  const browser = await browserFrom(place, env);
  const key = env.TYPESAFE_API_KEY?.trim();
  const local = localHost(place, UNSCRIPTED, { evidenceRoot: place.work, browser: browser ?? { provider: () => refuse(`this host has no browser: ${NO_BROWSER}`), driver: async () => refuse(`this host has no browser: ${NO_BROWSER}`) } });
  const judge = key ? priceJudge(createJevRunner({ apiKey: key, pricing: { inputUsdPerMillionTokens: JEV_LIST_PRICE.inputUsdPerMillionTokens, outputUsdPerMillionTokens: JEV_LIST_PRICE.outputUsdPerMillionTokens }, ...(env.TYPESAFE_BASE_URL ? { baseURL: env.TYPESAFE_BASE_URL } : {}) }) as unknown as RunJudge) : undefined;
  const lacks = { ...(browser ? {} : { browser: NO_BROWSER }), ...(judge ? {} : { judge: NO_JUDGE }) };
  const secrets = [env.TYPESAFE_API_KEY, env.BROWSERBASE_API_KEY, env.BB_API_KEY].map((value) => value?.trim()).filter((value): value is string => Boolean(value));
  mergeParts(local.host, {
    models: { catalog: models, lead },
    tools: { runEffect: async () => refuse('this host runs no workflow, so no call node reaches it') } as unknown as Host['tools'],
    decisions: { runJudge: judge ?? (async () => refuse(`this host has no judge: ${NO_JUDGE}`)) },
    credentials: { redact: () => secrets },
    ...(Object.keys(lacks).length ? { lacks } : {}),
  });
  return local.host;
}

/** The browser `chooseBrowser` picks for a live run, with a local Chrome allowed when `CHROME_PATH` is set; none when it picks none. */
async function browserFrom(place: RunPlace, env: NodeJS.ProcessEnv): Promise<BrowserPlane | undefined> {
  let kind: 'fake' | 'browserbase' | 'chrome';
  try { kind = chooseBrowser({ live: true, env, localChrome: Boolean(env.CHROME_PATH?.trim()) }); } catch { return undefined; }
  const { stagehandDriver } = await import('@parcha/pi-browser/driver/stagehand');
  if (kind === 'browserbase') {
    const provider = (await import('@parcha/pi-browser/providers/browserbase')).browserbaseProvider({ env });
    return { provider: () => provider, driver: stagehandDriver(), prices: LIST_PRICES };
  }
  // A local Chrome costs nothing: the host's zero prices stand. Its profiles are under the run's directory, outside `work/`.
  const provider = (await import('@parcha/pi-browser/providers/cdp')).cdpProvider({ chrome: { executablePath: env.CHROME_PATH!.trim(), profileRoot: join(place.root, 'chrome') } });
  return { provider: () => provider, driver: stagehandDriver() };
}
