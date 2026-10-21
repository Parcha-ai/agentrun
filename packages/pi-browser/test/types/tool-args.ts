import { pageTools, type CustodyPort, type PageDriver, type RunAction, type ToolCall } from "../../src/index.js";
import type { RefAction } from "../../src/vendor/stagehand-facade/contract.js";
import { RUN_ACTION_OPS } from "./run-action-ops.mjs";

declare const port: CustodyPort<PageDriver>;
declare const call: ToolCall;
const tools = pageTools();

void tools.run({ code: "return document.title" }, port, call);
void tools.screenshot({ ask: "What is shown?", fullPage: true }, port, call);
// @ts-expect-error
void tools.run({ cod: "return document.title" }, port, call);
// @ts-expect-error
void tools.screenshot({ url: "https://example.test/" }, port, call);
// @ts-expect-error
void tools.browser_read({ what: "pdf" }, port, call);

// RunAction and the vendored facade's RefAction each accept the other, so the driver-neutral type cannot drift from the
// facade; the op list names RunAction's ops exactly, and run_actions.test.mjs holds the same list to the contract.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const facadeAgrees: Same<RunAction, RefAction> = true;
const opsAgree: Same<(typeof RUN_ACTION_OPS)[number], RunAction["op"]> = true;
void [facadeAgrees, opsAgree];

void tools.run({ actions: [{ op: "click", id: "12" }, { op: "type", id: "7", text: "hello", delay: 20 }, { op: "select", id: "3", values: ["a", "b"] }] }, port, call);
// @ts-expect-error
void tools.run({ actions: [{ op: "click", id: 42 }] }, port, call);
// @ts-expect-error
void tools.run({ actions: [{ op: "drag", id: "12" }] }, port, call);
// @ts-expect-error
void tools.run({ actions: [{ op: "fill", id: "12" }] }, port, call);
