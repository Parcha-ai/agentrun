// What the cases share.
export const decode = (base64: string) => Buffer.from(base64, "base64").toString("utf8");
export const b64 = (text: string | Uint8Array) => Buffer.from(text).toString("base64");
export const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** A label a case adds to tell its own computers apart from the rest of the run's. */
export const CASE_LABEL = "agentrun.conformance.case";
/** A shell line that prints the stat line of each pid still alive, and nothing when none is. */
export const alive = (pids: number[]) => `for p in ${pids.join(" ")}; do [ -e /proc/$p ] && cat /proc/$p/stat; done; true`;
