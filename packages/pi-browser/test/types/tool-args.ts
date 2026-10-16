import { pageTools, type CustodyPort, type PageDriver, type ToolCall } from "../../src/index.js";

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
