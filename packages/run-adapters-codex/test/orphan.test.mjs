// When a run process is SIGKILLed, no Codex app-server it started outlives it: every crash would otherwise leave one
// orphan, and a crash-looping run would pile them up. The pinned binary, hosted by a separate node process that stops
// mid-turn (SIGKILL, so no abort or close runs); then its children are looked for.
//
// Linux only. Without the binary this skips; with AGENTRUN_CODEX_REQUIRE_BINARY=1 (CI) a missing or different binary fails.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { processAlive } from '@parcha/agentrun-adapters/host';
import { findCodex } from '../dist/binary.js';
import { verifyCodexBinary } from '../dist/verify.js';

const binary = verifyCodexBinary(findCodex());
const problem = binary instanceof Error ? binary.message : undefined;
// The process table is read from /proc, which only Linux has.
const skip = process.platform !== 'linux' ? 'the orphan checks read /proc, which only Linux has' : problem && process.env.AGENTRUN_CODEX_REQUIRE_BINARY !== '1' ? problem : false;
const PARENT = fileURLToPath(new URL('./orphan-parent.mjs', import.meta.url));
const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-codex-orphan-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));

const alive = processAlive;
/** The pids whose parent is `ppid` and whose executable is `exe`. */
const childrenOf = (ppid, exe) => processes().filter(({ pid, ppid: parentOf }) => {
  try { return parentOf === ppid && readlinkSync(`/proc/${pid}/exe`) === exe; } catch { return false; }
}).map(({ pid }) => pid);
/** Every process: its pid, its parent and its process group, from /proc/<pid>/stat. */
function processes() {
  return readdirSync('/proc').filter((name) => /^\d+$/.test(name)).flatMap((name) => {
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      return [{ pid: Number(name), ppid: Number(fields[1]), pgrp: Number(fields[2]) }];
    } catch {
      return [];
    }
  });
}
/** `pid` and everything below it in the process tree, walked from /proc. */
function treeOf(pid) {
  const all = processes();
  const members = new Set([pid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const { pid: member, ppid } of all) if (members.has(ppid) && !members.has(member)) { members.add(member); grew = true; }
  }
  return [...members];
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Run the host at `mode`, SIGKILL it there, and list what of Codex's process tree is alive 2 s later. */
async function killedAt(mode) {
  const parent = spawn(process.execPath, [PARENT, mkdtempSync(join(ROOT, 'sessions-')), mode], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, AGENTRUN_CODEX_STANDIN: undefined } });
  let left = [];
  try {
    let ready = false;
    parent.stdout.on('data', (chunk) => { if (String(chunk).includes('ready')) ready = true; });
    const started = Date.now();
    while (!ready && Date.now() - started < 60_000) await sleep(50);
    assert.ok(ready, `the host process reached the ${mode} point`);
    await sleep(300);
    const cli = childrenOf(parent.pid, binary.path);
    // Between turns the drive has ended and its machine with it: there is no Codex process to find (and so none to leave).
    if (mode !== 'idle') assert.ok(cli.length >= 1, `Codex is a child of the host at the ${mode} point (found ${JSON.stringify(cli)})`);
    const tree = [...new Set(cli.flatMap(treeOf))];
    parent.kill('SIGKILL');
    await sleep(2_000);
    left = tree.filter((pid) => alive(pid));
    return { cli, tree, left };
  } finally {
    for (const pid of left) { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } }
    parent.kill('SIGKILL');
  }
}

for (const mode of ['request', 'tool', 'idle']) {
  test(`a run process SIGKILLed ${{ request: 'during a model request', tool: 'with a host tool call in flight', idle: 'between turns' }[mode]} leaves no Codex process alive 2 s later, three runs`, { skip, timeout: 120_000 }, async () => {
    const rows = [];
    for (let run = 1; run <= 3; run += 1) {
      const { cli, tree, left } = await killedAt(mode);
      rows.push({ run, cli: cli.length, tree: tree.length, left });
      console.log(`# orphan ${mode} run ${run}: cli processes ${cli.length}, process tree ${tree.length}, alive after 2 s ${JSON.stringify(left)}`);
    }
    assert.deepEqual(rows.flatMap((r) => r.left), [], `something of Codex's process tree outlived the host: ${JSON.stringify(rows)}`);
  });
}
