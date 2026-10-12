// httpBox against a fake /gg/exec: stdin goes in with the request, frames come out as the two streams and the exit, more
// frames than a channel holds arrive whole, and a reader that stops early does not stall the other stream.
import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { boxShell, Channel, httpBox } from "../http-box.ts";

let url = "";
const server = createServer((req, res) => {
  if (req.headers.authorization !== "Bearer k") {
    res.writeHead(404).end();
    return;
  }
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = JSON.parse(raw) as { argv: string[]; stdin: string };
    const frame = (f: object) => res.write(JSON.stringify(f) + "\n");
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    const [what, n] = body.argv[0] === "sh" ? [body.argv[2]] : body.argv;
    if (what === "echo") frame({ stream: "stdout", data: body.stdin });
    for (let i = 0; i < Number(n ?? 0); i++) {
      frame({ stream: "stdout", data: Buffer.alloc(1024, i % 256).toString("base64") });
      frame({ stream: "stderr", data: Buffer.from(`e${i}\n`).toString("base64") });
    }
    frame({ exit: what === "fail" ? 7 : 0 });
    res.end();
  });
});

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const read = async (s: AsyncIterable<Uint8Array>) => {
  const parts: Uint8Array[] = [];
  for await (const c of s) parts.push(c);
  return Buffer.concat(parts);
};

test("stdin in, both streams and the exit out", async () => {
  const p = await httpBox({ url, key: "k" }).exec(["echo"], { mode: "binary" });
  await p.stdin.writeBytes(new TextEncoder().encode("hello"));
  await p.stdin.close();
  const [out, , code] = await Promise.all([read(p.stdout as AsyncIterable<Uint8Array>), read(p.stderr as AsyncIterable<Uint8Array>), p.wait()]);
  assert.equal(out.toString(), "hello");
  assert.equal(code, 0);
  await assert.rejects(boxShell(httpBox({ url, key: "k" }))("fail"), /exited 7/);
  await assert.rejects(boxShell(httpBox({ url, key: "wrong" }))("x"), /exited 255/);
});

test("more frames than a channel holds arrive whole", async () => {
  const p = await httpBox({ url, key: "k" }).exec(["many", "500"], { mode: "binary" });
  await p.stdin.close();
  const [out, err, code] = await Promise.all([read(p.stdout as AsyncIterable<Uint8Array>), read(p.stderr as AsyncIterable<Uint8Array>), p.wait()]);
  assert.equal(out.length, 500 * 1024);
  assert.equal(err.toString().split("\n").filter(Boolean).length, 500);
  assert.equal(code, 0);
});

test("a reader that stops early does not stall the other stream", async () => {
  const p = await httpBox({ url, key: "k" }).exec(["many", "500"], { mode: "binary" });
  await p.stdin.close();
  const first = async () => {
    for await (const c of p.stdout as AsyncIterable<Uint8Array>) return c.length;
    return 0;
  };
  const [n, err, code] = await Promise.all([first(), read(p.stderr as AsyncIterable<Uint8Array>), p.wait()]);
  assert.equal(n, 1024);
  assert.equal(err.toString().split("\n").filter(Boolean).length, 500);
  assert.equal(code, 0);
});

test("a channel holds at most 16 chunks: the next push waits until the reader takes one", async () => {
  const channel = new Channel(() => {});
  for (let i = 0; i < 16; i++) await channel.push(new Uint8Array([i]));
  let pushed = false;
  const next = Promise.resolve(channel.push(new Uint8Array([16]))).then(() => (pushed = true));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(pushed, false, "the 17th chunk waits");
  const reader = channel[Symbol.asyncIterator]();
  assert.deepEqual((await reader.next()).value, new Uint8Array([0]));
  await next;
  assert.equal(pushed, true);
});
