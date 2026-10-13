// The live scripts print the tails of server logs when a take fails; a run link's fragment is the run's secret and must never be in them, whatever characters the run id has.
import assert from "node:assert/strict";
import { test } from "node:test";
import { redact } from "../../redact-link.ts";

const SECRET = "Zx9fixturesecretTOKEN-0123456789_abcdef";

test("a run link's fragment is redacted for any run id, dotted ones included", () => {
  for (const id of ["walks-home", "walks-home.rehearsal", "a.b.c", "run~1", "r+2", "Ünï"]) {
    const out = redact(`LIVE: open http://127.0.0.1:8763/run/${id}#${SECRET} then more`);
    assert.ok(!out.includes(SECRET), `the secret is gone for ${id}: ${out}`);
    assert.match(out, new RegExp(`/run/${id.replace(/[.+~]/g, "\\$&")}#<redacted> then more`), `the rest of the line is kept for ${id}`);
  }
});

test("the link inside quotes, JSON or angle brackets is redacted up to the closing character, and a bearer token is redacted", () => {
  assert.equal(redact(`{"link":"http://h/run/x.y#${SECRET}","n":1}`), `{"link":"http://h/run/x.y#<redacted>","n":1}`);
  assert.equal(redact(`see <http://h/run/x.y#${SECRET}> now`), `see <http://h/run/x.y#<redacted>> now`);
  assert.equal(redact("Authorization: Bearer abc.def-ghi"), "Authorization: Bearer <redacted>");
});

test("text without a link is unchanged", () => {
  assert.equal(redact("ready: 3 of 3 GPU boxes #3"), "ready: 3 of 3 GPU boxes #3");
});
