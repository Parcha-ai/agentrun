// The LibreOffice provider against a real LibreOffice, when the environment has one. It skips, with the reason, where
// there is none: the binaries job does not install LibreOffice, so this suite is for a machine that has it.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { detectOnce } from "@parcha/pi-vision";
import { sofficeProvider } from "@parcha/pi-vision/providers/soffice";
import { pngBytes } from "@parcha/pi-vision/testing";
import { strToU8, zipSync } from "fflate";
import { docx, para, workspace } from "../office-fixtures.mjs";

const provider = sofficeProvider();

test("LibreOffice renders a word document to a PDF that begins as one", async (t) => {
  const w = await workspace(t);
  const found = await detectOnce(provider, w.env);
  if (!found.available) return t.skip(`${found.needs}: ${found.reason}`);
  const out = await provider.office(await w.source("letter.docx", docx(para("A letter from an invented office."))), {}, w.call());
  assert.equal(out.madeBy.provider, "soffice");
  assert.equal(readFileSync(out.path).subarray(0, 5).toString("latin1"), "%PDF-");
});

const ODF_NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" office:version="1.2"';
/** A text document whose one picture is a link to `url`, not a picture inside the file. */
const linkedPicture = (url) => zipSync({
  mimetype: [strToU8("application/vnd.oasis.opendocument.text"), { level: 0 }],
  "content.xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?><office:document-content ${ODF_NS}><office:body><office:text><text:p>before<draw:frame draw:name="pic" text:anchor-type="as-char" svg:width="2cm" svg:height="2cm"><draw:image xlink:href="${url}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/></draw:frame>after</text:p></office:text></office:body></office:document-content>`),
  "META-INF/manifest.xml": strToU8('<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>'),
});

test("a picture the document links at a web address is not fetched by the conversion", async (t) => {
  const w = await workspace(t);
  const found = await detectOnce(provider, w.env);
  if (!found.available) return t.skip(`${found.needs}: ${found.reason}`);
  let requests = 0;
  const server = createServer((_, res) => { requests++; res.writeHead(200, { "content-type": "image/png" }).end(pngBytes(2, 2)); });
  await new Promise((listening) => server.listen(0, "127.0.0.1", listening));
  t.after(() => server.close());
  const bytes = linkedPicture(`http://127.0.0.1:${server.address().port}/pic.png`);
  // The control: the same document through a profile of its own that holds no settings. Without it, zero would mean nothing.
  const path = await w.dir.file("control.odt", bytes);
  await promisify(execFile)("soffice", ["--headless", "--norestore", "--nolockcheck", "--nodefault", "--nologo", `-env:UserInstallation=file://${join(w.dir.path, "control-profile")}`, "--convert-to", "pdf", "--outdir", join(w.dir.path, "control-out"), path], { timeout: 120_000 });
  if (requests === 0) return t.skip("this LibreOffice does not fetch a linked picture unless it is told not to, so there is nothing to hold back");
  requests = 0;
  const out = await provider.office(await w.source("linked.odt", bytes), {}, w.call());
  assert.equal(readFileSync(out.path).subarray(0, 5).toString("latin1"), "%PDF-");
  assert.equal(requests, 0, "the address was never requested");
});
