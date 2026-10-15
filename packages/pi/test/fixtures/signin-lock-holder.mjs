// A writer that dies inside the store's lock: it takes the lock through `modify`, says so, and waits to be killed.
import { fileCredentialStore } from '@parcha/agentrun-pi/signin';

const [home] = process.argv.slice(2);
await fileCredentialStore(home).modify('openai', async () => {
  process.stdout.write('held\n');
  await new Promise(() => setInterval(() => {}, 1000));
});
