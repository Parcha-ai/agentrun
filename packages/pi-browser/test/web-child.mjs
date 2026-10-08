// One process of the web crash scenario: runs a web_fetch against the parent's fake provider until the parent
// SIGKILLs it (mode first) or reopens the same SQLite file and resumes (mode second).
// env: DB FAKE OUT MODE=first|second
import { createWebExtension } from "../dist/durable.js";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { fileSink, open, transcript } from "./web-rig.mjs";

const call = async (route, payload, signal) => {
  const res = await fetch(process.env.FAKE + route, { method: "POST", body: JSON.stringify(payload), signal });
  return res.json();
};
const { sink } = fileSink(process.env.OUT);
const { extension } = createWebExtension({ providers: { name: "browserbase", fetch: (request, signal) => call("/fetch", request, signal) }, evidence: sink });
const { harness, root } = await open(extension, [[["web_fetch", { url: "https://slow.example/hang" }]]], process.env.DB);
const settled = await (await root.submit({ type: "input", content: "go", requestId: "go-1" }, ctx)).wait(ctx);
process.stdout.write(`RESULT ${JSON.stringify({ pid: process.pid, settled: settled.status, results: await transcript(root), usage: await harness.usage(ctx) })}\n`);
await harness.close(ctx);
process.exit(0);
