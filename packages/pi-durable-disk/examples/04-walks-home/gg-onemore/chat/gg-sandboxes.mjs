// The sandboxes of one of the GG page's Modal apps, and with --terminate, their end: what stop-gg.sh and live-gg.mjs use to
// show (and make) Modal at zero for that app only. Run from gg-onemore/ (its node_modules has modal) under with-modal.
//   node chat/gg-sandboxes.mjs pda-gg-chat [--terminate]
import { ModalClient, NotFoundError } from "modal";

const name = process.argv[2];
if (!name || !name.startsWith("pda-gg-")) throw new Error("name one of the GG page's apps (pda-gg-...)");
const terminate = process.argv.includes("--terminate");
const client = new ModalClient();
// only an app Modal says does not exist counts as empty: any other failure is an error, never a false zero
const app = await client.apps.fromName(name, { createIfMissing: false }).catch((e) => {
  if (e instanceof NotFoundError) return null;
  throw e;
});
let left = 0;
if (app) {
  for await (const sb of client.sandboxes.list({ appId: app.appId })) {
    if (terminate) {
      await sb.terminate();
      console.log(`terminated ${sb.sandboxId}`);
    } else {
      left++;
      console.log(sb.sandboxId);
    }
  }
  if (terminate) for await (const _ of client.sandboxes.list({ appId: app.appId })) left++;
}
console.log(`sandboxes in ${name}: ${left}`);
