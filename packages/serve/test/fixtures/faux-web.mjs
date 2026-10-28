// fetch_page's network in the run's process, for the tests: the fake network, each dial appended to $FAUX_WEB_LOG.
import { appendFileSync } from "node:fs";
import { network } from "./fake-network.mjs";

export default function web() {
  const log = process.env.FAUX_WEB_LOG;
  const { lookup, fetchImpl } = network((url) => log && appendFileSync(log, `${url}\n`));
  return { lookup, fetchImpl };
}
