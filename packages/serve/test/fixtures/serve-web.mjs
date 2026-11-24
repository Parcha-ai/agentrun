// web's functions on serve's parts, for a test that calls one alone: pi-browser's guard, the run's ledger as Pay, and a
// log line for what the model is not told.
import * as web from "@parcha/agentrun-web";
import { paidRequest } from "../../dist/paid-calls.js";
import { logLine } from "../../dist/print.js";
import { GUARD } from "../../dist/web-run.js";

export const webFetch = (url, { log, ...options } = {}) => web.webFetch(url, { ...options, guard: GUARD, ...(log ? { log: (event, fields) => log(logLine(event, fields)) } : {}) });
export const parallelExtract = (apiKey, send = fetch) => web.parallelExtract(apiKey, send, paidRequest);
