// fetch_page's network for the recovery test: the fake network, but each dial first blocks while the hold file at
// $FAUX_WEB_HOLD exists, polled asynchronously so the run process stays responsive while the call is in-flight. Every
// dial is appended to $FAUX_WEB_LOG, so a re-run after resume shows as a second dial of the same URL. fetch_page's
// replay class is safe, so the next server re-runs the interrupted call; the test removes the hold file once that server
// is up, letting the re-run land. A hold file (not a FIFO) has no open/writer race across the crash and the restart.
import { appendFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { network } from "./fake-network.mjs";

const exists = (path) => access(path).then(() => true, () => false);

export default function web() {
  const log = process.env.FAUX_WEB_LOG;
  const hold = process.env.FAUX_WEB_HOLD;
  const base = network((url) => log && appendFileSync(log, `${url}\n`));
  return {
    lookup: base.lookup,
    fetchImpl: async (url) => {
      while (hold && (await exists(hold))) await new Promise((resolve) => setTimeout(resolve, 20));
      return base.fetchImpl(url);
    },
  };
}
