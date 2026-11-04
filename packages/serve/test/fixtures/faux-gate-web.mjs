// The tool gate's tests' network: the fake network (fake-network.mjs), each URL it dials appended to $FAUX_WEB_LOG, so a
// test reads which calls ran.
import { appendFileSync } from "node:fs";
import { network } from "./fake-network.mjs";

export default function web() {
  const log = process.env.FAUX_WEB_LOG;
  return network((url) => log && appendFileSync(log, `${url}\n`));
}
