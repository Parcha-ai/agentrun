import nodeModule from "node:module";
import type * as Undici from "undici";

const require = nodeModule.createRequire(import.meta.url);
let undiciModule: typeof Undici | undefined;
/** Loaded on first use, so a process that never reaches a provider never loads undici. */
const undiciDoor = (): typeof Undici => (undiciModule ??= require("undici") as typeof Undici);

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
