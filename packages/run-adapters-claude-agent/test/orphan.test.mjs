// A host that is SIGKILLed leaves no Claude Agent CLI behind. The pinned CLI does not exit when its stdin closes, and
// the session machine starts it detached, in its own process group, so before ./host's parent watch every crashed host
// left its CLI running, reparented. Here a host (fixtures/orphan-host.mjs) runs a session on the real pinned CLI and SDK
// against a scripted provider on loopback, and is SIGKILLed at each point a crash can come: while a model request is
// out (the provider holding its answer), while a host tool call runs, and between turns (when the session runs no CLI:
// a turn's CLI ends with the turn). Every process under the host
// (the CLI and anything it started), read from /proc before the kill, must be gone 2 s after it. Zombies count as gone.
// AGENTRUN_ORPHAN_RUNS repeats each point (default 1); the table of survivors is reported as a diagnostic.
//
// Without the pinned CLI this skips; with AGENTRUN_CLAUDE_AGENT_REQUIRE_BINARY=1 (CI) a missing one fails (tool-off.test).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { verifyClaudeAgent } from '@parcha/agentrun-harness-claude';
import { fakeAnthropic } from '@parcha/agentrun-harness-claude/testing';

const HOST = fileURLToPath(new URL('./fixtures/orphan-host.mjs', import.meta.url));
const RUNS = Math.max(1, Number(process.env.AGENTRUN_ORPHAN_RUNS) || 1);
let problem;
try { verifyClaudeAgent({}); } catch (error) { problem = `${error.name}: ${error.message}`; }
const skip = process.platform !== 'linux' || !existsSync('/proc/self/stat') ? 'needs /proc' : problem && process.env.AGENTRUN_CLAUDE_AGENT_REQUIRE_BINARY !== '1' ? problem : false;
const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-claude-orphan-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));

const statOf = (pid) => { const s = readFileSync(`/proc/${pid}/stat`, 'utf8'); return s.slice(s.lastIndexOf(')') + 2).split(' '); };
/** Whether `pid` runs: a zombie (exited, not yet reaped) does not. */
const alive = (pid) => { try { return statOf(pid)[0] !== 'Z'; } catch { return false; } };
const argvOf = (pid) => { try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean); } catch { return []; } };
/** Every process under `root`, read from /proc. */
function descendants(root) {
  const children = new Map();
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try { const ppid = Number(statOf(name)[1]); children.set(ppid, [...(children.get(ppid) ?? []), Number(name)]); } catch {}
  }
  const out = [];
  const walk = (pid) => { for (const c of children.get(pid) ?? []) { out.push(c); walk(c); } };
  walk(root);
  return out;
}
const isCli = (pid) => argvOf(pid).some((a) => /claude-agent-sdk-[a-z0-9-]+\/claude$/.test(a));

/** One crash at `point`: the processes under the host before the kill, and the ones still running 2 s after it. */
async function crash(t, point) {
  let release;
  const held = new Promise((resolve) => (release = resolve));
  t.after(() => release());
  const provider = await fakeAnthropic({ reply: (r) => {
    if (point === 'request') return { hold: held, then: { text: 'ok' } };
    const offered = (r.body?.tools ?? []).some((tool) => tool.name === 'mcp__hands__wait');
    if (point === 'tool' && offered && !Object.keys(r.results ?? {}).length) return { tool: { name: 'mcp__hands__wait', input: {} } };
    return { text: 'ok' };
  } });
  t.after(() => provider.close());
  const proc = spawn(process.execPath, [HOST, provider.url, mkdtempSync(join(ROOT, `${point}-`)), point], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => (stderr += d));
  let tree = [];
  // Nothing this test started outlives it, whatever the result: every process it saw, by its exact pid, if it runs.
  t.after(() => { for (const pid of [proc.pid, ...tree]) if (alive(pid)) try { process.kill(pid, 'SIGKILL'); } catch {} });
  const reports = createInterface({ input: proc.stdout })[Symbol.asyncIterator]();
  const ready = async () => {
    if (point === 'request') {
      for (let i = 0; !provider.messages().length; i++) { assert.ok(i < 600, `no model request reached the provider: ${stderr.slice(-400)}`); await new Promise((r) => setTimeout(r, 100)); }
      return;
    }
    const want = point === 'tool' ? 'tool' : 'idle';
    for (;;) {
      const { value, done } = await reports.next();
      assert.ok(!done, `the host ended before ${want}: ${stderr.slice(-400)}`);
      if (JSON.parse(value)[want] !== undefined) return;
    }
  };
  let timer;
  try {
    await Promise.race([ready(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`not ${point} within 60 s: ${stderr.slice(-400)}`)), 60_000); })]);
  } finally {
    clearTimeout(timer);
  }
  tree = descendants(proc.pid);
  const seen = tree.map((pid) => `${pid} ${argvOf(pid).slice(0, 2).join(' ')}`);
  // A model request or a tool call is inside a turn, so the CLI runs; between turns the session has none running.
  if (point !== 'idle') assert.ok(tree.some(isCli), `the pinned CLI runs under the host: ${seen.join('; ')}`);
  proc.kill('SIGKILL');
  for (const end = Date.now() + 2_000; Date.now() < end && tree.some(alive); ) await new Promise((r) => setTimeout(r, 25));
  return { tree: seen, survivors: tree.filter(alive).map((pid) => `${pid} ${argvOf(pid).join(' ').slice(0, 160)}`) };
}

for (const point of ['request', 'tool', 'idle']) {
  test(`a host SIGKILLed ${point === 'request' ? 'while a model request is out' : point === 'tool' ? 'while a host tool call runs' : 'between turns'} leaves no CLI, and nothing the CLI started, running 2 s later`, { skip, timeout: 90_000 * RUNS }, async (t) => {
    const rows = [];
    for (let run = 1; run <= RUNS; run++) {
      const { tree, survivors } = await crash(t, point);
      rows.push(`${point} run ${run}: ${tree.length} under the host before the kill (${tree.join('; ')}); survivors after 2 s: ${survivors.length ? survivors.join('; ') : 'none'}`);
      t.diagnostic(rows.at(-1));
      assert.deepEqual(survivors, [], rows.at(-1));
    }
  });
}
