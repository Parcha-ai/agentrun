// The tool gate's tests' network: the fake network (fake-network.mjs), each URL it dials appended to $FAUX_WEB_LOG, so a
// test reads which calls ran. With $FAUX_WEB_HOLD set, a fetch of http://public.example/?hold writes <hold>.waiting, then
// waits until <hold> exists, and answers as http://public.example/ does: a test changes a setting while a call runs.
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { network } from "./fake-network.mjs";

export default function web() {
  const log = process.env.FAUX_WEB_LOG;
  const hold = process.env.FAUX_WEB_HOLD;
  const net = network((url) => log && appendFileSync(log, `${url}\n`));
  return {
    ...net,
    fetchImpl: async (url, init) => {
      if (!hold || url.href !== "http://public.example/?hold") return net.fetchImpl(url, init);
      writeFileSync(`${hold}.waiting`, "");
      while (!existsSync(hold)) await sleep(20);
      return net.fetchImpl(new URL("http://public.example/"), init);
    },
  };
}
