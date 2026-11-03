// `node scripts/npm-ci-retry.mjs <npm ci flags>`: runs `npm ci <flags>`, its output shown as it comes and kept. When npm
// fails on a network error (its `npm error code` is one of NETWORK_CODES, or it prints `npm error network`), it waits
// NPM_CI_RETRY_WAIT_MS (15 s) and runs once more: npm retries a request that fails before its response, never a download
// that drops midway. Any other failure (a lockfile out of step, an engine npm refuses) exits at once with npm's own code,
// as does a second failure.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const NETWORK_CODES = ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE', 'ERR_SOCKET_TIMEOUT'];

/** The network error npm's output names (its code, or `network`), or null when it failed for another reason. */
function networkFailure(output) {
  const text = output.replace(/\x1b\[[0-9;]*m/g, '');
  const code = /^npm (?:error|ERR!) code (\S+)\s*$/m.exec(text)?.[1];
  if (code && NETWORK_CODES.includes(code)) return code;
  return /^npm (?:error|ERR!) network\b/m.test(text) ? (code ?? 'network') : null;
}

/** Runs npm once with these arguments, its stdout and stderr passed through and kept: its exit code and output. */
async function npm(args) {
  const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { stdio: ['inherit', 'pipe', 'pipe'], shell: process.platform === 'win32' });
  let output = '';
  child.stdout.on('data', (chunk) => { process.stdout.write(chunk); output += chunk; });
  child.stderr.on('data', (chunk) => { process.stderr.write(chunk); output += chunk; });
  const [code, signal] = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (...end) => resolve(end)); });
  return { code: code ?? (signal ? 1 : 0), output };
}

async function main() {
  const wait = process.env.NPM_CI_RETRY_WAIT_MS ?? '15000';
  if (!/^\d+$/.test(wait)) { console.error(`NPM_CI_RETRY_WAIT_MS is a whole number of milliseconds, not "${wait}"`); return 2; }
  const args = ['ci', ...process.argv.slice(2)];
  const first = await npm(args);
  const network = first.code === 0 ? null : networkFailure(first.output);
  if (!network) return first.code;
  console.log(`::warning::npm ci failed on a network error (${network}), retrying once`);
  await sleep(Number(wait));
  return (await npm(args)).code;
}

// exitCode, not exit(): npm's output, written to a pipe, is flushed first.
process.exitCode = await main();
