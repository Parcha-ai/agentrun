// The one plain HTTP door every provider uses: direct calls, never through the env proxy, on a shared agent.
import nodeModule from "node:module";
import type * as Undici from "undici";

const require = nodeModule.createRequire(import.meta.url);
let undiciModule: typeof Undici | undefined;
/** Userland undici, loaded on the first call that needs it (an optional peer: a process that never reaches a provider never loads it). */
const undiciDoor = (): typeof Undici => (undiciModule ??= require("undici") as typeof Undici);

/** One plain agent for every direct call in the process: REST calls go direct, never through the env proxy, and connections
 *  are reused instead of one agent per client. `closeDirectFetch` ends it (the next call makes a new one). */
let directAgent: any;
export async function directFetch(): Promise<((input: any, init?: any) => Promise<any>) | undefined> {
  try {
    const undici: any = undiciDoor();
    // Userland undici refuses a request body it must stream (the extension upload's multipart file) without `duplex`.
    return (input: any, init: any = {}) => undici.fetch(input, { ...init, dispatcher: (directAgent ??= new undici.Agent()), ...(init.body ? { duplex: "half" } : {}) });
  } catch {
    return undefined;
  }
}
export async function closeDirectFetch(): Promise<void> {
  const agent = directAgent;
  directAgent = undefined;
  await agent?.close();
}
