// The tools the workflow's `call` nodes reach: registry, advisories and install. Each keeps what it read as a receipt file under
// `<run>/receipts/<tool>/` and returns the receipt's path, so a finding can cite it. Live, they read the public sources;
// replaying, they answer from a capture (`capture.ts`) and say so in the receipt. Every tool is safe to run again: the same
// input writes the same receipt.
import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Fixture } from './capture.ts';
import { advisoryFacts, registryFacts } from './sources.ts';

/** What an install probe reports: the program's exit, the scripts it ran, and the connections its box saw. */
export type InstallReport = { exitCode: number; scriptLog: string; outbound: Array<{ host?: string; ip: string; port: number; at: number }>; durationMs: number };
/** Installs one package version in a fresh box and reports what it reached. Re-running it in a new box is safe: it changes nothing outside the box. */
export type InstallProbe = (name: string, version: string, options: { image?: string; timeoutMs?: number }) => Promise<InstallReport>;

export type ToolOptions = {
  /** The run's root; receipts go under it. */
  root: string;
  /** `live` reads the public sources as the run goes; `replay` answers from a capture and labels each receipt a replay. */
  source: { live: true } | { replay: Fixture };
  /** The install in a box. Absent, the install step is skipped and says why. */
  probe?: InstallProbe;
  /** Said in the install receipt when there is no probe. */
  skipped?: string;
};

type Tool = (args: Record<string, unknown>) => Promise<unknown>;

const REGISTRY_HOSTS = new Set(['registry.npmjs.org', 'registry.yarnpkg.com']);

export function keep(root: string, tool: string, name: string, version: string, body: unknown): { receipt: string; sha256: string } {
  const text = `${JSON.stringify(body, null, 2)}\n`;
  const receipt = join('receipts', tool, `${name.replace('/', '__')}@${version}.json`);
  const at = join(root, receipt);
  mkdirSync(dirname(at), { recursive: true });
  writeFileSync(`${at}.${process.pid}.partial`, text);
  renameSync(`${at}.${process.pid}.partial`, at);
  return { receipt, sha256: createHash('sha256').update(text).digest('hex') };
}

const argsOf = (args: Record<string, unknown>) => ({ name: String(args.name), version: String(args.version) });

export function makeTools(options: ToolOptions): Record<string, Tool> {
  const { root } = options;
  const replay = 'replay' in options.source ? options.source.replay : undefined;
  const key = ({ name, version }: { name: string; version: string }) => `${name}@${version}`;
  const origin = replay ? { replay: { project: replay.project, commit: replay.source.commit, captured: replay.source.captured } } : { live: true };
  return {
    async registry(args) {
      const { name, version } = argsOf(args);
      const facts = replay ? replay.registry[key({ name, version })] : (await registryFacts(name, version)).facts;
      if (!facts) throw Object.assign(new Error(`no registry facts for ${name}@${version}`), { code: 'not_found' });
      const { receipt } = keep(root, 'registry', name, version, { source: 'registry.npmjs.org', ...origin, facts });
      return { receipt, name, version, repository: facts.repository, deprecated: facts.deprecated, scripts: facts.scripts };
    },
    async advisories(args) {
      const { name, version } = argsOf(args);
      const facts = replay ? replay.advisories[key({ name, version })] : (await advisoryFacts(name, version)).facts;
      if (!facts) throw Object.assign(new Error(`no advisory facts for ${name}@${version}`), { code: 'not_found' });
      const { receipt } = keep(root, 'advisories', name, version, { source: 'api.osv.dev', ...origin, facts });
      return { receipt, ids: facts.ids, summaries: facts.summaries, published: facts.published };
    },
    async install(args) {
      const { name, version } = argsOf(args);
      const scripts = Object.entries((args.scripts ?? {}) as Record<string, string>).map(([phase, command]) => `${phase}: ${command}`);
      if (!options.probe) {
        const note = options.skipped ?? (replay ? 'replay: no box was started, so the install\'s connections are not known' : 'no box is available, so the install step was skipped');
        const { receipt } = keep(root, 'install', name, version, { ran: false, note, scripts });
        return { receipt, ran: false, note, scripts, hosts: [], outside: [] };
      }
      const report = await options.probe(name, version, {});
      const hosts = [...new Set(report.outbound.map((connection) => connection.host ?? connection.ip))].sort();
      const outside = hosts.filter((host) => !REGISTRY_HOSTS.has(host));
      const { receipt } = keep(root, 'install', name, version, { ran: true, label: 'connections seen by strace', report, scripts, hosts, outside });
      return { receipt, ran: true, scripts, hosts, outside };
    },
  };
}
