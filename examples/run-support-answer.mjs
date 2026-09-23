import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const help = `Run the support-answer AgentRun workflow.

  node examples/run-support-answer.mjs [password|invoice|payment|unresolved]
  node examples/run-support-answer.mjs payment --config ./support.config.mjs
  node examples/run-support-answer.mjs --config ./support.config.mjs --input ./request.json

No --config: all four scripted scenarios (or the selected one), no live calls.
With --config: live Jev plus your configured host adapters; defaults to payment.
--input: JSON object { "request": "..." }; requires --config and replaces scenario.
--help: show this help.

Build the AgentRun source first. Configure TYPESAFE_API_KEY on the server.
Get a key: https://console.typesafe.ai/keys
Copy examples/support-answer-config.example.mjs and wire your existing host.
Live stdout is a redacted report: calls, decisions, metadata, and validated status.
Exit codes: 0 complete (or all expected scripted outcomes), 2 single-case escalation,
1 failed. No reply is sent.`;
export function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (['--config', '--input'].includes(arg)) {
      const key = arg.slice(2), value = args[++index];
      if (options[key] || !value || value.startsWith('-')) throw new Error('Each option needs exactly one file path.');
      options[key] = value;
    } else if (!arg.startsWith('-') && !options.scenario) options.scenario = arg;
    else throw new Error('Unknown or repeated argument. Use --help.');
  }
  if (options.help) return options;
  if (options.scenario && !['password', 'invoice', 'payment', 'unresolved'].includes(options.scenario)) throw new Error('Unknown scenario. Use --help.');
  if (options.input && (!options.config || options.scenario)) throw new Error('--input requires --config and cannot be combined with a scenario.');
  return options;
}

export async function main(args = process.argv.slice(2)) {
  let options;
  try { options = parseArgs(args); }
  catch (error) { console.error(error.message); return 1; }
  if (options.help) { console.log(help); return 0; }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    const { scenarios, createScriptedAdapters } = await import('./support-answer-fixtures.mjs');
    if (!options.config) {
      const { runWorkflow } = await import('../packages/dsl/dist/index.js');
      const { workflow } = await import('./support-answer.mjs');
      let status = 0;
      for (const name of options.scenario ? [options.scenario] : Object.keys(scenarios)) {
        const { deps, calls } = createScriptedAdapters(name);
        const result = await runWorkflow(workflow, scenarios[name].input, { ...deps, signal: controller.signal });
        console.log(JSON.stringify({ scenario: name, mode: 'scripted adapters; no live calls', status: result.status,
          calls: calls.map(call => `${call.kind}:${call.label}`),
          agentCalls: calls.filter(call => call.kind === 'agent').length,
          judgeCalls: calls.filter(call => call.kind === 'judge').length,
          ...(result.status === 'complete' ? { output: result.output } : { escalation: result.escalation.summary }),
        }, null, 2));
        const expected = name === 'unresolved' ? 'escalated' : 'complete';
        if (result.status !== expected) throw new Error('Unexpected scripted outcome.');
        if (options.scenario && result.status === 'escalated') status = 2;
      }
      return status;
    }
    const { runLiveSupport, SupportSetupError, SupportRunError } = await import('./support-answer-live.mjs');
    let config, input;
    try { config = (await import(pathToFileURL(resolve(options.config)).href)).default; }
    catch { throw new SupportSetupError('Could not load the trusted host config. Check the file and its imports; raw import errors are omitted.'); }
    if (options.input) {
      try { input = JSON.parse(await readFile(resolve(options.input), 'utf8')); }
      catch { throw new SupportSetupError('Could not read the input JSON. Supply a file containing { "request": "..." }.'); }
    } else input = scenarios[options.scenario ?? 'payment'].input;
    try {
      const { report } = await runLiveSupport(input, config, { signal: controller.signal });
      console.log(JSON.stringify(report, null, 2));
      return report.status === 'escalated' ? 2 : 0;
    } catch (error) {
      if (error instanceof SupportRunError) console.error(JSON.stringify(error.report, null, 2));
      else if (error instanceof SupportSetupError) console.error(error.message);
      else console.error('Could not configure live Jev. Check server credentials and Jev options; no scripted fallback was used.');
      return 1;
    }
  } catch (error) {
    // Never print arbitrary import/provider errors: they can contain credentials or request data.
    if (error?.constructor?.name === 'SupportSetupError') console.error(error.message);
    else console.error('Unable to run the starter. Build the AgentRun source, check the supplied files, and use --help.');
    return 1;
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main();
