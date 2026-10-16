// A writer that dies inside the store's lock: it takes the lock through `modify`, says so, and waits to be killed. Nothing
// references its wait, and it collects garbage while it waits (run with --expose-gc): the store, not the writer's own
// references, keeps the lock held.
import { fileCredentialStore } from '@parcha/agentrun-pi/signin';

const [home] = process.argv.slice(2);
// It never outlives its test: its stdin is a pipe from the test, which closes however the test process ends, and it
// leaves after a minute regardless.
process.stdin.on('end', () => process.exit(0)).resume();
setTimeout(() => process.exit(3), 60_000);
setInterval(() => globalThis.gc(), 20);
await fileCredentialStore(home).modify('openai', async () => {
  process.stdout.write('held\n');
  await new Promise(() => {});
});
