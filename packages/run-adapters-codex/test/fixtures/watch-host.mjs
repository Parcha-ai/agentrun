// A host for watch.test.mjs: starts one child through the session machine, one that does not end when its stdin closes
// (as a CLI that ignores EOF does), and says on stdout where it is, then waits to be SIGKILLed.
//   argv[2]: the session directory;  argv[3]: the parent watch, "shim" or "pdeathsig" (default what the machine supports);
//   argv[4]: "confined" to start the child under a confinement that records what it was given, into argv[5].
import { appendFileSync } from 'node:fs';
import { localMachine } from '../../dist/host/machine.js';
import { CODEX_ROUTES, gatewayHandler } from '../../dist/host/process.js';

const [dir, watch, confining, record] = process.argv.slice(2);
const route = { routes: CODEX_ROUTES, models: { model: 'luna-test' }, credential: () => 'provider-secret', target: 'https://provider.invalid' };
const confine = confining === 'confined' ? (c) => { appendFileSync(record, `${JSON.stringify(c)}\n`); return { command: '/usr/bin/env', args: [c.command, ...c.args] }; } : undefined;
const acquire = localMachine({
  dir, ...(watch ? { parentWatch: watch } : {}), ...(confine ? { confine } : {}),
  proxy: { hooks: { beforeRequest: async () => {}, afterRequest: async () => {} }, tools: [] },
});
const machine = await acquire({ ctx: { runId: 'watch' }, model: gatewayHandler(route) });
// The child says who its parent is and how that parent was started: under the shim it is the shim, under the kernel's
// parent-death signal (setpriv execs in place) it is this host.
const holder = 'const { readFileSync } = require("node:fs"); const parent = readFileSync(`/proc/${process.ppid}/cmdline`, "utf8").split("\\0").filter(Boolean); process.stdin.resume(); process.stdin.on("end", () => {}); console.log(JSON.stringify({ pid: process.pid, ppid: process.ppid, parent })); setInterval(() => {}, 1000);';
const child = await machine.spawn({ command: process.execPath, args: ['-e', holder], env: {} });
for await (const line of child.lines()) {
  process.stdout.write(`${JSON.stringify({ child: JSON.parse(line).pid, ppid: JSON.parse(line).ppid, parent: JSON.parse(line).parent, host: process.pid })}\n`);
  break;
}
setInterval(() => {}, 1000);
