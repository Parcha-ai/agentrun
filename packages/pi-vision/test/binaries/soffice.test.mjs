// The LibreOffice provider against a real LibreOffice, when the environment has one. It skips, with the reason, where
// there is none: the binaries job does not install LibreOffice, so this suite is for a machine that has it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { detectOnce } from "@parcha/pi-vision";
import { sofficeProvider } from "@parcha/pi-vision/providers/soffice";
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
