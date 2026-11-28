// publicFetch decodes a text page by the charset it declares: its Content-Type's charset, else (an HTML page) its own
// <meta> in the first 1024 bytes, else UTF-8. A Latin-1 or Shift_JIS page read as UTF-8 comes back with U+FFFD where its
// letters were. The network is a table: no socket.
import assert from "node:assert/strict";
import test from "node:test";
import { publicFetch } from "../dist/index.js";

const PUBLIC = "93.184.216.34";
const net = (bytes, contentType) => ({ lookup: async () => [PUBLIC], fetchImpl: async () => new Response(bytes, { status: 200, headers: { "content-type": contentType } }) });
const LATIN1 = "Café crème, señor, ¿Qué tal? 25°C";
// こんにちは in Shift_JIS.
const SJIS = Buffer.from([0x82, 0xb1, 0x82, 0xf1, 0x82, 0xc9, 0x82, 0xbf, 0x82, 0xcd]);
const page = (head, body) => Buffer.concat([Buffer.from(`<html><head>${head}<title>t</title></head><body><p>`, "latin1"), body, Buffer.from("</p></body></html>", "latin1")]);
const read = async (bytes, type) => {
  const answer = await publicFetch("https://public.example/", net(bytes, type));
  assert.equal(answer.status, 200);
  return answer.body;
};

const cases = [
  ["Latin-1 in the Content-Type", page("", Buffer.from(LATIN1, "latin1")), "text/html; charset=iso-8859-1", LATIN1],
  ["Latin-1 in <meta charset> only", page('<meta charset="iso-8859-1">', Buffer.from(LATIN1, "latin1")), "text/html", LATIN1],
  ["Shift_JIS in the Content-Type", page("", SJIS), "text/html; charset=Shift_JIS", "こんにちは"],
  ["Shift_JIS in <meta charset> only", page('<meta charset="shift_jis">', SJIS), "text/html", "こんにちは"],
  ["Latin-1 in <meta http-equiv> only", page("<meta http-equiv='Content-Type' content='text/html; charset=ISO-8859-1'>", Buffer.from(LATIN1, "latin1")), "text/html", LATIN1],
  ["Shift_JIS in a quoted Content-Type charset", page("", SJIS), 'text/html; charset="shift_jis"', "こんにちは"],
  ["Latin-1 in a plain-text page's Content-Type", Buffer.from(LATIN1, "latin1"), "text/plain; charset=windows-1252", LATIN1],
];
for (const [name, bytes, type, words] of cases) {
  test(`a page whose charset is ${name} is decoded by it, never read as UTF-8`, async () => {
    const body = await read(bytes, type);
    assert.ok(!body.includes("\uFFFD"), `U+FFFD in the body: ${body}`);
    assert.ok(body.includes(words), body);
  });
}

test("a UTF-8 page, declared or not, reads as it was written", async () => {
  for (const type of ["text/html; charset=utf-8", "text/html"]) {
    assert.ok((await read(page("", Buffer.from(LATIN1, "utf8")), type)).includes(LATIN1), type);
  }
});

test("the Content-Type's charset wins over the page's <meta>", async () => {
  const body = await read(page('<meta charset="iso-8859-1">', Buffer.from(LATIN1, "utf8")), "text/html; charset=utf-8");
  assert.ok(body.includes(LATIN1), body);
});

test("a Content-Type charset no encoding goes by is passed over for the page's <meta>; an unknown <meta> label reads as UTF-8", async () => {
  assert.ok((await read(page('<meta charset="iso-8859-1">', Buffer.from(LATIN1, "latin1")), "text/html; charset=no-such-charset")).includes(LATIN1));
  assert.ok((await read(page('<meta charset="no-such-charset">', Buffer.from(LATIN1, "utf8")), "text/html")).includes(LATIN1));
});

test("a <meta> past the first 1024 bytes is not read: the page reads as UTF-8", async () => {
  const late = page(`<!--${"x".repeat(1100)}--><meta charset="shift_jis">`, Buffer.from(LATIN1, "utf8"));
  assert.ok((await read(late, "text/html")).includes(LATIN1));
});

test("a plain-text page's <meta>-like words are never read as its charset", async () => {
  const text = Buffer.concat([Buffer.from('<meta charset="shift_jis"> ', "latin1"), Buffer.from(LATIN1, "utf8")]);
  assert.ok((await read(text, "text/plain")).includes(LATIN1));
});

test("a <meta> naming UTF-16 reads as UTF-8, as a browser reads it", async () => {
  assert.ok((await read(page('<meta charset="utf-16">', Buffer.from(LATIN1, "utf8")), "text/html")).includes(LATIN1));
});

test("a <meta> inside a comment is not read: the next one is", async () => {
  const commented = page('<!-- <meta charset="utf-8"> --><meta charset="iso-8859-1">', Buffer.from(LATIN1, "latin1"));
  assert.ok((await read(commented, "text/html")).includes(LATIN1));
  const only = page('<!-- <meta charset="shift_jis"> -->', Buffer.from(LATIN1, "utf8"));
  assert.ok((await read(only, "text/html")).includes(LATIN1), "a commented charset alone leaves UTF-8");
});

test("a <meta> whose label no encoding goes by is passed over for the next <meta>", async () => {
  const body = await read(page('<meta charset="no-such-charset"><meta charset="shift_jis">', SJIS), "text/html");
  assert.ok(body.includes("こんにちは"), body);
});

test("a byte order mark wins over a declared charset, and is not kept in the text", async () => {
  const marked = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), page('<meta charset="iso-8859-1">', Buffer.from(LATIN1, "utf8"))]);
  const body = await read(marked, "text/html; charset=iso-8859-1");
  assert.ok(body.includes(LATIN1), body);
  assert.ok(!body.startsWith("\uFEFF") && body.startsWith("<html>"), "the mark is dropped");
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`<p>${LATIN1}</p>`, "utf16le")]);
  assert.ok((await read(utf16, "text/html; charset=utf-8")).includes(LATIN1), "a UTF-16LE mark");
});
