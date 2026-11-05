// A person's own message row shows what they typed: shortened, and with a held key redacted (the host's `redact`), but
// never put through the rule for URLs a MODEL saw (scrubUrls drops a URL's fragment, userinfo and query values). A
// console link pasted into a message keeps its #/runs/<id>; a key in a URL's query shows as [redacted]. Every other
// row still scrubs its URLs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { timelineOf } from "../dist/timeline/index.js";
import { assistant, call, result, user } from "./timeline-support.mjs";

/** A held key, made at runtime: no credential-shaped literal for the source export. */
const KEY = ["not-a-secret", "pasted-url-key", "0123456789ab"].join("-");
const redact = (text) => text.split(KEY).join("[redacted]");
const CONSOLE = "http://127.0.0.1:7340/#/runs/01a1a88c-4f2e-7abc-8def-0123456789ab"; // key-gate: loopback-rule a console link a person pastes, as text
const own = (rows) => rows.filter((r) => r.kind === "user_message");

test("a pasted console link keeps its #/runs/<id> fragment whole in the message row's summary and text", () => {
  const rows = timelineOf([user(`Why did ${CONSOLE} fail?`), assistant([{ type: "text", text: "Looking." }])], { redact });
  assert.equal(own(rows)[0].summary, `You: Why did ${CONSOLE} fail?`);
  assert.equal(own(rows)[0].text, `Why did ${CONSOLE} fail?`);
});

test("a held key in a pasted URL's query shows as [redacted] in the message row's summary and text, the URL otherwise whole", () => {
  const rows = timelineOf([user(`Try https://api.example/v1/items?k=${KEY}&x=1 now`), assistant([{ type: "text", text: "Ok." }])], { redact });
  assert.equal(own(rows)[0].summary, "You: Try https://api.example/v1/items?k=[redacted]&x=1 now");
  assert.equal(own(rows)[0].text, "Try https://api.example/v1/items?k=[redacted]&x=1 now");
});

test("a tool result's preview still drops a URL's fragment and query values", () => {
  const rows = timelineOf([user("Link?"), assistant([call("b1", "bash", { command: "true" })]), result("b1", "bash", `See ${CONSOLE} and https://api.example/v1?k=v`)]);
  const preview = rows.find((r) => r.kind === "tool_result")?.tool_result_preview ?? "";
  assert.ok(preview && !preview.includes("#/runs/") && !preview.includes("k=v"), preview);
});
