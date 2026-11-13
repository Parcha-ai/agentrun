// Each image a model request carries is checked where it is attached (attach-images.ts): one a provider would refuse
// goes as a short text saying why, so one bad screenshot no longer fails the whole run with "Invalid image data URL".
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { test } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { attachableImages, notAttached, unattachable } from "../dist/attach-images.js";
import { redactedAnswer } from "../dist/key-refusal.js";
import { sessionProvider } from "../dist/port-models.js";
import { cutAnswer } from "../dist/tools.js";

// A real 640x400 PNG and a real 640x313 JPEG headless Chrome captured of a page, each's base64 past the 8,192 characters
// the run's cut reads as one piece.
const pngBytes = readFileSync(new URL("./fixtures/screenshot.png", import.meta.url));
const png = pngBytes.toString("base64");
const jpeg = readFileSync(new URL("./fixtures/screenshot.jpg", import.meta.url)).toString("base64");

test("the run's cut on a tool's answer keeps an image block's data whole only when it is an image, and cuts every other data as text", () => {
  assert.ok(png.length > 8_192 && jpeg.length > 8_192);
  const held = `sk-${"k3Yq9".repeat(1_800)}`;
  const cut = (text) => redactedAnswer(text, [held]);
  const answer = (block) => cutAnswer({ content: [{ type: "text", text: "url: https://example.test/" }, block] }, cut).content[1];
  // A real screenshot passes whole, as a PNG and as a JPEG.
  assert.equal(answer({ type: "image", data: png, mimeType: "image/png" }).data, png);
  assert.equal(answer({ type: "image", data: jpeg, mimeType: "image/jpeg" }).data, jpeg);
  // A held key's base64 dressed as an image block, a JPEG's bytes named a PNG, and a PNG with a held key written after
  // its header are each cut.
  assert.equal(answer({ type: "image", data: Buffer.from(held).toString("base64"), mimeType: "image/png" }).data, "[redacted]");
  assert.equal(answer({ type: "image", data: jpeg, mimeType: "image/png" }).data, "[redacted]");
  assert.equal(answer({ type: "image", data: Buffer.concat([pngBytes, Buffer.from(held)]).toString("base64"), mimeType: "image/png" }).data, "[redacted]");
  // The key as text, on a block of another type, is cut as before.
  assert.equal(answer({ type: "resource", data: held }).data, "[redacted]");
});

test("an image is attachable only with a known type, data that is base64, bytes of the type it names, and a header that says its size", () => {
  assert.equal(unattachable({ data: png, mimeType: "image/png" }), undefined);
  assert.equal(unattachable({ data: "[redacted]", mimeType: "image/png" }), "its data is not base64");
  assert.equal(unattachable({ data: "", mimeType: "image/png" }), "it is empty");
  assert.equal(unattachable({ data: png, mimeType: "image/bmp" }), 'its type "image/bmp" is not PNG, JPEG, GIF or WebP');
  // A name every object inherits is no type either.
  for (const name of ["__proto__", "toString", "constructor"]) assert.equal(unattachable({ data: png, mimeType: name }), `its type "${name}" is not PNG, JPEG, GIF or WebP`);
  assert.equal(unattachable({ data: png, mimeType: "image/jpeg" }), "its bytes are not a image/jpeg");
  // The PNG's eight-byte signature and nothing after it: no IHDR to say its size.
  assert.equal(unattachable({ data: png.slice(0, 12), mimeType: "image/png" }), "its image/png header does not say its size");
});

test("attachableImages puts a text saying why in place of each image that cannot be attached, and keeps the context as it is when every image can be", () => {
  const good = { role: "user", content: [{ type: "text", text: "look" }, { type: "image", data: png, mimeType: "image/png" }], timestamp: 0 };
  const context = { systemPrompt: "s", messages: [good] };
  assert.equal(attachableImages(context), context);
  const bad = { role: "toolResult", toolCallId: "c1", toolName: "screenshot", content: [{ type: "image", data: "[redacted]", mimeType: "image/png" }], isError: false, timestamp: 0 };
  const out = attachableImages({ ...context, messages: [good, bad] });
  assert.equal(out.messages[0], good);
  assert.deepEqual(out.messages[1].content, [{ type: "text", text: notAttached("its data is not base64") }]);
  assert.equal(out.messages[1].toolCallId, "c1");
});

test("through the session's provider, the request a model is sent holds the good image's data URL and the bad one's note, never a data URL of non-base64", { timeout: 30_000 }, async (t) => {
  const bodies = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      bodies.push(JSON.parse(raw));
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "the test reads the request only", type: "invalid_request_error" } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const models = createModels();
  models.setProvider(sessionProvider("openai-responses", { url, key: "session-key" }, "gpt-test", { provider: "session", keyName: "AGENTRUN_SESSION_KEY", reasoning: false }));
  const model = models.getModel("session", "gpt-test");
  await models.completeSimple(model, { messages: [{ role: "user", timestamp: 0, content: [
    { type: "text", text: "two screenshots" },
    { type: "image", data: png, mimeType: "image/png" },
    { type: "image", data: "[redacted]", mimeType: "image/png" },
  ] }] });
  assert.equal(bodies.length, 1);
  const parts = bodies[0].input.flatMap((item) => (Array.isArray(item.content) ? item.content : []));
  const images = parts.filter((part) => part.type === "input_image").map((part) => part.image_url);
  assert.deepEqual(images, [`data:image/png;base64,${png}`]);
  assert.ok(parts.some((part) => part.type === "input_text" && part.text === notAttached("its data is not base64")), JSON.stringify(parts).slice(0, 400));
});
