// What web's tests share. `guard`: the public-host guard and HTML reader serve gives web (pi-browser's publicFetch and
// readPage, a devDependency here), so a moved case reads a page exactly as serve's run does. `fetchPage`, `readDirect`
// and `webFetch` are web's, through that guard: a case moved from serve calls them as it called serve's. `withEnv` as in
// serve's test support.
import { publicCheck, publicFetch, readPage } from "@parcha/pi-browser";
import * as web from "../dist/index.js";

export const guard = { fetch: publicFetch, check: publicCheck, html: readPage };

export const fetchPage = (url, options = {}) => web.fetchPage(url, { guard, ...options });
export const readDirect = (url, options = {}) => web.readDirect(url, guard, options);
/** A case's provider clients as webFetch's readers: `parallel`, a Parallel client (parallelExtract, or a stand-in with
 *  its live and read); `firecrawl`, keyless Firecrawl's reader (firecrawlFetch). */
export const asReaders = ({ parallel, firecrawl, ...options }) => ({ ...options, readers: { ...(parallel ? { parallel: web.readerOf(web.parallelReads(parallel), web.searchBreaker()) } : {}), ...(firecrawl ? { "firecrawl-keyless": firecrawl } : {}) } });
export const webFetch = (url, options = {}) => web.webFetch(url, { guard, ...asReaders(options) });

/** Sets `vars` in this process's environment for test `t`; the rest of `names` unset. */
export function withEnv(t, vars, names = Object.keys(vars)) {
  const all = [...new Set([...names, ...Object.keys(vars)])];
  const saved = Object.fromEntries(all.map((name) => [name, process.env[name]]));
  t.after(() => { for (const [name, value] of Object.entries(saved)) value === undefined ? delete process.env[name] : (process.env[name] = value); });
  for (const name of all) delete process.env[name];
  Object.assign(process.env, vars);
}
