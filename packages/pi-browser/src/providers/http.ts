import nodeModule from "node:module";
import type * as Undici from "undici";

const require = nodeModule.createRequire(import.meta.url);
let undiciModule: typeof Undici | undefined;
/** Loaded on first use, so a process that never reaches a provider never loads undici. */
const undiciDoor = (): typeof Undici => (undiciModule ??= require("undici") as typeof Undici);

let directAgent: Undici.Agent | undefined;
/** fetch over the package's own undici agent: direct, never through the HTTP(S) env proxy. undici is a dependency, so a load that
 *  fails is a broken install and throws; there is no fallback to the global fetch, which would follow the proxy. */
export async function directFetch(): Promise<typeof Undici.fetch> {
  const undici = undiciDoor();
  // Userland undici refuses a request body it must stream (the extension upload's multipart file) without `duplex`.
  return (input, init = {}) => undici.fetch(input, { ...init, dispatcher: (directAgent ??= new undici.Agent()), ...(init.body ? { duplex: "half" } : {}) });
}
export async function closeDirectFetch(): Promise<void> {
  const agent = directAgent;
  directAgent = undefined;
  await agent?.close();
}
